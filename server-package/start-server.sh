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
NODE_BIN="$ROOT/runtime/bin/node"
if [ -f "$NODE_BIN" ]; then
  chmod +x "$NODE_BIN" 2>/dev/null || true
else
  NODE_BIN="$(command -v node)"
fi
exec "$NODE_BIN" "$ROOT/devfleet-server.cjs"
