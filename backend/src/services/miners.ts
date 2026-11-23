import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { SLOTS } from '../economy.js';
import { formatUnits } from '../units.js';

export async function listMiners(userId: number) {
  const r = await pool.query(
    `SELECT um.id, um.type_id, um.slot, um.listed, mt.name, mt.hash_gh, mt.bonus_gh, mt.tier, mt.tradable, mt.is_event, mt.rarity
       FROM user_miners um JOIN miner_types mt ON mt.id = um.type_id
      WHERE um.user_id = $1 ORDER BY um.id`,
    [userId],
  );
  return r.rows.map(m => ({
    id: Number(m.id), type: m.type_id, name: m.name, hash: m.hash_gh, bonus: m.bonus_gh, tier: m.tier, rarity: m.rarity, isEvent: m.is_event,
    slot: m.slot, listed: m.listed, tradable: m.tradable,
  }));
}

export async function place(userId: number, minerId: number, slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new HttpError(400, 'bad_slot');
  return tx(async c => {
    const m = (await c.query('SELECT id, listed FROM user_miners WHERE id=$1 AND user_id=$2 FOR UPDATE', [minerId, userId])).rows[0];
    if (!m) throw new HttpError(404, 'miner_not_found');
    if (m.listed) throw new HttpError(409, 'miner_is_listed');
    try {
      await c.query('UPDATE user_miners SET slot=$1 WHERE id=$2', [slot, minerId]);
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'slot_taken');
      throw e;
    }
    return { ok: true };
  });
}

export async function remove(userId: number, minerId: number) {
  const r = await pool.query('UPDATE user_miners SET slot=NULL WHERE id=$1 AND user_id=$2 RETURNING id', [minerId, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'miner_not_found');
  return { ok: true };
}

export async function storeCatalog() {
  const r = await pool.query(
    `SELECT id, name, hash_gh, bonus_gh, tier, rarity, is_event, price_ton, price_mine, stock FROM miner_types
      WHERE active AND (price_ton IS NOT NULL OR price_mine IS NOT NULL) ORDER BY tier`,
  );
  return r.rows.map(m => ({
    id: m.id, name: m.name, hash: m.hash_gh, bonus: m.bonus_gh, tier: m.tier, rarity: m.rarity, isEvent: m.is_event,
    priceTon: m.price_ton === null ? null : formatUnits(BigInt(m.price_ton)),
    priceMine: m.price_mine === null ? null : formatUnits(BigInt(m.price_mine)),
    stock: m.stock,
  }));
}


/** Permanently recycle a non-tradable event miner for its configured reward. */
export async function recycleEventMiner(userId: number, minerId: number) {
  return tx(async c => {
    const m = (await c.query(
      `SELECT um.id, um.type_id, um.listed, mt.is_event, mt.tradable, mt.recycle_reward_mine, mt.recycle_reward_type_id
         FROM user_miners um JOIN miner_types mt ON mt.id=um.type_id
        WHERE um.id=$1 AND um.user_id=$2 FOR UPDATE OF um`, [minerId, userId])).rows[0];
    if (!m) throw new HttpError(404, 'miner_not_found');
    if (!m.is_event || m.tradable) throw new HttpError(400, 'miner_not_recyclable');
    if (m.listed) throw new HttpError(409, 'miner_is_listed');
    const rewardMine = BigInt(m.recycle_reward_mine);
    const rewardType = m.recycle_reward_type_id as string | null;
    if (rewardMine <= 0n && !rewardType) throw new HttpError(400, 'recycling_not_configured');
    await c.query(
      `INSERT INTO miner_burns (user_id, original_miner_id, type_id, reward_kind, reward_amount, reward_type_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, minerId, m.type_id, rewardMine > 0n ? 'MINE' : 'MINER', rewardMine.toString(), rewardType]);
    await c.query('DELETE FROM user_miners WHERE id=$1 AND user_id=$2', [minerId, userId]);
    if (rewardMine > 0n) {
      const { transfer } = await import('../ledger.js');
      await transfer(c, { from: { sys: 'treasury' }, to: { user: userId }, asset: 'MINE', amount: rewardMine, kind: 'miner_recycle', ref: `miner-burn:${minerId}` });
      return { ok: true, reward: { type: 'MINE', amount: formatUnits(rewardMine) } };
    }
    const created = await c.query('INSERT INTO user_miners (user_id, type_id) VALUES ($1,$2) RETURNING id', [userId, rewardType]);
    return { ok: true, reward: { type: 'MINER', minerId: Number(created.rows[0].id), typeId: rewardType } };
  });
}


export async function minerBurnHistory(userId: number) {
  const r = await pool.query(
    `SELECT id, original_miner_id, type_id, reward_kind, reward_amount, reward_type_id, burned_at
       FROM miner_burns WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [userId]);
  return r.rows.map(x => ({ id: Number(x.id), originalMinerId: Number(x.original_miner_id), type: x.type_id,
    reward: x.reward_kind === 'MINE' ? { type: 'MINE', amount: formatUnits(BigInt(x.reward_amount)) } : { type: 'MINER', typeId: x.reward_type_id }, burnedAt: x.burned_at }));
}
