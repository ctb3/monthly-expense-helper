# Deploying on Proxmox (Docker, LAN-only)

## Where to run it

Create a small VM (or LXC with nesting enabled) on Proxmox running Debian/Ubuntu with
Docker + the compose plugin. 1 vCPU / 1 GB RAM / 8 GB disk is plenty — the app is a
single Node process with SQLite.

LXC note: Docker-in-LXC needs `features: nesting=1,keyctl=1` on the container. A VM
avoids that entirely and is the lower-friction choice.

## Install

```bash
git clone <your repo> expense-helper && cd expense-helper
cp .env.example .env
chmod 600 .env
# edit .env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=production
docker compose up -d --build
```

Open `http://<vm-ip>:8080`, set the vault passphrase on first run.

## Security posture

- **No inbound from the internet.** The app pulls from Plaid; nothing needs to reach it.
  Do not port-forward it on your router. If you want access away from home, use a VPN
  into the LAN (WireGuard/Tailscale) rather than exposing the port.
- **Plaid access tokens** are AES-256-GCM encrypted in SQLite; the key exists only in
  process memory after you enter the passphrase. Every container restart returns to the
  locked state.
- **`.env` holds the Plaid API keys.** Keep it `chmod 600`, never commit it. To move off
  the filesystem entirely, switch to Docker secrets: put each value in
  `/run/secrets/...` via the compose `secrets:` block and export them in an entrypoint.
- **Backups**: the named volume `expense-data` holds the DB. `docker run --rm
  -v expense-helper_expense-data:/data -v $PWD:/backup alpine tar czf
  /backup/expense-backup.tgz /data`. Backups are safe to store as-is — tokens in them
  are useless without the passphrase — but treat them as sensitive anyway (transaction
  history is in plaintext).
- **Updates**: `git pull && docker compose up -d --build`.

## Amex / OAuth institutions

OAuth institutions (Amex included) authenticate in a **browser popup** on desktop web —
no redirect URI registration needed. Just click Link on the Accounts page from a
desktop browser and allow popups. A registered HTTPS redirect URI (Plaid dashboard →
Developers → API → Allowed redirect URIs) only becomes necessary if you ever link from
a mobile webview.

Amex consent expires annually: when its sync starts failing, use the Re-link button.
