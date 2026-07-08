import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';

interface VaultMetaRow {
  salt: string;
  verifier: string;
}

const MIN_PASSPHRASE_LEN = 10;

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, vault, sessions } = deps;
  let failedAttempts = 0;

  const getMeta = (): VaultMetaRow | undefined =>
    db.prepare('SELECT salt, verifier FROM vault_meta WHERE id = 1').get() as
      | VaultMetaRow
      | undefined;

  app.get('/api/status', async () => ({
    initialized: getMeta() !== undefined,
    unlocked: vault.unlocked,
  }));

  app.post('/api/unlock', async (req, reply) => {
    const { passphrase } = (req.body ?? {}) as { passphrase?: string };
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return reply.code(400).send({ error: 'passphrase required' });
    }

    const meta = getMeta();
    if (!meta) {
      if (passphrase.length < MIN_PASSPHRASE_LEN) {
        return reply
          .code(400)
          .send({ error: `passphrase must be at least ${MIN_PASSPHRASE_LEN} characters` });
      }
      const init = vault.initialize(passphrase);
      db.prepare('INSERT INTO vault_meta (id, salt, verifier) VALUES (1, ?, ?)').run(
        init.saltB64,
        init.verifier,
      );
      req.log.info('vault initialized');
    } else {
      // Backoff on repeated failures, on top of scrypt's inherent cost.
      if (failedAttempts > 0) {
        await new Promise((r) => setTimeout(r, Math.min(failedAttempts * 500, 5000)));
      }
      if (!vault.unlock(passphrase, meta.salt, meta.verifier)) {
        failedAttempts++;
        req.log.warn('failed unlock attempt');
        return reply.code(401).send({ error: 'wrong passphrase' });
      }
      failedAttempts = 0;
    }

    const token = sessions.create();
    reply.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    return { unlocked: true };
  });

  app.post('/api/lock', async (_req, reply) => {
    vault.lock();
    sessions.destroyAll();
    reply.clearCookie('session', { path: '/' });
    return { unlocked: false };
  });
}
