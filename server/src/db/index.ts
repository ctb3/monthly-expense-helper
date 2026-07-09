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
  // v3: credit-card payment dashboard. Liabilities snapshots (from Plaid
  // /liabilities/get) plus accumulated per-card history and manual overrides.
  `
  ALTER TABLE items ADD COLUMN liabilities_status TEXT; -- NULL=never tried, 'ok', 'unavailable'

  CREATE TABLE account_liabilities (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    next_payment_due_date TEXT,
    last_payment_date TEXT,
    last_payment_amount REAL,
    last_statement_issue_date TEXT,
    last_statement_balance REAL,
    minimum_payment_amount REAL,
    is_overdue INTEGER,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Snapshot APIs only report the latest due/payment, so each sync appends to
  -- this history; past-month dashboard cells read from it.
  CREATE TABLE card_events (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('payment','due')),
    event_date TEXT NOT NULL, -- YYYY-MM-DD
    amount REAL,
    PRIMARY KEY (account_id, kind, event_date)
  );

  CREATE TABLE card_payment_overrides (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    month TEXT NOT NULL,      -- 'YYYY-MM'
    paid INTEGER NOT NULL,    -- 1=force paid, 0=force unpaid
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, month)
  );
  `,
  // v4: user-defined institution ordering. Drives Transactions/export/dashboard
  // row order (was alphabetical by source_label). Backfill existing by id.
  `
  ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
  UPDATE items SET sort_order = id;
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
