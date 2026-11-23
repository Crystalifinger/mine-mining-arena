import { U } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { transfer, type Asset } from '../ledger.js';
import { formatUnits } from '../units.js';
import { notifyUser } from '../notify.js';

export async function getCursor(name: string): Promise<bigint> {
  const r = await pool.query('SELECT lt FROM chain_cursors WHERE name=$1', [name]);
  return BigInt(r.rows[0]?.lt ?? 0);
}
export async function setCursor(name: string, lt: bigint): Promise<void> {
  await pool.query(
    'INSERT INTO chain_cursors (name, lt) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET lt = GREATEST(chain_cursors.lt, EXCLUDED.lt)',
    [name, lt.toString()],
  );
}

/** Idempotent: the same chain_ref is never credited twice. */
export async function recordDeposit(o: { asset: Asset; amount: bigint; ref: string; source?: string | null; memo?: string | null }) {
  const res = await tx(async c => {
    let userId: number | null = null;
    let tgId: string | null = null;
    if (o.memo) {
      const u = (await c.query('SELECT id, tg_id FROM users WHERE memo=$1 AND NOT banned', [o.memo.trim()])).rows[0];
      if (u) { userId = Number(u.id); tgId = u.tg_id; }
    }
    const min = o.asset === 'TON' ? U.depositMinTon : U.depositMinMine;
    const status = !userId ? 'unmatched' : o.amount < min ? 'below_min' : 'credited';
    const ins = await c.query(
      `INSERT INTO deposits (chain_ref, asset, amount, source, memo, user_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (chain_ref) DO NOTHING RETURNING id`,
      [o.ref, o.asset, o.amount.toString(), o.source ?? null, o.memo ?? null, userId, status],
    );
    if (!ins.rows[0]) return null; // seen before
    if (status === 'credited') {
      await transfer(c, { from: { sys: 'chain_in' }, to: { user: userId! }, asset: o.asset, amount: o.amount, kind: 'deposit', ref: o.ref });
    }
    return { status, tgId };
  });
  if (res?.status === 'credited' && res.tgId) notifyUser(res.tgId, `Deposit received: ${formatUnits(o.amount)} ${o.asset}.`);
  return res;
}

/** Admin: credit an unmatched / below-minimum deposit to a user by hand. */
export async function assignDeposit(depositId: number, userId: number) {
  return tx(async c => {
    const d = (await c.query('SELECT * FROM deposits WHERE id=$1 FOR UPDATE', [depositId])).rows[0];
    if (!d) throw new HttpError(404, 'deposit_not_found');
    if (d.status === 'credited') throw new HttpError(409, 'already_credited');
    const u = (await c.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
    if (!u) throw new HttpError(404, 'user_not_found');
    await transfer(c, { from: { sys: 'chain_in' }, to: { user: userId }, asset: d.asset, amount: BigInt(d.amount), kind: 'deposit', ref: `assign:${d.chain_ref}` });
    await c.query(`UPDATE deposits SET status='credited', user_id=$2 WHERE id=$1`, [depositId, userId]);
    return { ok: true };
  });
}
