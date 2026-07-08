import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { Config } from '../config.js';

export function makePlaidClient(cfg: Config): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[cfg.plaid.env],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': cfg.plaid.clientId,
          'PLAID-SECRET': cfg.plaid.secret,
        },
      },
    }),
  );
}
