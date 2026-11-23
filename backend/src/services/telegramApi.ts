import { cfg } from '../config.js';

type TgResp<T = any> = { ok: boolean; result?: T; description?: string };

export async function tgCall<T = any>(method: string, params: Record<string, string | number> = {}): Promise<TgResp<T>> {
  const url = new URL(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try { return (await (await fetch(url)).json()) as TgResp<T>; } catch { return { ok: false, description: 'network error' }; }
}

let me: { id: number; username: string } | null = null;
export async function botInfo() {
  if (me) return me;
  const r = await tgCall<{ id: number; username: string }>('getMe');
  if (r.ok && r.result) me = { id: r.result.id, username: r.result.username };
  return me;
}

/** Telegram membership status, or null if it could not be checked. */
export async function memberStatus(chatId: string, userId: number | string): Promise<string | null> {
  const r = await tgCall<{ status: string; is_member?: boolean }>('getChatMember', { chat_id: chatId, user_id: userId });
  if (!r.ok || !r.result) return null;
  const st = r.result.status;
  return st === 'restricted' ? (r.result.is_member ? 'member' : 'left') : st;
}
export const isMember = (st: string | null) => st === 'member' || st === 'administrator' || st === 'creator';
