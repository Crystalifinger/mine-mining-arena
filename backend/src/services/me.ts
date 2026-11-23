import { cfg, U } from '../config.js';
import { pool } from '../db.js';
import { rankIndex, RANKS, SLOTS } from '../economy.js';
import { formatUnits } from '../units.js';
import { getUser } from './users.js';
import { liveHash, pendingRewards } from './mining.js';
import { listMiners } from './miners.js';

export async function balances(userId: number) {
  const r = await pool.query(
    `SELECT b.asset, b.amount FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = $1`, [userId]);
  const out: Record<string, string> = { MINE: '0', TON: '0' };
  for (const x of r.rows) out[x.asset] = formatUnits(BigInt(x.amount));
  return out;
}

export async function getMe(userId: number) {
  const [u, bal, pending, hash] = await Promise.all([getUser(userId), balances(userId), pendingRewards(userId), liveHash(userId)]);
  return {
    id: u.id, username: u.username, firstName: u.first_name,
    balances: bal, pendingRewards: formatUnits(pending), claimMin: formatUnits(U.claimMin),
    hash, rank: RANKS[rankIndex(hash)].name,
  };
}

export async function getState(userId: number) {
  const [me, miners] = await Promise.all([getMe(userId), listMiners(userId)]);
  return { me, miners, slots: SLOTS };
}

export async function walletInfo(userId: number) {
  const u = await getUser(userId);
  return {
    balances: await balances(userId),
    deposit: {
      address: cfg.HOT_WALLET_ADDRESS,
      memo: u.memo,
      jettonMaster: cfg.MINE_JETTON_MASTER,
      minTon: formatUnits(U.depositMinTon),
      minMine: formatUnits(U.depositMinMine),
      note: 'Send TON with the memo as the transfer comment. For MINE, send the jetton to the same address and put the memo in the comment. Deposits without the memo cannot be matched automatically.',
    },
  };
}

export async function history(userId: number, limit = 50) {
  const r = await pool.query(
    `SELECT l.kind, l.asset, l.amount, l.created_at FROM ledger l JOIN accounts a ON a.id = l.account_id
      WHERE a.user_id = $1 ORDER BY l.id DESC LIMIT $2`, [userId, Math.min(limit, 200)]);
  return r.rows.map(x => ({ kind: x.kind, asset: x.asset, amount: formatUnits(BigInt(x.amount)), createdAt: x.created_at }));
}
