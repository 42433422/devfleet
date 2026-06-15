#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$ROOT/data"
if [ ! -f "$ROOT/data/jwt-secret.txt" ]; then
  (command -v openssl >/dev/null && openssl rand -hex 32 || date +%s%N) > "$ROOT/data/jwt-secret.txt"
fi
export JWT_SECRET="$(cat "$ROOT/data/jwt-secret.txt")"
export DEVFLEET_DB_FILE="$ROOT/data/db.json"
export PORT="${PORT:-3001}"
exec node "$ROOT/devfleet-server.cjs"
