import { cfg, U } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { lockBalances, transfer } from '../ledger.js';
import { formatUnits } from '../units.js';
import { notifyUser } from '../notify.js';

export async function listListings(sort: 'price' | 'hash' | 'value') {
  const order = sort === 'hash' ? 'mt.hash_gh DESC' : sort === 'value' ? 'l.price::numeric / mt.hash_gh ASC' : 'l.price ASC';
  const r = await pool.query(
    `SELECT l.id, l.price, l.seller_id, l.created_at, um.type_id, mt.name, mt.hash_gh, mt.bonus_gh, mt.tier, u.username
       FROM listings l JOIN user_miners um ON um.id = l.miner_id JOIN miner_types mt ON mt.id = um.type_id
       JOIN users u ON u.id = l.seller_id
      WHERE l.status = 'active' ORDER BY ${order}, l.id LIMIT 100`,
  );
  return r.rows.map(l => ({
    id: Number(l.id), type: l.type_id, name: l.name, hash: l.hash_gh, bonus: l.bonus_gh, tier: l.tier,
    price: formatUnits(BigInt(l.price)), pricePerGh: Number(BigInt(l.price)) / 1e9 / l.hash_gh,
    seller: l.username ? '@' + l.username : 'player', sellerId: Number(l.seller_id), createdAt: l.created_at,
  }));
}

export async function createListing(userId: number, minerId: number, price: bigint) {
  if (price < U.marketMin || price > U.marketMax) throw new HttpError(400, 'price_out_of_range');
  return tx(async c => {
    const m = (await c.query(
      `SELECT um.id, um.listed, mt.tradable FROM user_miners um JOIN miner_types mt ON mt.id = um.type_id
        WHERE um.id=$1 AND um.user_id=$2 FOR UPDATE OF um`, [minerId, userId])).rows[0];
    if (!m) throw new HttpError(404, 'miner_not_found');
    if (!m.tradable) throw new HttpError(400, 'miner_not_tradable');
    if (m.listed) throw new HttpError(409, 'already_listed');
    const n = Number((await c.query(`SELECT count(*) AS n FROM listings WHERE seller_id=$1 AND status='active'`, [userId])).rows[0].n);
    if (n >= cfg.MARKET_MAX_LISTINGS) throw new HttpError(400, 'too_many_listings');
    await c.query('UPDATE user_miners SET slot=NULL, listed=TRUE WHERE id=$1', [minerId]); // miner is held in escrow
    const r = await c.query('INSERT INTO listings (miner_id, seller_id, price) VALUES ($1,$2,$3) RETURNING id', [minerId, userId, price.toString()]);
    return { listingId: Number(r.rows[0].id) };
  });
}

export async function cancelListing(userId: number, listingId: number) {
  return tx(async c => {
    const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [listingId])).rows[0];
    if (!l || Number(l.seller_id) !== userId) throw new HttpError(404, 'listing_not_found');
    if (l.status !== 'active') throw new HttpError(409, 'listing_closed');
    await c.query(`UPDATE listings SET status='cancelled', closed_at=now() WHERE id=$1`, [listingId]);
    await c.query('UPDATE user_miners SET listed=FALSE WHERE id=$1', [l.miner_id]);
    return { ok: true };
  });
}

export async function buyListing(buyerId: number, listingId: number) {
  const res = await tx(async c => {
    const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [listingId])).rows[0];
    if (!l) throw new HttpError(404, 'listing_not_found');
    if (l.status !== 'active') throw new HttpError(409, 'listing_closed');
    const sellerId = Number(l.seller_id);
    if (sellerId === buyerId) throw new HttpError(400, 'cannot_buy_own_listing');
    const count = Number((await c.query('SELECT count(*) AS n FROM user_miners WHERE user_id=$1', [buyerId])).rows[0].n);
    if (count >= cfg.MAX_MINERS_PER_USER) throw new HttpError(400, 'miner_limit_reached');

    const price = BigInt(l.price);
    const fee = (price * BigInt(cfg.MARKET_FEE_BPS)) / 10000n;
    const burn = (fee * BigInt(Math.round(cfg.MARKET_FEE_BURN_PCT * 100))) / 10000n;
    const ref = `listing:${listingId}`;
    await lockBalances(c, [{ user: buyerId }, { user: sellerId }, { sys: 'treasury' }, { sys: 'burn' }], 'MINE');
    await transfer(c, { from: { user: buyerId }, to: { user: sellerId }, asset: 'MINE', amount: price - fee, kind: 'market_sale', ref });
    if (burn > 0n) await transfer(c, { from: { user: buyerId }, to: { sys: 'burn' }, asset: 'MINE', amount: burn, kind: 'market_fee_burn', ref });
    if (fee - burn > 0n) await transfer(c, { from: { user: buyerId }, to: { sys: 'treasury' }, asset: 'MINE', amount: fee - burn, kind: 'market_fee', ref });

    await c.query('UPDATE user_miners SET user_id=$1, listed=FALSE, slot=NULL WHERE id=$2', [buyerId, l.miner_id]);
    await c.query(`UPDATE listings SET status='sold', buyer_id=$2, fee=$3, closed_at=now() WHERE id=$1`, [listingId, buyerId, fee.toString()]);
    const seller = (await c.query('SELECT tg_id FROM users WHERE id=$1', [sellerId])).rows[0];
    return { sellerTg: seller.tg_id as string, got: price - fee };
  });
  notifyUser(res.sellerTg, `Your miner sold. You received ${formatUnits(res.got)} MINE.`);
  return { ok: true };
}
