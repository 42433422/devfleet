#!/usr/bin/env bash
# 现场演示串联：构建 → 健康检查 → 打开 DevFleet.app / showcase
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PATH="$ROOT/src-tauri/target/release/bundle/macos/DevFleet.app"
HEALTH_URL="${DEVFLEET_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
OPEN_APP="${DEVFLEET_OPEN_APP:-1}"
OPEN_SHOWCASE="${DEVFLEET_OPEN_SHOWCASE:-1}"

echo "==> DevFleet 演示准备"

if [ ! -f "dist-server/devfleet-server.cjs" ]; then
  echo "    构建服务端..."
  npm run server:build
fi

if [ ! -f "dist-mcp/devfleet-mcp.mjs" ]; then
  echo "    构建 MCP..."
  npm run mcp:build
fi

echo "==> 初始化 E2E Git（file:// bare 仓库）..."
npm run e2e:setup

echo "==> 健康检查: $HEALTH_URL"
if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "    ✓ API 在线"
else
  echo "    ⚠ API 未响应 — 尝试启动 DevFleet.app"
  if [ -d "$APP_PATH" ] && [ "$OPEN_APP" = "1" ]; then
    open "$APP_PATH"
    echo "    等待 embedded server 启动（最多 30s）..."
    for i in $(seq 1 60); do
      if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
        echo "    ✓ API 已恢复"
        break
      fi
      sleep 0.5
    done
  fi
  if ! curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "ERROR: 仍无法访问 $HEALTH_URL" >&2
    echo "请手动: open $APP_PATH  或  npm run tauri:dev" >&2
    exit 1
  fi
fi

if [ "$OPEN_SHOWCASE" = "1" ] && [ -f "$ROOT/devfleet-showcase.html" ]; then
  open "file://$ROOT/devfleet-showcase.html"
  echo "    ✓ 已打开 showcase 页面"
fi

if [ "$OPEN_APP" = "1" ] && [ -d "$APP_PATH" ]; then
  open "$APP_PATH" 2>/dev/null || true
  echo "    ✓ 已打开 DevFleet.app"
fi

cat <<EOF

演示就绪。推荐命令:

  # 离线保底（不依赖 Trae 改码）
  export DEVFLEET_API_URL=http://localhost:3001
  export DEVFLEET_TOKEN="<Integration 页 JWT>"
  export DEVFLEET_REPO_URL="file:///tmp/devfleet-e2e/bare.git"
  export DEVFLEET_MERGE_WORKSPACE="/tmp/devfleet-e2e/merge-workspace"
  export DEVFLEET_WORKSPACE_ROOT="/tmp/devfleet-e2e/agent-workspace"
  npm run e2e:loop -- --auto-touch

详见 docs/DEMO-RUNBOOK.md
EOF
