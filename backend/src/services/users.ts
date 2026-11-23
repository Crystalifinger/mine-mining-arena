import { randomBytes } from 'node:crypto';
import { tx, pool, type Client } from '../db.js';
import { HttpError } from '../errors.js';
import { ensureUserAccount } from '../ledger.js';
import type { TgUser } from '../telegram.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function genMemo(): string {
  const b = randomBytes(10);
  return 'AM' + [...b].map(x => ALPHABET[x % ALPHABET.length]).join('');
}

export async function grantMiner(c: Client, userId: number, typeId: string, slot: number | null = null) {
  const r = await c.query('INSERT INTO user_miners (user_id, type_id, slot) VALUES ($1,$2,$3) RETURNING id', [userId, typeId, slot]);
  return Number(r.rows[0].id);
}

export async function loginTelegram(tg: TgUser, startParam?: string) {
  return tx(async c => {
    let ref: number | null = null;
    const m = /^ref_(\d+)$/.exec(startParam ?? '');
    if (m && m[1] !== String(tg.id)) {
      const r = await c.query('SELECT id FROM users WHERE tg_id=$1', [m[1]]);
      if (r.rows[0]) ref = Number(r.rows[0].id);
    }
    const r = await c.query(
      `INSERT INTO users (tg_id, username, first_name, memo, ref_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
       RETURNING id, banned, (xmax = 0) AS inserted`,
      [tg.id, tg.username ?? null, tg.first_name ?? null, genMemo(), ref],
    );
    const u = r.rows[0];
    if (u.banned) throw new HttpError(403, 'banned');
    const id = Number(u.id);
    if (u.inserted) {
      await ensureUserAccount(c, id);
      await grantMiner(c, id, 'spark', 0); // free starter miner, not tradable
    }
    return { id, isNew: Boolean(u.inserted) };
  });
}

export async function getUser(userId: number) {
  const r = await pool.query('SELECT id, tg_id, username, first_name, memo, block_hash, created_at FROM users WHERE id=$1', [userId]);
  if (!r.rows[0]) throw new HttpError(404, 'user_not_found');
  return r.rows[0];
}
