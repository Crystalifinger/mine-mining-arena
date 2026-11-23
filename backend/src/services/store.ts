import { cfg } from '../config.js';
import { tx } from '../db.js';
import { HttpError } from '../errors.js';
import { lockBalances, transfer, type Asset } from '../ledger.js';
import { grantMiner } from './users.js';

export async function buyMiner(userId: number, typeId: string, currency: Asset) {
  return tx(async c => {
    const t = (await c.query('SELECT * FROM miner_types WHERE id=$1 AND active FOR UPDATE', [typeId])).rows[0];
    if (!t) throw new HttpError(404, 'miner_type_not_found');
    const raw = currency === 'TON' ? t.price_ton : t.price_mine;
    if (raw === null) throw new HttpError(400, 'not_for_sale_in_this_currency');
    if (t.stock !== null && t.stock <= 0) throw new HttpError(409, 'sold_out');
    const count = Number((await c.query('SELECT count(*) AS n FROM user_miners WHERE user_id=$1', [userId])).rows[0].n);
    if (count >= cfg.MAX_MINERS_PER_USER) throw new HttpError(400, 'miner_limit_reached');

    const price = BigInt(raw);
    await lockBalances(c, [{ user: userId }, { sys: 'treasury' }, { sys: 'burn' }], currency);
    if (currency === 'TON') {
      await transfer(c, { from: { user: userId }, to: { sys: 'treasury' }, asset: 'TON', amount: price, kind: 'store_buy' });
    } else {
      const burn = (price * BigInt(Math.round(cfg.STORE_MINE_BURN_PCT * 100))) / 10000n;
      if (burn > 0n) await transfer(c, { from: { user: userId }, to: { sys: 'burn' }, asset: 'MINE', amount: burn, kind: 'store_burn' });
      if (price - burn > 0n) await transfer(c, { from: { user: userId }, to: { sys: 'treasury' }, asset: 'MINE', amount: price - burn, kind: 'store_buy' });
    }
    const minerId = await grantMiner(c, userId, typeId);
    if (t.stock !== null) await c.query('UPDATE miner_types SET stock = stock - 1 WHERE id=$1', [typeId]);
    await c.query('INSERT INTO store_orders (user_id, type_id, currency, price) VALUES ($1,$2,$3,$4)', [userId, typeId, currency, price.toString()]);
    return { minerId };
  });
}
