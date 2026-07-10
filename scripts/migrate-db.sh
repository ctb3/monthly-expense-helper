#!/usr/bin/env bash
# Import a dev-DB snapshot into the deployed container's data volume.
#
# On the dev machine first:  npm run db:snapshot
#                            scp server/var/expense-migrate.db root@<host>:/opt/expense-helper/
# Then here (next to docker-compose.prod.yml):
#   bash migrate-db.sh [snapshot-file] [compose-file]
set -euo pipefail

SNAPSHOT="${1:-expense-migrate.db}"
COMPOSE="${2:-docker-compose.prod.yml}"

[ -f "$SNAPSHOT" ] || { echo "error: $SNAPSHOT not found" >&2; exit 1; }
[ -f "$COMPOSE" ] || { echo "error: $COMPOSE not found (run from the deploy directory)" >&2; exit 1; }

# A bare expense.db copied out of a WAL-mode dev setup is ~4 kB and empty.
size=$(stat -c%s "$SNAPSHOT")
if [ "$size" -lt 100000 ]; then
  echo "warning: $SNAPSHOT is only ${size} bytes — a populated DB is much larger." >&2
  echo "Create the snapshot with 'npm run db:snapshot' (VACUUM INTO), not a raw copy." >&2
  read -rp "Continue anyway? [y/N] " ans
  [ "${ans,,}" = "y" ] || exit 1
fi

dc() { docker compose -f "$COMPOSE" "$@"; }

dc stop app
cid=$(dc ps -aq app)
[ -n "$cid" ] || { echo "error: app container not found — run 'docker compose -f $COMPOSE up -d' once first" >&2; exit 1; }

docker cp "$SNAPSHOT" "$cid":/data/expense.db
# Two fixups in one shot:
# - stale -wal/-shm from a previous run MUST go: SQLite would "recover" that
#   old WAL over the freshly copied DB on next open, silently reverting it
#   (symptom: app offers first-run setup again despite a good copy);
# - docker cp writes as root; the app runs as 'node' and SQLite must create
#   new -wal/-shm files next to the DB.
dc run --rm --user root app \
  sh -c 'rm -f /data/expense.db-wal /data/expense.db-shm && chown node:node /data/expense.db'
dc start app

echo "done — open the app and unlock with the snapshot's passphrase"
