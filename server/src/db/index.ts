import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE vault_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    verifier TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plaid_item_id TEXT UNIQUE NOT NULL,
    institution_name TEXT NOT NULL,
    access_token_ciphertext TEXT NOT NULL,
    cursor TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    plaid_account_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    official_name TEXT,
    mask TEXT,
    type TEXT,
    subtype TEXT,
    source_label TEXT NOT NULL
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plaid_transaction_id TEXT UNIQUE NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    name TEXT NOT NULL,
    merchant_name TEXT,
    pfc_primary TEXT,
    pfc_detailed TEXT,
    category TEXT,
    subcategory TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','exported')),
    pending INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_transactions_date ON transactions(date);
  CREATE INDEX idx_transactions_account ON transactions(account_id);

  CREATE TABLE merchant_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_key TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    last_used TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v2: ignorable rows. transactions.ignored is tri-state:
  // NULL = follow auto-detection, 1 = user says hide, 0 = user says keep.
  `
  ALTER TABLE transactions ADD COLUMN ignored INTEGER;
  ALTER TABLE merchant_map ADD COLUMN ignore INTEGER NOT NULL DEFAULT 0;
  `,
];

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
