import crypto from 'node:crypto';

export type TgUser = { id: number; first_name?: string; username?: string; language_code?: string };

/** Validates Telegram Mini App initData (HMAC-SHA256 with the bot token). */
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest();
  let given: Buffer;
  try { given = Buffer.from(hash, 'hex'); } catch { return null; }
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  const raw = params.get('user');
  if (!raw) return null;
  try {
    return { user: JSON.parse(raw) as TgUser, startParam: params.get('start_param') || undefined };
  } catch {
    return null;
  }
}
