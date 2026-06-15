# DevFleet

DevFleet 是真实运行的多设备代码任务系统，由四部分组成：

1. Tauri 桌面控制台。
2. 内置于同一桌面程序的设备代理。
3. 支持 WebSocket 的自托管协调服务。
4. 可接入 Trae、Codex CLI/IDE、Cursor 的 STDIO MCP 服务（主设备调度用）。

**工作流**：主设备在「设备管理」为每台**工作设备**指定一种开发工具（Trae / Codex / Cursor / Claude Code，**默认 Trae**）。主设备创建任务后，任务只派发给在线的工作设备（有非主设备在线时，主设备本身不执行子任务）；各设备按指定工具打开工作区，由 Codex CLI 自动改码并 **Git push 独立分支**；主设备在任务详情或 MCP 中 **fetch/merge/push** 合并各分支。

## 运行要求

**主设备**（调度 + 合并）：

- DevFleet 桌面客户端或 Web 控制台
- Trae / Codex / Cursor / Claude Code 任一 MCP（见「MCP 接入」）
- 本地已有该 Git 仓库 clone（用于最终合并）

**工作设备**（执行子任务）：

- Git，并已配置仓库拉取和推送权限
- 开发工具与执行器（由主设备在「设备管理」指定）：
  - **Cursor** → Cursor Agent CLI（`agent login` 或 `CURSOR_API_KEY`），**不需要 Codex**
  - **Trae / Claude Code** → 可选打开 IDE + **Codex CLI** 自动改码
  - **Codex** → 仅 **Codex CLI**
- DevFleet 本机代理在线

## 部署服务端

服务端必须是单实例且有持久磁盘。Vercel Serverless 不支持本项目需要的常驻 WebSocket。

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

`.env` 至少需要：

```env
JWT_SECRET=替换为足够长的随机字符串
```

默认监听 `3001`，数据保存在 Docker volume。公网部署必须配置 HTTPS/WSS 反向代理。

### Release 服务端包

从 GitHub Release 下载 `devfleet-server.zip`，安装 Node.js 20.19+ 后运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-server.ps1
```

## 绑定设备

1. 主控电脑安装 DevFleet，填写服务器地址并注册账号。
2. 在“设备管理”生成绑定码，通过“本机设备代理”先绑定主控电脑，并在设备列表把它设为主设备。
3. 再为每台目标电脑生成一个 10 分钟有效的一次性绑定码。
4. 目标电脑安装同一个 DevFleet Windows 客户端，无需登录主账号，打开“本机设备代理”。
5. 输入服务器地址和各自的绑定码。
6. 目标电脑会显示绑定账号、主设备名称、**主设备指定的开发工具**、连接状态和本机工具状态；主设备变更会自动同步。

绑定后服务器只保存设备令牌的 SHA-256 摘要。解除绑定或主设备删除设备时，令牌立即吊销且 WebSocket 被关闭。

### 指定每台设备的开发工具

在控制台 **设备管理** 中，为每台已绑定设备选择一种开发工具（Trae / Codex / Cursor / Claude Code），**默认 Trae**。此设置保存在服务端，目标设备代理会通过 WebSocket 实时同步。创建任务时，各在线设备按各自指定的工具接收子任务，分支名形如 `devfleet/trae/sub-1-xxxxxx`。

## 接入 Trae / Codex / Cursor

从 GitHub Release 下载并解压 `devfleet-mcp.zip`，在桌面控制台「MCP 接入」页面填写文件路径。页面会检测每个客户端的 `未安装 / 未配置 / 已配置 / 需要更新 / 检测失败` 状态，并提供一键配置：

- Trae / Trae CN：合并写入用户级 `mcp.json`，保留已有 MCP。
- Codex：通过官方 `codex mcp` CLI 写入用户配置，CLI 与 IDE 共用。
- Cursor：合并写入 `~/.cursor/mcp.json`，保留已有 MCP。
- Claude Code：通过官方 `claude mcp add-json --scope user` 写入用户配置。

浏览器控制台不能直接修改本机文件，会降级为 deeplink 或复制命令/JSON。配置预览会隐藏令牌，复制和一键配置仍使用完整值。

MCP 提供以下工具：

- `devfleet_list_devices`：读取真实在线和工具状态。
- `devfleet_dispatch_task`：向在线设备派发 Git 代码任务。
- `devfleet_get_task`：读取任务、日志、分支和进度。
- `devfleet_wait_for_task`：等待多设备任务完成。
- `devfleet_merge_task`：在主设备真实 fetch、merge、push，成功后才标记已合并。

## 本地开发

```bash
npm install
npm run dev
npm run tauri:dev
```

验证命令：

```bash
npm run check
npm run lint
npm test
npm run server:build
npm run build
cd src-tauri && cargo test
```

## GitHub Windows 安装包

`.github/workflows/release.yml` 会在推送 `v*` 标签时构建并发布：

- Windows MSI。
- Windows NSIS setup EXE。
- macOS/Linux 包。
- `devfleet-mcp.zip`。
- `devfleet-server.zip`。

```bash
git tag v1.0.0
git push origin main --tags
```

## 配置

- `PORT`：服务端端口，默认 `3001`。
- `JWT_SECRET`：生产环境必填。
- `TRUST_PROXY`：位于一个可信反向代理后时设为 `1`，用于正确识别限流 IP。
- `DEVFLEET_DB_FILE`：数据文件路径。
- `DEVFLEET_API_URL`：MCP 使用的服务地址。
- `DEVFLEET_TOKEN`：MCP 使用的登录令牌。
- `VITE_API_BASE_URL`：可选的客户端默认服务地址，用户可在登录页覆盖。
- `VITE_WS_BASE_URL`：可选的客户端默认 WebSocket 地址。

## 官方能力依据

- [Trae 添加 MCP 服务](https://docs.trae.ai/ide/add-mcp-servers)
- [Trae MCP 文档](https://docs.trae.ai/ide/model-context-protocol)
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)
- [Codex MCP 配置](https://developers.openai.com/codex/mcp)
- [Cursor MCP 安装](https://cursor.com/docs/context/mcp)
