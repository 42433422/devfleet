【类别】TRAE AI 创造力大赛 - 复赛专区

**【标签】** 学习工作

**【标题】** 学习工作赛道 ｜ DevFleet（排比 Para）—— AI 多设备并行编码调度系统

---

## 一、自己介绍（个人参赛）

> 本部分不计入评分，仅用于赛事后续对优秀作品的展示与推荐。

【请补充你的个人介绍，建议包含以下要素】

- **你是谁**：行业 / 职业 / 身份（如独立开发者 / 后端工程师 / 大三学生……）
- **为什么想做这个作品**：一句话讲清动机（例如：「我有 3 台电脑，但 AI 只能用 1 台，剩下的全在闲置」）
- **你擅长什么**：技术栈 / 擅长方向（如全栈、Rust、Tauri、Node 服务端……）
- **Vibe Coding / 编程年限**：如 5 年
- **年龄**（可选）
- **性格 / 特点标签**（可选，如「致力于把 AI 当员工管的开发者」「最爱抠 E2E 闭环的独立开发者」）

---

## 二、产品简介（复赛版）

### 是什么

**DevFleet（排比 Para）** 是一款真实运行的多设备 AI 编码调度系统，由四部分组成：

1. **Tauri 桌面控制台**（主设备调度 + 合并中枢）
2. **内置于同一桌面程序的设备代理**（工作设备执行端）
3. **支持 WebSocket 的自托管协调服务**（设备状态、任务派发、日志回传）
4. **可接入 Trae / Codex / Cursor 的 STDIO MCP 服务**（主设备 AI 调度入口）

一句话定位：**让 AI 自己调度多台电脑并行写代码，完成后自动 Git 合并**——把单机多代理模式升级为多设备并行模式。

### 面向谁

- **核心用户**：同时拥有多台电脑（办公机 + 家用机 + 云服务器）、并已在用 Trae / Cursor / Codex / Claude Code 等 AI 编程工具的开发者与小型团队
- **典型场景**：
  - 一个人有 3 台机器，想让 AI 同时改前端 / 后端 / 测试，而不是排队跑
  - 团队想把同事的闲置电脑临时组成「AI 编码舰队」冲刺一个迭代
  - 独立开发者想用云服务器 + 本机组合，把长任务拆成并行子任务

### 完整功能

**核心工作流**：主设备在「设备管理」为每台工作设备指定一种开发工具（Trae / Codex / Cursor / Claude Code，默认 Trae）→ 主设备创建任务 → 任务只派发给在线工作设备（有非主设备在线时主设备不执行子任务）→ Trae 设备先准备同一 Git 工作区，再由内置 Computer Use 打开 Trae、点「新任务」并写入 prompt → 各设备完成后 Git push 独立分支 → 主设备在任务详情或 MCP 中 fetch/merge/push 合并各分支。

**功能清单与用户使用路径**：

| 模块 | 功能点 |
|------|--------|
| 登录 | 邮箱登录/注册、访客自动登录（无需注册即可体验） |
| 设备管理 | 设备列表、在线/离线状态、WebSocket 连接、软件状态面板、生成 10 分钟一次性绑定码、为每台设备指定开发工具 |
| 设备代理 | 本机代理绑定、主设备同步、工具状态上报、令牌 SHA-256 存储、解绑即时吊销 |
| 任务控制台 | 任务创建、智能分发、执行监控、实时日志、进度条、Git 分支管理 |
| MCP 接入 | Trae / Codex / Cursor 一键配置、JSON 配置生成、deeplink 安装 |
| Computer Use | 自动激活 Trae、点击「新任务」、粘贴 prompt、Enter 提交（macOS / Windows） |
| Git 合并 | 自动 fetch / merge / push、冲突 abort 并报告、分支命名 `devfleet/{tool}/sub-{n}-{hash}` |
| 网络穿透 | localtunnel 内置支持，可从公网调度家里设备 |
| 部署 | Docker Compose 一键部署、Release 服务端包、GitHub Actions 自动构建多平台安装包 |

**8 个 MCP 工具（AI 指挥官操控台）**：

