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
    redirectUri: string | undefined;
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
      redirectUri: env.PLAID_REDIRECT_URI || undefined,
    },
  };
}
