# monthly-expense-helper

Personal app automating monthly expenses: Plaid pulls card transactions, web UI
categorizes them (learned merchant memory + Plaid category fallback), exports CSV/TSV
that pastes into the user's Google Sheet. Solo user, LAN-only, security-sensitive
(bank access tokens).

## Commands

- `npm run dev` — server :8080 (tsx watch) + Vite client :5173 (proxies /api)
- `npm test` — vitest, server workspace (unit + fastify-inject API tests)
- `npm run build` — typecheck + build both workspaces (run before considering done)
- `docker compose up -d --build` — production container

## Architecture (npm workspaces)

- `server/src/crypto/vault.ts` — scrypt + AES-256-GCM; Plaid access tokens encrypted at
  rest; key in memory only; app boots locked, `/api/unlock` gates everything.
- `server/src/db/index.ts` — better-sqlite3, migrations = ordered SQL array keyed by
  `user_version`. Append new migrations, never edit old ones.
- `server/src/plaid/sync.ts` — `/transactions/sync` cursor loop; upserts accounts+txns.
- `server/src/categorize.ts` — suggestion order: merchant_map (high conf) → ignore
  heuristics (card payments/transfers/AUTOPAY names) → PFC→taxonomy map (low conf).
  User picks and hide/unhide decisions write back via `learn`/`learnIgnore`.
- `server/src/routes/export.ts` — export bakes unsaved suggestions in; excludes hidden
  rows (`transactions.ignored` tri-state: NULL=auto, 1=hide, 0=keep).
- `client/src/pages/Transactions.tsx` — single main table; edits save instantly, no
  approve/review flow (user explicitly removed it — don't reintroduce).

## Invariants / gotchas

- Export column contract: `Date,Price,Category,Subcategory,Source,Note`, dates
  MM/DD/YYYY, CRLF. Matches the user's spreadsheet exactly — never change silently.
- `server/data/taxonomy.json` spellings **"Recuring"** and **"Hygene"** are intentional
  (match the sheet). Do not fix.
- `.env` (Plaid production keys) and `data/*.csv` (real financial history) are
  gitignored — keep it that way; never log tokens (see `server/src/redact.ts`).
- Plaid: free-trial account, 10 real connections (1 used: Amex). Sandbox for testing
  (`user_good`/`pass_good`). OAuth works via desktop popup — no redirect URI (removed;
  in git history if mobile webview linking ever needed). Amex consent expires annually
  → Re-link button on Accounts.
- Dev env is WSL2 with repo on /mnt/c: process startup is slow (wait several seconds
  before curling a fresh server); Vite must bind 0.0.0.0 (`host: true`) or the Windows
  browser can't reach it.
- Suggestions are computed live on GET; only user-picked categories persist. Table and
  export always agree by construction.

## Deferred features (user wants eventually, not yet)

- Amazon order-history enrichment; checking-account "all cards paid" dashboard;
  additional institutions (citi, usbank, chase, pnc) via the same pipeline.