1. `devfleet_list_devices` — 查看舰队状态
2. `devfleet_dispatch_task` — 派发任务（AI 自行拆分与指定 device_id）
3. `devfleet_get_task` — 查询任务进度
4. `devfleet_wait_for_task` — 等待任务完成
5. `devfleet_merge_task` — 合并分支（真实 fetch/merge/push）
6. `devfleet_next_task` — 工作设备读取分配给自己的任务
7. `devfleet_computer_use_start_trae_task` — Computer Use 自动向 Trae 输入框写入任务
8. `devfleet_report_task_progress` — Trae Agent 回写日志与阶段进度

**典型使用路径**（AI 指挥官 6 步闭环）：

```
用户一句话 → AI 调用 MCP：
① list_devices        确认 Trae 设备在线
② dispatch_task       派发到 bare.git
③ computer_use        自动打开 Trae、点新任务、写入 prompt（禁止让用户手动复制）
④ Trae Agent 改码     工作设备侧 next_task / report_progress
⑤ wait_for_task       轮询等待完成
⑥ merge_task          merge 到 main 并 push
```

> 【建议配图 1：产品架构图 / 主界面截图】
> 【建议配图 2：8 个 MCP 工具面板截图】
> 【建议配图 3：任务执行监控 + Git 合并状态截图】
> 【建议配图 4：功能流程图（可用 PRD 中的 mermaid 图导出）】

### 相比初赛 Demo 的升级

> 【请确认 / 修正以下复赛升级点，以下基于代码现状（v1.4.11）推断】

- **从「概念演示」到「真实可部署成品」**：初赛 Demo 仅在本机跑通 MCP 调用链路；复赛成品已具备完整部署链路——Docker Compose 一键起服务、GitHub Actions 自动构建 Windows MSI/NSIS、macOS/Linux 安装包、`devfleet-mcp.zip`、`devfleet-server.zip`，公开 Release 页可下载。
- **新增 Computer Use 自动化**：初赛需手动把 prompt 复制进 Trae；复赛内置 Computer Use（macOS 辅助功能 / Windows UI Automation），AI 自动激活 Trae、点「新任务」、粘贴并提交，实现「用户只说一句话」的零手动体验。
- **从单工具到四工具并行**：初赛仅支持 Trae；复赛扩展为 Trae / Codex / Cursor / Claude Code 四种工具，每台设备可独立指定，分支命名按工具区分。
- **新增工作设备侧 MCP 工具**：`devfleet_next_task` + `devfleet_report_task_progress`，让 Trae Agent 能主动领取任务并回写进度，形成双向闭环。
- **安全与稳定性打磨**：设备令牌 SHA-256 存储、解绑即时吊销、JWT 鉴权、限流、WebSocket 心跳容错（fix(ws): tolerate active device pong delays）、调度优先级修复（fix(dispatch): prioritize self-maintenance control tasks）。
- **新增 E2E 最小闭环 + 计时**：`npm run e2e:loop` 可本机计时验证全链路，含 `--auto-touch` 离线保底，无需 Trae / 外网也能跑通 Git/merge。
- **新增 showcase 网页演示**：`devfleet-showcase.html` 把「AI 怎么用 DevFleet」做成可播放的网页剧场，API 在线时自动切 LIVE 模式并显示真实计时。

---

## 三、产品演示视频

【请补充 1–5 分钟录屏链接（抖音 / Bilibili 等公开链接），清晰展示完整核心流程与亮点】

演示建议覆盖：登录 → 绑定设备 → 指定工具 → 创建任务 → AI 调用 MCP 派发 → Computer Use 写入 Trae → 改码完成 → 自动 merge → 计时汇总。

---

## 四、产品创作历程

### 灵感来源

AI 编程工具已经能独立完成复杂任务，但它们都被困在单台机器上——**你有 3 台电脑，AI 只能用 1 台**。每台设备上的 AI 编码工具互不通信：办公电脑、家用台式、云服务器各自为战；前端改完才能改后端，明明可以并行却只能串行排队；即使手动在每台电脑上分别启动 AI，最终还要自己 Git merge。

于是问题变成：**能不能让 AI 自己当「舰队指挥官」，自己拆任务、分给多台设备、再自己合并？**

