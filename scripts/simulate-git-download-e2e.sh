#!/usr/bin/env bash
# 模拟新用户：从 GitHub Release 下载 DMG → 安装 → 绑定代理 → 真实 Trae E2E（无 auto-touch）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${DEVFLEET_VERSION:-1.3.10}"
REPO="${DEVFLEET_RELEASE_REPO:-42433422/devfleet}"
DMG="${DEVFLEET_DMG:-/tmp/DevFleet_${VERSION}_aarch64.dmg}"
E2E_ROOT="${DEVFLEET_E2E_ROOT:-/tmp/devfleet-e2e}"
AGENT_WS="$E2E_ROOT/agent-workspace"
BARE="$E2E_ROOT/bare.git"
MERGE="$E2E_ROOT/merge-workspace"
APP_SUPPORT="$HOME/Library/Application Support/com.devfleet.desktop"
API="http://localhost:3001"

log() { echo "[simulate] $*"; }

clean_install() {
  log "清理旧安装..."
  pkill -f "DevFleet.app" 2>/dev/null || true
  pkill -f devfleet-server 2>/dev/null || true
  pkill -f devfleet-mcp 2>/dev/null || true
  pkill -f e2e-agent 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/DevFleet.app" "$APP_SUPPORT"
}

download_dmg() {
  if [ -f "$DMG" ] && [ "${SKIP_DMG_DOWNLOAD:-}" = "1" ]; then
    log "跳过下载，使用已有 $DMG"
    return
  fi
  if [ -n "${DEVFLEET_DMG:-}" ] && [ -f "$DMG" ]; then
    log "使用指定 DMG: $DMG"
    return
  fi
  local url="https://github.com/${REPO}/releases/download/v${VERSION}/DevFleet_${VERSION}_aarch64.dmg"
  log "下载 $url"
  curl -fL "$url" -o "$DMG"
}

install_dmg() {
  log "安装到 /Applications..."
  hdiutil attach "$DMG" -nobrowse -quiet
  local vol
  vol=$(ls -d /Volumes/DevFleet* 2>/dev/null | head -1)
  rm -rf /Applications/DevFleet.app
  cp -R "$vol/DevFleet.app" /Applications/
  xattr -cr /Applications/DevFleet.app
  hdiutil detach "$vol" -quiet 2>/dev/null || hdiutil detach "$vol" -force || true
}

wait_health() {
  log "等待 API 就绪..."
  open /Applications/DevFleet.app
  for i in $(seq 1 30); do
    if curl -sf --max-time 2 "$API/api/health" >/dev/null 2>&1; then
      log "API ok (${i})"
      return 0
    fi
    sleep 2
  done
  echo "API 未就绪" >&2
  pgrep -fl devfleet-server || true
  exit 1
}

setup_e2e_git() {
  log "初始化 E2E Git..."
  DEVFLEET_E2E_ROOT="$E2E_ROOT" bash "$ROOT/scripts/e2e-setup-git-repo.sh" >/dev/null
  mkdir -p "$AGENT_WS"
}

json_field() {
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null
}

