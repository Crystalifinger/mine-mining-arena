import { randomUUID } from 'node:crypto';
import type { Client } from './db.js';
import { HttpError } from './errors.js';

export type Asset = 'MINE' | 'TON';
export type Party = { user: number } | { sys: string };

const sysCache = new Map<string, number>();

export async function accountId(c: Client, p: Party): Promise<number> {
  if ('user' in p) {
    const r = await c.query('SELECT id FROM accounts WHERE user_id=$1', [p.user]);
    if (!r.rows[0]) throw new Error(`no account for user ${p.user}`);
    return Number(r.rows[0].id);
  }
  const hit = sysCache.get(p.sys);
  if (hit) return hit;
  const r = await c.query('SELECT id FROM accounts WHERE system_name=$1', [p.sys]);
  if (!r.rows[0]) throw new Error(`no system account ${p.sys}`);
  const id = Number(r.rows[0].id);
  sysCache.set(p.sys, id);
  return id;
}

/** Lock balance rows in a stable order (prevents deadlocks between concurrent transfers). */
export async function lockBalances(c: Client, parties: Party[], asset: Asset): Promise<void> {
  const ids: number[] = [];
  for (const p of parties) ids.push(await accountId(c, p));
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  await c.query(
    'SELECT 1 FROM balances WHERE account_id = ANY($1::bigint[]) AND asset=$2 ORDER BY account_id FOR UPDATE',
    [sorted, asset],
  );
}

export async function transfer(
  c: Client,
  o: { from: Party; to: Party; asset: Asset; amount: bigint; kind: string; ref?: string },
): Promise<void> {
  if (o.amount <= 0n) throw new Error('transfer amount must be positive');
  const a = await accountId(c, o.from);
  const b = await accountId(c, o.to);
  if (a === b) throw new Error('transfer to same account');
  await lockBalances(c, [o.from, o.to], o.asset);
  try {
    await c.query('UPDATE balances SET amount = amount - $3 WHERE account_id=$1 AND asset=$2', [a, o.asset, o.amount.toString()]);
  } catch (e: any) {
    if (e?.code === '23514') throw new HttpError(402, 'insufficient_funds');
    throw e;
  }
  await c.query('UPDATE balances SET amount = amount + $3 WHERE account_id=$1 AND asset=$2', [b, o.asset, o.amount.toString()]);
  const txId = randomUUID();
  await c.query(
    `INSERT INTO ledger (tx_id, account_id, asset, amount, kind, ref) VALUES
     ($1,$2,$3,$4,$5,$6), ($1,$7,$3,$8,$5,$6)`,
    [txId, a, o.asset, (-o.amount).toString(), o.kind, o.ref ?? null, b, o.amount.toString()],
  );
}

export async function ensureUserAccount(c: Client, userId: number): Promise<void> {
  await c.query('INSERT INTO accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const id = await accountId(c, { user: userId });
  await c.query(
    `INSERT INTO balances (account_id, asset) SELECT $1, x FROM unnest(ARRAY['MINE','TON']) x ON CONFLICT DO NOTHING`,
    [id],
  );
}

export async function balanceOf(c: Client, p: Party, asset: Asset): Promise<bigint> {
  const id = await accountId(c, p);
  const r = await c.query('SELECT amount FROM balances WHERE account_id=$1 AND asset=$2', [id, asset]);
  return BigInt(r.rows[0]?.amount ?? 0);
}
