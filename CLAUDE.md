# expense-helper

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
- `server/src/cards.ts` + `server/src/routes/cards.ts` — credit-card payment dashboard.
  `GET /api/cards/dashboard` computes per-card/per-month status live (green=paid,
  yellow=due ≤7d, red=late, neutral=no data); window is prev 2 + current + next month.
  Status precedence (pure logic in `cards.ts`): manual override > liability payment >
  zero statement balance > due-date color. `syncLiabilities` (in `plaid/sync.ts`)
  fetches `/liabilities/get` after txn sync and never throws — marks the item
  `liabilities_status='unavailable'` on any failure so txn sync is unaffected. Snapshot
  fields are appended to `card_events` for history (snapshot API only reports latest).
- `client/src/pages/Transactions.tsx` — single main table; edits save instantly, no
  approve/review flow (user explicitly removed it — don't reintroduce).
- `client/src/pages/Dashboard.tsx` — payment grid, default tab. Card-confirmed cells
  (payment or zero balance) are locked; other cells toggle auto ↔ manually-paid on click.
  Each card row has a connection-health dot (`SyncDot`): green = auth ok, red =
  `items.status='login_required'`; clicking the red dot launches a Plaid update-mode
  re-link inline (shared `client/src/components/PlaidLauncher.tsx`, also used by Accounts).
- Lost auth: `syncItem` catches `ITEM_LOGIN_REQUIRED` and sets `items.status='login_required'`
  (a successful sync sets it back to `'active'`). Sync All flags dead items automatically;
  unlock (login) auto-runs Sync All so the dashboard surfaces re-auth needs immediately.
- Self-update: CI (`.github/workflows/publish.yml`) pushes `ghcr.io/ctb3/expense-helper`
  (`:latest` + `:sha-<sha>`, provenance off so `:latest` is a plain manifest) with the full
  git SHA baked in (`ENV GIT_SHA` + revision label). `server/src/update.ts` `UpdateChecker`
  compares own SHA to the remote `:latest` revision label via GHCR registry API (checks on
  unlock, 6h interval started only in `isMain`, manual `POST /api/update/check`); header
  `UpdateButton` (client) installs via the watchtower sidecar's HTTP API
  (`docker-compose.prod.yml`; dev compose unchanged). GHCR package is public → anonymous
  token exchange; `GHCR_TOKEN` only needed if it goes private again. Feature self-disables
  without a real `GIT_SHA` (+ `WATCHTOWER_TOKEN` for apply) — dev/tests see
  `enabled:false`. Apply response is expected to be lost (watchtower kills the container
  mid-request): server races a 5s timer, client polls `/api/status` down→up then reloads.

## Invariants / gotchas

- Export column contract: `Date,Price,Category,Subcategory,Source,Note`, dates
  MM/DD/YYYY, CRLF. Matches the user's spreadsheet exactly — never change silently.
- `server/data/taxonomy.json` spellings **"Recuring"** and **"Hygene"** are intentional
  (match the sheet). Do not fix.
- `.env` (Plaid production keys) and `data/*.csv` (real financial history) are
  gitignored — keep it that way; never log tokens (see `server/src/redact.ts`).
- Plaid: free-trial account with a limited number of real connections (several in use;
  one institution returns liabilities `unavailable`). Sandbox for testing
  (`user_good`/`pass_good`). OAuth works via desktop popup — no redirect URI (removed;
  in git history if mobile webview linking ever needed). Some issuers' consent expires
  annually → Re-link button on Accounts. (Which institutions are linked lives in
  private session memory, not this public file.)
- Dev env is WSL2 with repo on /mnt/c: process startup is slow (wait several seconds
  before curling a fresh server); Vite must bind 0.0.0.0 (`host: true`) or the Windows
  browser can't reach it.
- Suggestions are computed live on GET; only user-picked categories persist. Table and
  export always agree by construction.
- Row order in Transactions/export/dashboard = `items.sort_order` then `source_label`
  (was alphabetical). User reorders institution cards on Accounts (`↑/↓` →
  `POST /api/items/reorder`). Multi-account institutions stay grouped (share item order).
- Dashboard liabilities key off `last_statement_balance` (a balance ≤ 0 = settled,
  shown green): Plaid sandbox reports `minimum_payment_amount = 0` for every card, so
  that field is useless as a "nothing owed" signal. Link token requests Liabilities as
  `optional_products` (new link) / `additional_consented_products` (re-link) so cards
  lacking the product still link; re-link to grant consent if status stays `unavailable`.

## Deferred features (user wants eventually, not yet)

- Amazon order-history enrichment.
