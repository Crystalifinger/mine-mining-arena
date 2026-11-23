import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { cfg } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { gameRoutes } from './routes/game.js';
import { walletRoutes } from './routes/wallet.js';
import { taskRoutes } from './routes/tasks.js';
import { adminRoutes } from './routes/admin.js';

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { uid: number }; user: { uid: number } }
}
declare module 'fastify' {
  interface FastifyInstance { authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
}

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 64 * 1024 });

await app.register(cors, { origin: cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(',') });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(jwt, { secret: cfg.JWT_SECRET, sign: { expiresIn: '12h' } });

app.decorate('authenticate', async (req: FastifyRequest) => {
  await req.jwtVerify();
  const r = await pool.query('SELECT banned FROM users WHERE id=$1', [req.user.uid]);
  if (!r.rows[0] || r.rows[0].banned) throw new HttpError(403, 'banned');
});

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, ...err.extra });
  if (err instanceof ZodError) return reply.status(400).send({ error: 'bad_request', details: err.flatten() });
  if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? err.message });
  req.log.error(err);
  return reply.status(500).send({ error: 'internal' });
});

app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
await app.register(authRoutes);
await app.register(gameRoutes);
await app.register(walletRoutes);
await app.register(taskRoutes);
await app.register(adminRoutes, { prefix: '/admin' });

await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
