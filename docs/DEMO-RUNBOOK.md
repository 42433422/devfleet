# DevFleet 现场演示 Runbook

中文速查：演示前准备、一键命令、故障排除与离线保底方案。

## 前置条件

| 组件 | 要求 |
|------|------|
| DevFleet.app | 已打包（`npm run tauri:build`）或可 `npm run tauri:dev` |
| Node.js | ≥ 18 |
| Git | 本机已安装 |
| Trae（可选） | 完整闭环需要；离线演示可用 `--auto-touch` 跳过 |
| Cursor MCP | Integration 页配置 `devfleet`，`DEVFLEET_TOKEN` 为用户 JWT |

## MCP 工具清单（8 个）

与 `tests/mcp.test.ts` 一致：

1. `devfleet_list_devices`
2. `devfleet_dispatch_task`
3. `devfleet_get_task`
4. `devfleet_wait_for_task`
5. `devfleet_merge_task`
6. `devfleet_computer_use_start_trae_task`
7. `devfleet_next_task`
8. `devfleet_report_task_progress`

## 一键命令

### 全新环境验证（空 DB + schema + guest）

```bash
cd /Users/a4243342/Desktop/XCMAX/未命名文件夹
npm run server:build
chmod +x scripts/demo-fresh-start.sh
npm run demo:fresh
```

### 现场演示串联

```bash
npm run demo:run
```

自动执行：E2E Git 初始化 → health 检查 → 打开 DevFleet.app 与 showcase 页面。

### E2E 最小闭环（推荐 `--auto-touch` 保底）

```bash
npm run e2e:setup

export DEVFLEET_API_URL=http://localhost:3001
export DEVFLEET_TOKEN="<Integration 页 JWT>"
export DEVFLEET_REPO_URL="file:///tmp/devfleet-e2e/bare.git"
export DEVFLEET_MERGE_WORKSPACE="/tmp/devfleet-e2e/merge-workspace"
export DEVFLEET_WORKSPACE_ROOT="/tmp/devfleet-e2e/agent-workspace"

# 离线保底：自动写入测试文件，不依赖 Trae
npm run e2e:loop -- --auto-touch
```

### 健康检查

```bash
curl -s http://127.0.0.1:3001/api/health
# 期望: {"success":true,"message":"ok"}
```

## 演示 Checklist

- [ ] `curl http://127.0.0.1:3001/api/health` 返回 ok
- [ ] 打开 DevFleet.app → 自动访客登录（无需手动注册）
- [ ] 设备页有预置「我的开发设备」
- [ ] 本机设备代理已连接、dev_tool = trae
- [ ] Integration 页复制 `DEVFLEET_TOKEN`
- [ ] `npm run e2e:setup` 已执行（bare.git 就绪）
- [ ] Agent 工作目录 = `/tmp/devfleet-e2e/agent-workspace`
- [ ] 打开 `devfleet-showcase.html` 确认 LIVE 标签（API 在线时）
- [ ] 备用：`npm run e2e:loop -- --auto-touch`

## AI 指挥官闭环（6 步）

网页演示与真实 MCP 调用顺序：

1. `devfleet_list_devices` — 确认 Trae 设备在线
2. `devfleet_dispatch_task` — 派发到 bare.git
3. `devfleet_computer_use_start_trae_task` — 自动写入 Trae（禁止让用户手动复制）
4. Trae Agent 改码（工作设备侧可调用 `devfleet_next_task` / `devfleet_report_task_progress`）
5. `devfleet_wait_for_task` — 等待完成
6. `devfleet_merge_task` — merge 到 main 并 push

## 故障排除

| 现象 | 处理 |
|------|------|
| **3001 未起** | `open src-tauri/target/release/bundle/macos/DevFleet.app`；等待 10–30s 后重试 health；或 `npm run tauri:dev` |
| **访客登录失败** | 删除 `~/Library/Application Support/com.devfleet.app/devfleet.db` 后重启 App（会自动重建） |
| **设备离线** | 打开「本机设备代理」页 → 连接；确认 WebSocket 正常 |
| **Trae 未安装** | 演示改用 `npm run e2e:loop -- --auto-touch` |
| **Computer Use 失败** | macOS 辅助功能授权 DevFleet/Trae；或手动在 Trae 点「新任务」 |
| **MCP 401** | `DEVFLEET_TOKEN` 必须是 Integration 页用户 JWT，不是设备 token |
| **merge 失败** | 确认 `DEVFLEET_MERGE_WORKSPACE` clone 自同一 bare 仓库 |
| **网络不可用** | 使用 `file:///tmp/devfleet-e2e/bare.git` 本地 bare 仓库，无需外网 |
| **showcase 非 LIVE** | 仅影响动画计时；演示逻辑仍可播放；启动 App 后刷新页面 |

## 离线 Fallback

无需 Trae、无需外网 Git 的保底路径：

```bash
npm run e2e:setup
npm run e2e:loop -- --auto-touch
```

脚本会自动在 agent-workspace 写入测试标记、commit、push，并完成 merge。

## 打包路径

| 产物 | 路径 |
|------|------|
| macOS App | `src-tauri/target/release/bundle/macos/DevFleet.app` |
| DMG | `src-tauri/target/release/bundle/dmg/DevFleet_*.dmg` |
| Showcase | `devfleet-showcase.html`（`file://` 打开） |

## 相关文档

- [E2E-MINIMAL-LOOP.md](./E2E-MINIMAL-LOOP.md) — 完整 E2E 说明
- [devfleet-showcase.html](../devfleet-showcase.html) — 网页演示与 AI 剧本
