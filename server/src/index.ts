import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/index.js';
import { Vault } from './crypto/vault.js';
import { Sessions } from './session.js';
import { makePlaidClient } from './plaid/client.js';
import type { AppDeps } from './deps.js';
import { authRoutes } from './routes/auth.js';
import { plaidRoutes } from './routes/plaid.js';
import { transactionRoutes } from './routes/transactions.js';
import { exportRoutes } from './routes/export.js';
import { importRoutes } from './routes/import.js';

const PUBLIC_API = new Set(['/api/status', '/api/unlock']);

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    // Default serializers keep request logs to method/url/status: no bodies, no headers.
    logger: { level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info') },
    bodyLimit: 5 * 1024 * 1024,
  });

  app.register(cookie);

  // Everything under /api requires an unlocked vault + valid session,
  // except status and unlock themselves.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_API.has(url)) return;
    if (!deps.vault.unlocked || !deps.sessions.isValid(req.cookies?.session)) {
      return reply.code(401).send({ error: 'locked' });
    }
  });

  authRoutes(app, deps);
  plaidRoutes(app, deps);
  transactionRoutes(app, deps);
  exportRoutes(app, deps);
  importRoutes(app, deps);

  // Serve the built client in production.
  const clientDist =
    deps.config.clientDist ??
    resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist');
  if (existsSync(clientDist)) {
    app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

export function buildDeps(config: Config, db?: Db): AppDeps {
  return {
    config,
    db: db ?? openDb(config.dbPath),
    vault: new Vault(),
    sessions: new Sessions(config.sessionTtlMs),
    plaid: makePlaidClient(config),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const envPath of ['.env', '../.env']) {
    try {
      process.loadEnvFile(envPath);
      break;
    } catch {
      /* no .env here */
    }
  }
  const config = loadConfig();
  if (!config.plaid.clientId || !config.plaid.secret) {
    // eslint-disable-next-line no-console
    console.warn('PLAID_CLIENT_ID / PLAID_SECRET not set - Plaid routes will fail until configured');
  }
  const app = buildApp(buildDeps(config));
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
