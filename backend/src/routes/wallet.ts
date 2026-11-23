import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseUnits } from '../units.js';
import { HttpError } from '../errors.js';
import { history, walletInfo } from '../services/me.js';
import { listWithdrawals, requestWithdraw, withdrawLimits } from '../services/withdraw.js';

export async function walletRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/wallet', async req => ({
    ...(await walletInfo(req.user.uid)),
    withdraw: await withdrawLimits(req.user.uid),
  }));
  app.get('/wallet/history', async req => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return history(req.user.uid, q.limit);
  });

  app.post('/withdraw', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const b = z.object({ amount: z.string(), address: z.string().min(40).max(80) }).parse(req.body);
    let amount: bigint;
    try { amount = parseUnits(b.amount); } catch { throw new HttpError(400, 'bad_amount'); }
    return requestWithdraw(req.user.uid, amount, b.address);
  });
  app.get('/withdrawals', async req => listWithdrawals(req.user.uid));
}