### 关键问题与解决思路

1. **跨物理设备调度怎么做？**
   抛弃「单机多 Agent」思路，改为「主设备 + 工作设备」星型架构：主设备跑 Tauri 控制台 + MCP，工作设备跑轻量 Agent，之间用 WebSocket 长连接。主设备 AI 通过 MCP 工具决定怎么拆、分给谁、何时合并——**调度逻辑由 AI 决定，不是规则写死**。

2. **Trae 没有命令行，怎么自动发任务？**
   这是最大难点。Trae 是 GUI IDE，不像 Codex 有 CLI。解决方式是**内置 Computer Use**：通过进程匹配激活 Trae CN、模拟点击「新任务」、写入 prompt、Enter 提交。macOS 走辅助功能 API，Windows 走 PowerShell + UI Automation。让用户「只说一句话」，不用手动复制 prompt。

3. **多设备改同一仓库怎么不冲突？**
   每台设备在独立分支上工作，分支名形如 `devfleet/trae/sub-1-a3f2`，完成后各自 `git push`。主设备在独立 merge-workspace 里 `fetch → merge → push`，冲突时自动 `abort` 并报告，不破坏代码库。

4. **演示环境不稳怎么办？**
   做 `--auto-touch` 离线保底：跳过 Trae，脚本自动写测试标记文件、commit、push、merge，验证 Git 链路始终可跑。现场即使 Trae 没装也能演示核心闭环。

### 重要的设计与技术决策

- **为什么用 Tauri 而不是纯 Web**：桌面端需要 Computer Use 控制本机 GUI、需要本地 Git 仓库做最终合并，Tauri 让 Rust 原生能力 + Web 前端共存于一个产物。
- **为什么 MCP 而不是自定义协议**：MCP 是 Trae / Cursor / Claude Code / Codex 共认的标准，一套工具同时兼容四个 AI 编程工具，AI 自己就会调，不用教。
- **为什么服务端必须自托管而不是 Serverless**：常驻 WebSocket 是核心，Vercel Serverless 跑不了。用 Docker Compose + SQLite 保证单实例有持久磁盘。
- **为什么设备令牌只存 SHA-256 摘要**：服务端被攻破也不能拿到原始令牌，解绑即吊销、WebSocket 即断。

---

## 五、TRAE 实践过程

> 以下为使用 TRAE 完成产品开发的完整流程，附关键任务对话 Session ID 与开发截图。

### 整体开发流程

1. **需求与架构**：在 TRAE 中用自然语言描述「多设备 AI 编码调度系统」，TRAE 协助生成 PRD（`.trae/documents/prd.md`）与技术架构文档（`.trae/documents/tech-architecture.md`），含数据模型、API 定义、mermaid 架构图。
2. **脚手架与前端**：基于 `vite-init` react-express-ts 模板，TRAE 协助搭建 React 18 + Tailwind + Zustand 前端，生成登录 / 设备管理 / 任务控制台 / 任务详情等页面。
3. **后端服务**：TRAE 协助编写 Express + TypeScript（ESM）服务端，含 auth / devices / tasks / collab / tunnel / mods 路由、SQLite schema 与迁移、WebSocket manager。
4. **MCP 服务**：TRAE 协助基于 `@modelcontextprotocol/sdk` 实现 8 个 STDIO MCP 工具，并用 esbuild 打包为 `devfleet-mcp.mjs`。
5. **Tauri 桌面端**：TRAE 协助编写 Rust 侧（`src-tauri/src`）agent / computer_use / mcp / network / server 模块，处理进程、UI 自动化、网络。
6. **Computer Use**：TRAE 协助实现 macOS 辅助功能 + Windows UI Automation 双平台 Trae 自动化，含 PowerShell 脚本 `trae-new-task.ps1`。
7. **E2E 与测试**：TRAE 协助编写 `scripts/e2e-minimal-loop.ts` 计时闭环、`tests/*.test.ts`（含 mcp / dispatch / merge / ws-heartbeat / sqlite-migrate / security-headers 等 20+ 测试）。
8. **部署与发布**：TRAE 协助编写 Dockerfile / docker-compose / GitHub Actions（build / release / upgrade-ci）、服务端打包脚本、`devfleet-showcase.html` 演示页。

