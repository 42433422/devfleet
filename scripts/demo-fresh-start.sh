#!/usr/bin/env bash
# 全新环境一键初始化：空 DB → schema → guest → E2E Git 仓库
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FRESH_DIR="${DEVFLEET_FRESH_DIR:-/tmp/devfleet-fresh-$$}"
DB_FILE="$FRESH_DIR/devfleet.db"
PORT="${DEVFLEET_DEMO_PORT:-3099}"

echo "==> DevFleet 全新环境初始化"
echo "    数据目录: $FRESH_DIR"
echo "    测试端口: $PORT"

rm -rf "$FRESH_DIR"
mkdir -p "$FRESH_DIR"

export DEVFLEET_DB_FILE="$DB_FILE"
export JWT_SECRET="${JWT_SECRET:-devfleet-demo-secret}"
export PORT="$PORT"

# 启动临时服务端（server.ts 会自动建库 + guest bootstrap）
node dist-server/devfleet-server.cjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "==> 等待 API 就绪..."
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "ERROR: API 未在 $PORT 启动" >&2
  exit 1
fi
echo "    ✓ health OK"

GUEST_JSON=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/auth/guest")
TOKEN=$(echo "$GUEST_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.token||'')})")
if [ -z "$TOKEN" ]; then
  echo "ERROR: guest 登录失败" >&2
  exit 1
fi
echo "    ✓ guest 登录 OK"

DEVICE_COUNT=$(curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/devices" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log((j.devices||[]).length)})")
echo "    ✓ 预置设备数: $DEVICE_COUNT"

kill $SERVER_PID 2>/dev/null || true
trap - EXIT

echo "==> 初始化 E2E Git 仓库..."
bash scripts/e2e-setup-git-repo.sh

cat <<EOF

全新环境初始化完成。

桌面应用数据目录（Tauri 打包版）:
  ~/Library/Application Support/com.devfleet.app/devfleet.db

开发模式一键启动:
  npm run dev

演示一键流程:
  npm run demo:run

E2E 闭环（推荐 --auto-touch 保底）:
  export DEVFLEET_REPO_URL="file:///tmp/devfleet-e2e/bare.git"
  export DEVFLEET_MERGE_WORKSPACE="/tmp/devfleet-e2e/merge-workspace"
  export DEVFLEET_WORKSPACE_ROOT="/tmp/devfleet-e2e/agent-workspace"
  export DEVFLEET_TOKEN="<Integration 页 JWT>"
  npm run e2e:loop -- --auto-touch
EOF
