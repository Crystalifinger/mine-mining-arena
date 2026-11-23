// Minimal Telegram bot (long polling): /start opens the Mini App.
import { cfg } from './config.js';

const api = (m: string, body: object) =>
  fetch(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json() as Promise<any>);

let offset = 0;
console.log('bot started');
for (;;) {
  try {
    const res = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of res.result ?? []) {
      offset = u.update_id + 1;
      const text: string = u.message?.text ?? '';
      const chat = u.message?.chat?.id;
      if (!chat || !text.startsWith('/start')) continue;
      const ref = text.split(' ')[1];
      const url = cfg.WEBAPP_URL + (ref ? `?tgWebAppStartParam=${encodeURIComponent(ref)}` : '');
      await api('sendMessage', {
        chat_id: chat,
        text: 'Welcome to Arena Mining. Build your rack, mine MINE, trade miners.',
        reply_markup: { inline_keyboard: [[{ text: 'Open Arena Mining', web_app: { url } }]] },
      });
    }
  } catch (e) {
    console.error('bot error', e);
    await new Promise(r => setTimeout(r, 5000));
  }
}