### 关键任务对话 Session ID（≥3）

> 【请补充至少 3 个 TRAE 对话 Session ID，用于证明作品由 TRAE 开发完成】

- Session ID 1：【填写，建议选「PRD + 技术架构生成」相关对话】
- Session ID 2：【填写，建议选「MCP 8 工具实现」相关对话】
- Session ID 3：【填写，建议选「Computer Use 双平台自动化」相关对话】
- Session ID 4（加分）：【填写，建议选「E2E 闭环 + 测试」相关对话】

### 开发关键步骤截图（≥3 张）

> 【请补充至少 3 张截图，以下为建议选取的关键步骤】

- 截图 1【建议】：TRAE 协助生成 PRD / 技术架构文档的对话截图
- 截图 2【建议】：TRAE 协助实现 8 个 MCP 工具的对话截图
- 截图 3【建议】：TRAE 协助实现 Computer Use 自动控制 Trae 的对话截图
- 截图 4【建议】：TRAE 协助编写 E2E 闭环与测试的对话截图
- 截图 5【建议】：TRAE 协助配置 GitHub Actions 多平台发布流水线的对话截图

---

## 六、加分项

### 技术方案分享

**技术栈**：

- **前端**：React 18 + TailwindCSS 3 + Vite 6 + Zustand 5 + React Router 7
- **后端**：Express 4 + TypeScript（ESM）+ ws（WebSocket）
- **数据层**：SQLite（better-sqlite3）嵌入式数据库 + 文件系统 Git 仓库
- **桌面端**：Tauri 2 + Rust（agent / computer_use / mcp / network / server 模块）
- **MCP**：`@modelcontextprotocol/sdk` 1.29 + esbuild 打包为 ESM 单文件
- **构建发布**：GitHub Actions（build / release / upgrade-ci）、Docker Compose

**关键实现思路**：

- **AI 自主调度**：`devfleet_dispatch_task` 每次调用只派发一个子任务，AI 自己理解代码结构后决定怎么拆、分给哪台设备，不是按换行符傻拆。
- **Computer Use 闭环**：进程名匹配 → 激活 Trae CN → 模拟点击「新任务」→ 写入 prompt → Enter，全程无需用户介入。
- **Git 分支隔离**：`devfleet/{tool}/sub-{n}-{hash}` 命名规范，各设备独立 push，主设备独立 merge-workspace 统一合并，冲突 abort 不破坏主干。
- **网页即规格**：`devfleet-showcase.html` 把 AI 指挥官剧本（playbook）直接写在网页里，AI 读到即可执行闭环，API 在线时自动切 LIVE 模式显示真实计时。

### 商业化与社会价值

- **商业化方向**：面向多设备开发者与小团队推出 SaaS 协调服务（自托管免费 / 托管服务收费）；面向企业推出私有化部署版（设备池共享、团队权限、审计日志）。
- **社会价值**：让闲置电脑变成 AI 编码算力，提升单兵开发者产出；为小型团队提供低成本的「AI 编码舰队」方案，降低并行开发门槛。

### 产品迭代规划

- 支持更多 AI 编程工具（Windsurf / Augment 等）
- 设备负载感知调度（按 CPU / 内存 / 当前任务量智能分配）
- Web 控制台（无需桌面客户端即可调度）
- 团队设备池与权限管理
- 合并冲突 AI 自动解决
- 任务依赖图与并行度可视化

---

## 附：验证命令与本机复现

```bash
# 全新环境验证（空 DB + schema + guest）
npm run server:build
npm run demo:fresh

# E2E 最小闭环（含计时）
npm run e2e:setup
npm run e2e:loop -- --auto-touch

# 健康检查
curl -s http://127.0.0.1:3001/api/health
# 期望: {"success":true,"message":"ok"}

# 测试与构建
npm run check
npm run lint
npm test
npm run build
cd src-tauri && cargo test
```

公开 Release 页：`https://github.com/42433422/devfleet/releases/latest`
