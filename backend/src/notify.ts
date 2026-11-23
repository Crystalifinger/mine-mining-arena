import { cfg } from './config.js';

async function send(chatId: string | number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    /* notifications are best-effort */
  }
}
export const notifyUser = (tgId: number | string, text: string) => void send(tgId, text);
export const notifyAdmin = (text: string) => { if (cfg.ADMIN_CHAT_ID) void send(cfg.ADMIN_CHAT_ID, text); };
