import { cfg } from '../config.js';
import { pool, tx } from '../db.js';
import { toChain } from '../units.js';
import { jettonTransfers } from '../ton/toncenter.js';
import { sameAddress } from '../ton/payload.js';
import { hotJettonBalance } from '../ton/chain.js';
import { sendJetton } from '../ton/sender.js';
import { getCursor, setCursor } from '../services/deposits.js';
import { finalizeConfirmed, refundHold } from '../services/withdraw.js';
import { notifyAdmin } from '../notify.js';

/** Sends approved withdrawals one at a time. A request is marked 'sending' BEFORE broadcast and is never auto-retried. */
export async function sendApproved(): Promise<void> {
  for (;;) {
    const balance = await hotJettonBalance();
    const w = await tx(async c => {
      const r = await c.query(`SELECT * FROM withdrawals WHERE status='approved' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = r.rows[0];
      if (!row) return null;
      if (toChain(BigInt(row.amount), cfg.MINE_DECIMALS) > balance) return 'low' as const; // not enough MINE in the hot wallet
      await c.query(`UPDATE withdrawals SET status='sending', sent_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
      return row;
    });
    if (!w) return;
    if (w === 'low') { notifyAdmin('Hot wallet MINE balance is too low for the next withdrawal. Top it up.'); return; }
    try {
      await sendJetton({ to: w.address, rawAmount: toChain(BigInt(w.amount), cfg.MINE_DECIMALS), queryId: BigInt(w.id) });
      await pool.query(`UPDATE withdrawals SET status='sent', updated_at=now() WHERE id=$1 AND status='sending'`, [w.id]);
    } catch (e) {
      console.error('send failed for withdrawal', w.id, e);
      notifyAdmin(`Withdrawal #${w.id} broadcast is uncertain. It stays in 'sending' until reconciled. Check the chain before doing anything.`);
      return; // stop; ambiguous state must be reviewed, never blindly retried
    }
  }
}

async function settle(id: number, aborted: boolean, txHash: string) {
  await tx(async c => {
    if (aborted) await refundHold(c, id, ['sending', 'sent', 'needs_review'], 'failed', 'transfer aborted on-chain');
    else await finalizeConfirmed(c, id, txHash);
  });
}

/** Matches on-chain outgoing jetton transfers to withdrawals by query_id, then flags stale ones for review. */
export async function reconcile(): Promise<void> {
  const cur = await getCursor('jetton_out');
  let last = cur;
  for (let offset = 0; ; offset += 100) {
    const rows = await jettonTransfers({ owner: cfg.HOT_WALLET_ADDRESS, direction: 'out', startLt: cur, offset, limit: 100 });
    for (const t of rows) {
      const lt = BigInt(t.transaction_lt);
      if (lt > last) last = lt;
      const id = Number(t.query_id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const w = (await pool.query(`SELECT address, amount FROM withdrawals WHERE id=$1 AND status IN ('sending','sent','needs_review')`, [id])).rows[0];
      if (!w) continue;
      const okDest = sameAddress(t.destination, w.address);
      const okAmt = BigInt(t.amount) === toChain(BigInt(w.amount), cfg.MINE_DECIMALS);
      if (!okDest || !okAmt) { notifyAdmin(`Withdrawal #${id}: on-chain transfer does not match (destination or amount). Review manually.`); continue; }
      await settle(id, t.transaction_aborted, t.transaction_hash);
    }
    if (rows.length < 100) break;
  }
  if (last > cur) await setCursor('jetton_out', last);

  const stale = await pool.query(
    `UPDATE withdrawals SET status='needs_review', updated_at=now()
      WHERE status IN ('sending','sent') AND sent_at < now() - interval '15 minutes' RETURNING id`);
  for (const r of stale.rows) notifyAdmin(`Withdrawal #${r.id} was not seen on-chain after 15 minutes (needs_review).`);
}

/** Admin tool: look for a specific withdrawal on-chain, around the time it was sent. */
export async function recheckWithdrawal(id: number): Promise<{ found: boolean; txHash?: string; aborted?: boolean }> {
  const w = (await pool.query('SELECT sent_at, created_at FROM withdrawals WHERE id=$1', [id])).rows[0];
  if (!w) return { found: false };
  const since = Math.floor(new Date(w.sent_at ?? w.created_at).getTime() / 1000) - 300;
  for (let offset = 0; ; offset += 100) {
    const rows = await jettonTransfers({ owner: cfg.HOT_WALLET_ADDRESS, direction: 'out', startUtime: since, offset, limit: 100 });
    const hit = rows.find(t => Number(t.query_id) === id);
    if (hit) {
      await settle(id, hit.transaction_aborted, hit.transaction_hash);
      return { found: true, txHash: hit.transaction_hash, aborted: hit.transaction_aborted };
    }
    if (rows.length < 100) return { found: false };
  }
}
