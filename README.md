# monthly-expense-helper

Automates the monthly expense routine: pull card/bank transactions via Plaid, review
and categorize them in a small local web UI (with learned category suggestions), then
export a CSV that pastes straight into the expense spreadsheet
(`Date, Price, Category, Subcategory, Source, Note`).

## Monthly workflow

1. **Unlock** the app with your vault passphrase.
2. **Accounts → Sync now** on each linked institution.
3. **Transactions**: pick the month (or a custom range). Categories are pre-filled from
   merchant history / Plaid guesses; fix any that are wrong — every manual pick saves
   instantly and teaches the merchant memory.
4. **Download CSV** (combined or per-card) from the same screen, paste into the sheet.
5. Pay the cards (dashboard for verifying payments is a planned future feature).

## First-time setup

```bash
npm install
cp .env.example .env   # add PLAID_CLIENT_ID / PLAID_SECRET; chmod 600 .env
npm run dev            # server :8080, client :5173 (proxied)
```

- On first load you choose a **vault passphrase** (10+ chars). It encrypts the Plaid
  access tokens (AES-256-GCM, scrypt-derived key held only in memory). There is no
  recovery — a forgotten passphrase means re-linking institutions.
- **Import** your historical sheet export (`data/finances export.csv` format) once to
  seed category suggestions.
- Test the full flow with `PLAID_ENV=sandbox` first (institution: any, credentials
  `user_good` / `pass_good`) — sandbox links don't consume free-trial connections.
- Switch to `PLAID_ENV=production` and link Amex for real data. Amex uses OAuth and
  needs an HTTPS redirect URI registered in the Plaid dashboard — see
  `docs/deploy-proxmox.md`.

## Commands

| Command | What |
| --- | --- |
| `npm run dev` | Server (tsx watch) + Vite client with API proxy |
| `npm test` | Server unit + API tests (vitest) |
| `npm run build` | Typecheck + build both workspaces |
| `docker compose up -d --build` | Production container (see `docs/deploy-proxmox.md`) |

## Layout

- `server/` — Fastify + better-sqlite3. Vault (`src/crypto/vault.ts`), Plaid sync
  (`src/plaid/`), suggestion engine (`src/categorize.ts`), CSV export (`src/export.ts`),
  taxonomy (`data/taxonomy.json`).
- `client/` — React + Vite UI: Unlock, Review, Accounts, Export, Import.
- `docs/` — Proxmox deployment and AWS migration notes.

## Security model (summary)

- App boots **locked**; all API routes 401 until the passphrase unlocks the vault.
- Plaid access tokens are encrypted at rest; bank credentials never touch this app
  (Plaid Link handles them).
- Designed for LAN-only use behind your firewall or a VPN — never port-forward it.
- Logs never include tokens or Plaid payloads (`server/src/redact.ts`).
