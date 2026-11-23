import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { HttpError } from '../errors.js';
import { verifyInitData } from '../telegram.js';
import { loginTelegram } from '../services/users.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/telegram', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const { initData } = z.object({ initData: z.string().min(10).max(4096) }).parse(req.body);
    const v = verifyInitData(initData, cfg.BOT_TOKEN);
    if (!v) throw new HttpError(401, 'invalid_init_data');
    const { id, isNew } = await loginTelegram(v.user, v.startParam);
    return { token: app.jwt.sign({ uid: id }), isNew };
  });

  // local testing without Telegram. Refused in production.
  if (cfg.DEV_LOGIN === 'true' && cfg.NODE_ENV !== 'production') {
    app.post('/auth/dev', async req => {
      const { tgId, username } = z.object({ tgId: z.number().int().positive(), username: z.string().optional() }).parse(req.body);
      const { id, isNew } = await loginTelegram({ id: tgId, username, first_name: username ?? 'dev' });
      return { token: app.jwt.sign({ uid: id }), isNew };
    });
  }
}
