# Deployment playbook — Proxmox LXC, from scratch

Complete rebuild instructions. Follow top to bottom on a fresh Proxmox node and you
end with the app running, self-updating, and backed up. Skip sections that already
exist (e.g. the GitHub bootstrap survives a dead LXC).

Architecture: a Debian LXC runs Docker Compose with two containers — the app (image
pulled from GHCR, built by `.github/workflows/publish.yml` on every push to `main`)
and a watchtower sidecar whose HTTP API the app's **Install update** button drives.
The docker socket is mounted only into watchtower, never into the app.

## 1. GitHub bootstrap (once per GitHub account, survives rebuilds)

1. **Image exists**: any push to `main` publishes
   `ghcr.io/ctb3/monthly-expense-helper:latest` + `:sha-<full-sha>`. Check under
   GitHub profile → Packages after the first CI run.
2. **Package is public** (repo and image contain no secrets; the DB and `.env` never
   enter the image): Packages → `monthly-expense-helper` → Package settings →
   visibility Public. Public means anonymous pulls — no PAT, no `docker login`, and
   the in-app checker exchanges tokens anonymously. If you ever make it private
   again, create a **classic** PAT with only `read:packages` (fine-grained PATs
   can't authenticate to GHCR), set it as `GHCR_TOKEN` in `.env`,
   `docker login ghcr.io` on the host, and give watchtower the credentials by
   adding `- /root/.docker/config.json:/config.json:ro` to its `volumes:` in
   `docker-compose.prod.yml`.

## 2. Create the LXC (Proxmox 9.x)

1. Node → local storage → **CT Templates** → download **Debian 13 (bookworm's
   successor / current stable)**.
2. Create CT:
   - **Unprivileged**: yes
   - Cores: 2, RAM: 1–2 GB, Disk: 8 GB (plenty — one Node process + SQLite)
   - Network: DHCP or static on the LAN; note the IP
3. After creation, CT → Options → **Features** → enable **nesting** (Docker-in-LXC
   requirement). If Docker later fails to start, also enable **keyctl**.
4. Start the CT and open its console (root, no password by default on console).

## 3. Install Docker in the CT

```bash
apt update && apt install -y curl
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version   # sanity check
```

(`get.docker.com` installs the engine + compose plugin from Docker's apt repo.
Manual-repo alternative if you distrust the script: follow
https://docs.docker.com/engine/install/debian/ — same result.)

## 4. Stage the app

```bash
mkdir -p /opt/expense-helper && cd /opt/expense-helper

# Only two files are needed on the host (the app itself ships in the image):
base=https://raw.githubusercontent.com/ctb3/monthly-expense-helper/main
curl -fsSLO $base/docker-compose.prod.yml
curl -fsSLO $base/.env.example

cp .env.example .env
chmod 600 .env
```

Edit `.env`:

| Var | Value |
| --- | --- |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | from the Plaid dashboard (Developers → Keys) |
| `PLAID_ENV` | `production` |
| `WATCHTOWER_TOKEN` | `openssl rand -hex 32` |
| `IMAGE_REF`, `WATCHTOWER_URL` | leave at defaults (or delete — defaults are built in) |

No registry auth needed — the package is public (see §1.2 if you re-privatize it).

## 5. First start

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps    # app + watchtower both "Up"
```

Open `http://<ct-ip>:8080`.

- **Fresh install**: first unlock sets a new vault passphrase (10+ chars, no
  recovery), then link institutions on Accounts and import the historical CSV to
  seed merchant memory.
- **Migrating an existing DB** (keeps Plaid links + history; the vault passphrase
  stays whatever it was on the old DB):

  ```bash
  # On the dev machine — do NOT copy expense.db directly (WAL mode: most data
  # sits in expense.db-wal; the bare main file is a near-empty 4 kB and the app
  # would offer first-run setup). Snapshot instead (safe while dev server runs):
  npm run db:snapshot          # writes server/var/expense-migrate.db (VACUUM INTO)
  scp server/var/expense-migrate.db root@<ct-ip>:/opt/expense-helper/

  # On the LXC (script stops the app, copies the DB in, fixes ownership
  # for the non-root app user, restarts):
  cd /opt/expense-helper
  curl -fsSLO https://raw.githubusercontent.com/ctb3/monthly-expense-helper/main/scripts/migrate-db.sh
  bash migrate-db.sh
  ```

  Unlock with the passphrase the old DB already had.

Sanity check: hover **Check for updates** in the header — the tooltip shows the
running git SHA; clicking it should say **Up to date**.

## 6. Backups

Datacenter → Backup → add a job covering this CT (the docker volume holding
`expense.db` and the `.env` file both live inside the CT's disk, so a vzdump
snapshot captures everything). `.env` contains Plaid production keys — keep backup
storage trusted; PBS with encryption is ideal. The DB's Plaid tokens are
AES-256-GCM encrypted and useless without the passphrase, but transaction history
is plaintext — treat backups as sensitive.

Restoring the CT from backup restores the whole stack; after restore, just start
the CT and unlock.

## 7. Updates (steady state)

Push to `main` → CI publishes in ~2 min → app header shows **Install update**
(detected on unlock, every 6 h, or via **Check for updates**) → click, confirm →
watchtower pulls the image and recreates the app container → the page reloads onto
the unlock screen → unlock. Data volume and `.env` are untouched.

Exceptions:

- **`.env` or compose file changed**: watchtower recreates containers with their
  *existing* config only — apply config changes manually:
  `docker compose -f docker-compose.prod.yml up -d`
- **Rollback**: edit `image:` in `docker-compose.prod.yml` to
  `ghcr.io/ctb3/monthly-expense-helper:sha-<full-sha>` (and set `IMAGE_REF` in
  `.env` to match so the app stops offering `:latest`), then `up -d`.
- **Stuck/failed update**: `docker logs $(docker ps -qf name=watchtower)` shows the
  pull/recreate attempt. Manual fallback always works:
  `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`
- **Update button missing**: the feature self-disables when the image was built
  locally (`GIT_SHA=dev`). `curl http://<ct-ip>:8080/api/update/status`
  (after unlock, with the session cookie) reports why via `enabled`/`error`.

## 8. Security posture

- **No inbound from the internet.** The app pulls from Plaid; nothing needs to
  reach it. Never port-forward it. Remote access = VPN into the LAN
  (WireGuard/Tailscale).
- App boots **locked**; every restart (including updates) returns to the unlock
  screen. Plaid access tokens are encrypted at rest; the key lives only in process
  memory after unlock.
- `.env` holds Plaid keys + the watchtower token: `chmod 600`, never commit. Logs
  never contain tokens (`server/src/redact.ts`).
- The watchtower API is reachable only on the internal compose network and requires
  the bearer token; the docker socket is exposed to watchtower only.

## Dev-box alternative (no GHCR, no updater)

`docker compose up -d --build` with the dev `docker-compose.yml` builds on the box
and runs without watchtower. The in-app updater stays disabled (`GIT_SHA=dev`) —
updates are `git pull && docker compose up -d --build`.

## Amex / OAuth institutions

OAuth institutions (Amex included) authenticate in a **browser popup** on desktop
web — no redirect URI registration needed. Link from a desktop browser and allow
popups. A registered HTTPS redirect URI (Plaid dashboard → Developers → API →
Allowed redirect URIs) only becomes necessary if you ever link from a mobile
webview.

Amex consent expires annually: when its sync starts failing, use the Re-link button.
