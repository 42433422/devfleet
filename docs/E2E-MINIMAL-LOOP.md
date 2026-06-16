# DevFleet 本机最小闭环 E2E（Cursor → Trae → Git → Merge）

目标：在本机计时验证 **Cursor MCP 派发 → Trae 工作设备执行 → Git push → 主设备 merge** 全流程。

## 前置条件

| 组件 | 要求 |
|------|------|
| DevFleet API | `http://localhost:3001` 可访问（`npm run dev` 或 `npm run tauri:dev`） |
| 本机设备代理 | 已绑定、在线，dev_tool = **trae** |
| Trae | 已安装；macOS 需授予 DevFleet/Trae **辅助功能** |
| Cursor MCP | Integration 页已配置 `devfleet`，`DEVFLEET_TOKEN` 为**用户 JWT** |
| Git | 本机已安装 |

## 1. 初始化本地 Git 测试仓库

```bash
cd /Users/a4243342/Desktop/XCMAX/未命名文件夹
chmod +x scripts/e2e-setup-git-repo.sh
npm run e2e:setup
```

输出中的 `agent 工作区` 路径，填到 DevFleet **本机设备代理 → 工作目录**。

## 2. 启动 DevFleet

```bash
npm run tauri:dev
```

在应用中：
1. 设备管理 → 生成绑定码 → 本机代理绑定 → 设为主设备
2. dev_tool 选 **Trae**
3. Integration 页 → 一键配置 **Cursor MCP**，复制 `DEVFLEET_TOKEN`

## 3. 方式 A：CLI 脚本（带计时）

```bash
export DEVFLEET_API_URL=http://localhost:3001
export DEVFLEET_TOKEN="<Integration 页 JWT>"
export DEVFLEET_REPO_URL="file:///tmp/devfleet-e2e/bare.git"
export DEVFLEET_MERGE_WORKSPACE="/tmp/devfleet-e2e/merge-workspace"
export DEVFLEET_WORKSPACE_ROOT="/tmp/devfleet-e2e/agent-workspace"

# Trae 人工改码（Computer Use 会自动打开 Trae 并粘贴任务）
npm run e2e:loop

# 或跳过 Trae，自动写入测试文件（验证 Git/merge 链路）
npm run e2e:loop -- --auto-touch
```

脚本会输出各阶段耗时：

```
========== E2E 计时汇总 ==========
  预检 (health + 设备 + Trae)   0.42s
  派发任务 (devfleet_dispatch_task) 0.18s
  等待工作设备完成               45.20s
  主设备合并 (devfleet_merge_task) 1.05s
  总耗时                         46.85s
==================================
```

## 4. 方式 B：Cursor Agent（真实 MCP 闭环）

在 Cursor 中对 Agent 说：

```
请用 DevFleet MCP 完成本机最小闭环测试并汇报各阶段耗时：
1. devfleet_list_devices 确认 Trae 设备在线
2. devfleet_dispatch_task 派发任务（repo 用 file:///tmp/devfleet-e2e/bare.git，在 README 追加一行测试标记）
3. 等待我在 Trae 中完成改码后 devfleet_wait_for_task
4. devfleet_merge_task workspace_path=/tmp/devfleet-e2e/merge-workspace push=true
5. 汇总 task 状态与各步骤耗时
```

Trae 侧：Computer Use 会自动打开工作区、点「新任务」并写入 prompt；你在 Trae Agent 中执行改码即可。

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| 没有在线设备 | 打开 Tauri → 本机设备代理 → 连接 |
| Trae Computer Use 失败 | macOS 辅助功能授权；或手动点「新任务」 |
| 600s 超时无 git 变更 | Trae 未实际改文件；或用 `--auto-touch` 验证 Git 链路 |
| merge origin 不一致 | `DEVFLEET_MERGE_WORKSPACE` 必须 clone 自同一 bare 仓库 |
| MCP 401 | `DEVFLEET_TOKEN` 必须是用户 JWT，不是设备 token |

## 6. 仅验证 MCP 工具链（不跑 agent）

```bash
npm run mcp:build
npm test   # 含 MCP 工具列表与 task-report API 测试
```
