export type PlaidEnvName = 'sandbox' | 'production';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  sessionTtlMs: number;
  clientDist: string | undefined;
  plaid: {
    clientId: string;
    secret: string;
    env: PlaidEnvName;
  };
  update: {
    imageRef: string;
    ghcrToken: string;
    watchtowerUrl: string;
    watchtowerToken: string;
    currentSha: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'var/expense.db',
    sessionTtlMs: Number(env.SESSION_TTL_MINUTES ?? 60) * 60_000,
    clientDist: env.CLIENT_DIST || undefined,
    plaid: {
      clientId: env.PLAID_CLIENT_ID ?? '',
      secret: env.PLAID_SECRET ?? '',
      env: plaidEnv,
    },
    update: {
      imageRef: env.IMAGE_REF ?? 'ghcr.io/ctb3/expense-helper:latest',
      ghcrToken: env.GHCR_TOKEN ?? '',
      watchtowerUrl: env.WATCHTOWER_URL ?? 'http://watchtower:8080',
      watchtowerToken: env.WATCHTOWER_TOKEN ?? '',
      currentSha: env.GIT_SHA ?? '',
    },
  };
}
