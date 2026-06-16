#!/usr/bin/env bash
# 初始化 DevFleet 本机 E2E 用的 bare Git 仓库与 merge 工作区。
set -euo pipefail

ROOT="${DEVFLEET_E2E_ROOT:-/tmp/devfleet-e2e}"
BARE="$ROOT/bare.git"
MERGE="$ROOT/merge-workspace"
AGENT="$ROOT/agent-workspace"

rm -rf "$ROOT"
mkdir -p "$ROOT"

git init --bare "$BARE"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -b main
git -C "$TMP" config user.email "e2e@devfleet.local"
git -C "$TMP" config user.name "DevFleet E2E"
echo "# DevFleet E2E Repo" > "$TMP/README.md"
git -C "$TMP" add README.md
git -C "$TMP" commit -m "chore: init e2e repo"
git -C "$TMP" remote add origin "$BARE"
git -C "$TMP" push -u origin main

git clone "$BARE" "$MERGE"
git -C "$MERGE" config user.email "e2e@devfleet.local"
git -C "$MERGE" config user.name "DevFleet E2E"

mkdir -p "$AGENT"

cat <<EOF
DevFleet E2E 本地 Git 环境已就绪:

  bare 仓库:     $BARE
  merge 工作区:  $MERGE
  agent 工作区:  $AGENT

请在 DevFleet「本机设备代理」绑定工作目录为:
  $AGENT

运行闭环测试:
  export DEVFLEET_REPO_URL="file://$BARE"
  export DEVFLEET_MERGE_WORKSPACE="$MERGE"
  export DEVFLEET_WORKSPACE_ROOT="$AGENT"
  export DEVFLEET_TOKEN="<从 DevFleet Integration 页复制>"
  npm run e2e:loop
EOF
