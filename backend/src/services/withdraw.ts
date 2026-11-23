import { Address } from '@ton/core';
import { cfg, U } from '../config.js';
import { pool, tx, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { RANKS, rankIndex } from '../economy.js';
import { transfer } from '../ledger.js';
import { formatUnits, toChain } from '../units.js';
import { notifyAdmin, notifyUser } from '../notify.js';

const TODAY = `(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
const COUNTED = `status NOT IN ('rejected','failed')`;

export function normalizeAddress(s: string): string {
  let a: Address;
  try { a = Address.parse(s.trim()); } catch { throw new HttpError(400, 'bad_address'); }
  if (a.workChain !== 0) throw new HttpError(400, 'bad_address');
  if (a.equals(Address.parse(cfg.HOT_WALLET_ADDRESS))) throw new HttpError(400, 'bad_address');
  return a.toString({ bounceable: false, testOnly: cfg.TON_NETWORK === 'testnet', urlSafe: true });
}

export async function withdrawLimits(userId: number) {
  const u = (await pool.query('SELECT block_hash, created_at FROM users WHERE id=$1', [userId])).rows[0];
  const ri = rankIndex(Number(u.block_hash)); // rank from the last block snapshot, not from the live rack
  const used = BigInt((await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id=$1 AND ${COUNTED} AND created_at >= ${TODAY}`, [userId])).rows[0].s);
  const cap = RANKS[ri].cap;
  const eligibleAt = new Date(new Date(u.created_at).getTime() + cfg.WITHDRAW_MIN_ACCOUNT_AGE_HOURS * 3600_000);
  return {
    rank: RANKS[ri].name, dailyCap: formatUnits(cap), usedToday: formatUnits(used),
    remainingToday: formatUnits(cap > used ? cap - used : 0n),
    min: formatUnits(U.withdrawMin), fee: formatUnits(U.withdrawFee), autoLimit: formatUnits(U.withdrawAuto),
    eligibleAt, eligible: eligibleAt.getTime() <= Date.now(),
  };
}

