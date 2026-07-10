import type { PlaidApi } from 'plaid';
import type { Db } from './db/index.js';
import type { Vault } from './crypto/vault.js';
import type { Sessions } from './session.js';
import type { Config } from './config.js';
import type { UpdateChecker } from './update.js';

export interface AppDeps {
  db: Db;
  vault: Vault;
  sessions: Sessions;
  config: Config;
  plaid: PlaidApi;
  update: UpdateChecker;
}
