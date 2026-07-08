# AWS migration path (future option)

The app is a single container with a SQLite file — designed so a later move to AWS is
configuration, not code.

## Minimal lift: ECS Fargate + EFS

- Push the image to ECR (`docker build` + `docker push`).
- One Fargate service (0.25 vCPU / 512 MB), desired count 1.
- Mount an EFS access point at `/data` (`DB_PATH=/data/expense.db` already points there).
- Env vars via **Secrets Manager** references in the task definition
  (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`).
- Networking: private subnet, no public IP. Reach it over a VPN (Client VPN or
  Tailscale subnet router on a nano instance) — same "no public attack surface" posture
  as the Proxmox deployment. If you must expose it, put an ALB with OIDC auth
  (Cognito/Google) in front and enable HTTPS; the vault passphrase remains a second
  factor.

## Things to keep in mind

- **SQLite on EFS** is fine for a single-task, single-user app (WAL mode is enabled;
  never run two tasks against the same file). If the app ever grows multi-user, swap
  `better-sqlite3` for Postgres/RDS — the DB layer is isolated in `server/src/db/`.
- **The vault model is unchanged**: tokens stay AES-256-GCM encrypted at rest, and the
  service starts locked after every deploy/restart until the passphrase is entered.
- **Plaid webhooks** (optional future): Fargate behind an ALB can receive them; add a
  `/api/plaid/webhook` route and register the URL. Not needed for monthly manual sync.
- **Cost ballpark**: ~$10–15/mo (Fargate + EFS + NAT/VPN) vs $0 marginal on Proxmox —
  part of why Proxmox is the default target.