bind_agent() {
  log "API 绑定本机代理..."
  local token bind_code activate_json
  token=$(curl -sf -X POST "$API/api/auth/guest" | json_field '["token"]')
  bind_code=$(curl -sf -H "Authorization: Bearer $token" -X POST "$API/api/devices/bind" \
    -H 'Content-Type: application/json' -d '{"name":"E2E Mac Agent"}' | json_field '["bindCode"]')
  activate_json=$(curl -sf -X POST "$API/api/devices/activate" \
    -H 'Content-Type: application/json' \
    -d "{\"bindCode\":\"$bind_code\",\"deviceName\":\"E2E Mac Agent\"}")
  mkdir -p "$APP_SUPPORT"
  ACTIVATE_JSON="$activate_json" AGENT_WS="$AGENT_WS" API="$API" APP_SUPPORT="$APP_SUPPORT" python3 <<'PY'
import json, os
act = json.loads(os.environ["ACTIVATE_JSON"])
cfg = {
    "apiBaseUrl": os.environ["API"],
    "deviceToken": act["deviceToken"],
    "deviceId": act["device"]["id"],
    "deviceName": act["device"]["name"],
    "controllerId": act["controller"]["id"],
    "controllerEmail": act["controller"]["email"],
    "controllerDeviceId": (act["controller"].get("primaryDevice") or act["device"])["id"],
    "controllerDeviceName": (act["controller"].get("primaryDevice") or act["device"])["name"],
    "workspaceRoot": os.environ["AGENT_WS"],
    "devTool": "trae",
    "defaultEditor": "trae",
    "executor": "codex",
}
path = os.path.join(os.environ["APP_SUPPORT"], "agent.json")
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
print("agent.json written")
PY
  log "重启 App 以连接代理..."
  pkill -f "/Applications/DevFleet.app/Contents/MacOS/app" 2>/dev/null || true
  sleep 2
  open /Applications/DevFleet.app
  for i in $(seq 1 30); do
    online=$(curl -sf -H "Authorization: Bearer $token" "$API/api/devices" | python3 -c 'import sys,json; d=json.load(sys.stdin); o=[x for x in d.get("devices",[]) if x.get("status")=="online"]; print(o[0]["name"] if o else "")')
    if [ -n "$online" ]; then
      log "设备在线: $online"
      return 0
    fi
    sleep 2
  done
  echo "设备代理未上线" >&2
  exit 1
}

configure_cursor_mcp() {
  local mcp_json="$HOME/.cursor/mcp.json"
  local token mcp_path
  token=$(curl -sf -X POST "$API/api/auth/guest" | node -pe 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
  mcp_path="$APP_SUPPORT/mcp/devfleet-mcp.mjs"
  if [ ! -f "$mcp_path" ]; then
    mcp_path="/Applications/DevFleet.app/Contents/Resources/mcp/devfleet-mcp.mjs"
  fi
  NODE_BIN="/Applications/DevFleet.app/Contents/Resources/server/runtime/bin/node"
  if [ ! -f "$NODE_BIN" ]; then
    NODE_BIN="/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node"
  fi
  TOKEN="$token" NODE_BIN="$NODE_BIN" MCP_PATH="$mcp_path" API="$API" node -e "
    const fs=require('fs'); const path=require('path'); const os=require('os');
    const file=path.join(os.homedir(),'.cursor/mcp.json');
    let cfg={mcpServers:{}};
    try{cfg=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    cfg.mcpServers=cfg.mcpServers||{};
    cfg.mcpServers.devfleet={
      command:process.env.NODE_BIN,
      args:[process.env.MCP_PATH],
      env:{DEVFLEET_API_URL:process.env.API,DEVFLEET_TOKEN:process.env.TOKEN}
    };
    fs.writeFileSync(file,JSON.stringify(cfg,null,2)+'\n');
  "
  log "Cursor MCP 已配置"
}

run_e2e() {
  log "运行真实 E2E（Trae Computer Use，无 auto-touch）..."
  export DEVFLEET_API_URL="$API"
  export DEVFLEET_TOKEN="$(curl -sf -X POST "$API/api/auth/guest" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
  export DEVFLEET_REPO_URL="file://$BARE"
  export DEVFLEET_MERGE_WORKSPACE="$MERGE"
  export DEVFLEET_WORKSPACE_ROOT="$AGENT_WS"
  export DEVFLEET_E2E_TIMEOUT="${DEVFLEET_E2E_TIMEOUT:-600}"
  cd "$ROOT"
  npm run e2e:loop -- --timeout="$DEVFLEET_E2E_TIMEOUT"
}

main() {
  clean_install
  download_dmg
  install_dmg
  wait_health
  setup_e2e_git
  bind_agent
  configure_cursor_mcp
  run_e2e
  log "✅ 全流程成功"
}

main "$@"
