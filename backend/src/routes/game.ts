import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseUnits } from '../units.js';
import { HttpError } from '../errors.js';
import { getState, getMe } from '../services/me.js';
import { place, remove, storeCatalog, recycleEventMiner, minerBurnHistory } from '../services/miners.js';
import { buyMiner } from '../services/store.js';
import { buyListing, cancelListing, createListing, listListings } from '../services/market.js';
import { claim, getNetwork } from '../services/mining.js';
import { userTaskConfig } from '../services/tasks.js';
import { cfg, U } from '../config.js';
import { SLOTS } from '../economy.js';
import { formatUnits } from '../units.js';

const amount = z.string().transform(s => {
  try { return parseUnits(s); } catch { throw new HttpError(400, 'bad_amount'); }
});

export async function gameRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/config', async () => ({ slots: SLOTS, marketFeeBps: cfg.MARKET_FEE_BPS, claimMin: formatUnits(U.claimMin), blockSeconds: cfg.BLOCK_SECONDS, userTask: await userTaskConfig() }));
  app.get('/me', async req => getMe(req.user.uid));
  app.get('/state', async req => getState(req.user.uid));
  app.get('/network', async req => getNetwork(req.user.uid));

  app.post('/rack/place', async req => {
    const b = z.object({ minerId: z.number().int().positive(), slot: z.number().int() }).parse(req.body);
    return place(req.user.uid, b.minerId, b.slot);
  });
  app.post('/rack/remove', async req => {
    const b = z.object({ minerId: z.number().int().positive() }).parse(req.body);
    return remove(req.user.uid, b.minerId);
  });

  app.post('/claim', async req => claim(req.user.uid));
  app.get('/miners/burns', async req => minerBurnHistory(req.user.uid));
  app.post('/miners/recycle', async req => {
    const b = z.object({ minerId: z.number().int().positive() }).parse(req.body);
    return recycleEventMiner(req.user.uid, b.minerId);
  });

  app.get('/store', async () => storeCatalog());
  app.post('/store/buy', async req => {
    const b = z.object({ typeId: z.string().min(1).max(32), currency: z.enum(['TON', 'MINE']) }).parse(req.body);
    return buyMiner(req.user.uid, b.typeId, b.currency);
  });

  app.get('/market', async req => {
    const q = z.object({ sort: z.enum(['price', 'hash', 'value']).default('price') }).parse(req.query);
    return listListings(q.sort);
  });
  app.post('/market/list', async req => {
    const b = z.object({ minerId: z.number().int().positive(), price: amount }).parse(req.body);
    return createListing(req.user.uid, b.minerId, b.price);
  });
  app.post('/market/cancel', async req => {
    const b = z.object({ listingId: z.number().int().positive() }).parse(req.body);
    return cancelListing(req.user.uid, b.listingId);
  });
  app.post('/market/buy', async req => {
    const b = z.object({ listingId: z.number().int().positive() }).parse(req.body);
    return buyListing(req.user.uid, b.listingId);
  });
}
