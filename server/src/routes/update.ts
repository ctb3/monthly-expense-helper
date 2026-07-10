import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';

export function updateRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/update/status', async () => deps.update.status);

  app.post('/api/update/check', async (_req, reply) => {
    if (!deps.update.enabled) {
      return reply.code(400).send({ error: 'update checks not configured' });
    }
    return deps.update.check();
  });

  app.post('/api/update/apply', async (req, reply) => {
    const result = await deps.update.apply();
    if (result.error) return reply.code(502).send({ error: result.error });
    if (!result.applying) return reply.code(400).send({ error: 'update apply not configured' });
    req.log.info('update apply triggered');
    return result;
  });
}
