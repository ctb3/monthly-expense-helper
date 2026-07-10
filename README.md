# monthly-expense-helper

Automates the monthly expense routine: pull card/bank transactions via Plaid, review
and categorize them in a small local web UI (with learned category suggestions), then
export a CSV that pastes straight into the expense spreadsheet
(`Date, Price, Category, Subcategory, Source, Note`).

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
- Switch to `PLAID_ENV=production` and link Amex for real data. OAuth institutions
  (Amex included) authenticate in a browser popup — no redirect URI setup needed on
  desktop web. Amex consent expires yearly; use Re-link when sync starts failing.

## Deployment (Proxmox LXC + Docker)

Production runs the CI-built image from GHCR with a watchtower sidecar; updating to a
new version is one click inside the app. Full walkthrough in `docs/deploy-proxmox.md`;
the short version:

```bash
# Debian LXC (unprivileged, features: nesting=1) with docker + compose plugin
mkdir expense-helper && cd expense-helper
# copy docker-compose.prod.yml and .env.example here
cp .env.example .env && chmod 600 .env
# edit .env: Plaid production keys, GHCR_TOKEN (read:packages PAT),
#            WATCHTOWER_TOKEN=$(openssl rand -hex 32)
docker login ghcr.io -u ctb3        # password = the same PAT
docker compose -f docker-compose.prod.yml up -d
```

Open `http://<host>:8080`, set the vault passphrase. Every push to `main` publishes a
new image (`.github/workflows/publish.yml`); the app header then shows **Install
update** — one click pulls the image and restarts the container (it comes back locked;
unlock as usual). Changes to `.env` or the compose file still need a manual
`docker compose -f docker-compose.prod.yml up -d`. Back up the LXC (or the
`expense-data` volume) with Proxmox's normal backup job.

## Commands

| Command | What |
| --- | --- |
| `npm run dev` | Server (tsx watch) + Vite client with API proxy |
| `npm test` | Server unit + API tests (vitest) |
| `npm run build` | Typecheck + build both workspaces |
| `docker compose up -d --build` | Local production container (build-on-box; in-app updater disabled) |
| `docker compose -f docker-compose.prod.yml up -d` | Deployment: GHCR image + watchtower (see `docs/deploy-proxmox.md`) |

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