export async function requestWithdraw(userId: number, amount: bigint, addressInput: string) {
  const address = normalizeAddress(addressInput);
  if (amount < U.withdrawMin) throw new HttpError(400, 'below_minimum', { min: formatUnits(U.withdrawMin) });
  try { toChain(amount, cfg.MINE_DECIMALS); } catch { throw new HttpError(400, 'bad_amount'); }

  const out = await tx(async c => {
    const u = (await c.query('SELECT id, tg_id, banned, block_hash, created_at FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!u || u.banned) throw new HttpError(403, 'banned');
    const ageMs = Date.now() - new Date(u.created_at).getTime();
    if (ageMs < cfg.WITHDRAW_MIN_ACCOUNT_AGE_HOURS * 3600_000) throw new HttpError(403, 'account_too_new');

    const cap = RANKS[rankIndex(Number(u.block_hash))].cap;
    const used = BigInt((await c.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id=$1 AND ${COUNTED} AND created_at >= ${TODAY}`, [userId])).rows[0].s);
    if (used + amount > cap) throw new HttpError(400, 'daily_limit', { remaining: formatUnits(cap > used ? cap - used : 0n) });

    const global = BigInt((await c.query(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE ${COUNTED} AND created_at >= ${TODAY}`)).rows[0].s);
    const auto = amount <= U.withdrawAuto && global + amount <= U.withdrawGlobalCap;
    const status = auto ? 'approved' : 'pending_review';

    const w = (await c.query(
      `INSERT INTO withdrawals (user_id, address, amount, fee, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, address, amount.toString(), U.withdrawFee.toString(), status],
    )).rows[0];
    // funds are locked immediately, so the user cannot spend them elsewhere while the request is open
    await transfer(c, { from: { user: userId }, to: { sys: 'withdraw_hold' }, asset: 'MINE', amount: amount + U.withdrawFee, kind: 'withdraw_hold', ref: `withdrawal:${w.id}` });
    return { id: Number(w.id), status, tgId: u.tg_id as string };
  });
  if (out.status === 'pending_review') notifyAdmin(`Withdrawal #${out.id} needs review: ${formatUnits(amount)} MINE to ${address}`);
  return { id: out.id, status: out.status };
}

export async function listWithdrawals(userId: number) {
  const r = await pool.query(
    'SELECT id, address, amount, fee, status, reason, tx_hash, created_at FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [userId]);
  return r.rows.map(w => ({ id: Number(w.id), address: w.address, amount: formatUnits(BigInt(w.amount)), fee: formatUnits(BigInt(w.fee)),
    status: w.status, reason: w.reason, txHash: w.tx_hash, createdAt: w.created_at }));
}

/* ---------- state transitions (used by admin routes and the worker) ---------- */

export async function refundHold(c: Client, id: number, from: string[], status: 'rejected' | 'failed', reason: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE withdrawals SET status=$2, reason=$3, updated_at=now() WHERE id=$1 AND status = ANY($4::text[]) RETURNING user_id, amount, fee`,
    [id, status, reason, from],
  );
  if (!r.rows[0]) return false;
  const w = r.rows[0];
  await transfer(c, { from: { sys: 'withdraw_hold' }, to: { user: Number(w.user_id) }, asset: 'MINE', amount: BigInt(w.amount) + BigInt(w.fee), kind: 'withdraw_refund', ref: `withdrawal:${id}` });
  return true;
}

export async function finalizeConfirmed(c: Client, id: number, txHash: string | null): Promise<boolean> {
  const r = await c.query(
    `UPDATE withdrawals SET status='confirmed', tx_hash=$2, confirmed_at=now(), updated_at=now()
      WHERE id=$1 AND status IN ('sending','sent','needs_review') RETURNING user_id, amount, fee`,
    [id, txHash],
  );
  if (!r.rows[0]) return false;
  const w = r.rows[0];
  await transfer(c, { from: { sys: 'withdraw_hold' }, to: { sys: 'chain_out' }, asset: 'MINE', amount: BigInt(w.amount), kind: 'withdraw_out', ref: `withdrawal:${id}` });
  if (BigInt(w.fee) > 0n) {
    await transfer(c, { from: { sys: 'withdraw_hold' }, to: { sys: 'treasury' }, asset: 'MINE', amount: BigInt(w.fee), kind: 'withdraw_fee', ref: `withdrawal:${id}` });
  }
  const u = (await c.query('SELECT tg_id FROM users WHERE id=$1', [w.user_id])).rows[0];
  notifyUser(u.tg_id, `Withdrawal of ${formatUnits(BigInt(w.amount))} MINE was sent.`);
  return true;
}

async function audit(c: Client, action: string, payload: object) {
  await c.query('INSERT INTO admin_audit (action, payload) VALUES ($1,$2)', [action, JSON.stringify(payload)]);
}

export const adminApprove = (id: number) => tx(async c => {
  const r = await c.query(`UPDATE withdrawals SET status='approved', updated_at=now() WHERE id=$1 AND status='pending_review' RETURNING id`, [id]);
  if (!r.rows[0]) throw new HttpError(409, 'not_pending_review');
  await audit(c, 'withdrawal_approve', { id });
  return { ok: true };
});

export const adminReject = (id: number, reason: string) => tx(async c => {
  if (!(await refundHold(c, id, ['pending_review', 'approved'], 'rejected', reason))) throw new HttpError(409, 'cannot_reject');
  await audit(c, 'withdrawal_reject', { id, reason });
  return { ok: true };
});

/** needs_review -> approved. Only do this after checking on-chain that NOTHING was sent for this id. */
export const adminRequeue = (id: number) => tx(async c => {
  const r = await c.query(`UPDATE withdrawals SET status='approved', sent_at=NULL, updated_at=now() WHERE id=$1 AND status='needs_review' RETURNING id`, [id]);
  if (!r.rows[0]) throw new HttpError(409, 'not_needs_review');
  await audit(c, 'withdrawal_requeue', { id });
  return { ok: true };
});

export const adminRefundReview = (id: number, reason: string) => tx(async c => {
  if (!(await refundHold(c, id, ['needs_review'], 'failed', reason))) throw new HttpError(409, 'not_needs_review');
  await audit(c, 'withdrawal_refund', { id, reason });
  return { ok: true };
});

export const adminMarkConfirmed = (id: number, txHash: string) => tx(async c => {
  if (!(await finalizeConfirmed(c, id, txHash))) throw new HttpError(409, 'cannot_confirm');
  await audit(c, 'withdrawal_mark_confirmed', { id, txHash });
  return { ok: true };
});
