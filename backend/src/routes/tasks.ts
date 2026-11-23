import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelUserTask, claimTask, createUserTask, listTasks, myTasks, startTask } from '../services/tasks.js';

export async function taskRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  const tid = (req: any) => z.coerce.number().int().positive().parse(req.params.id);

  app.get('/tasks', async req => listTasks(req.user.uid));
  app.get('/tasks/mine', async req => myTasks(req.user.uid));
  app.post('/tasks/create', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const b = z.object({ channel: z.string().min(3).max(100), budget: z.string() }).parse(req.body);
    return createUserTask(req.user.uid, b.channel, b.budget);
  });
  app.post('/tasks/:id/cancel', async req => cancelUserTask(req.user.uid, tid(req)));
  app.post('/tasks/:id/start', async req => startTask(req.user.uid, tid(req)));
  app.post('/tasks/:id/claim', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => claimTask(req.user.uid, tid(req)));
}
