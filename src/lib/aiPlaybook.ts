/** AI 指挥官闭环剧本 — 与 devfleet-showcase.html 演示规格对齐，供 Integration 页复制给 Cursor/Trae AI */

export type PlaybookOptions = {
  repoUrl?: string;
  mergeWorkspace?: string;
  deviceHint?: string;
};

export function buildAiCommanderPlaybook(options: PlaybookOptions = {}): string {
  const repoUrl = options.repoUrl?.trim() || 'https://github.com/your-org/your-repo.git';
  const mergeWorkspace =
    options.mergeWorkspace?.trim() || '/Users/Shared/DevFleet/repos/my-project';
  const deviceHint = options.deviceHint?.trim() || '<online-trae-device-id>';

  return `# DevFleet E2E 最小闭环 — AI 必须按序执行，用户只说一句话
# 用户示例: 「用 DevFleet 跑本机 E2E：README 追加测试行，Trae 改码，merge 到 main」

## 核心原则
- 禁止问用户「要不要打开 Trae」——工作设备 Agent 会在 dispatch 后自动 Computer Use
- 只有日志出现 [pipeline:computer_use] 失败时，才调用 devfleet_computer_use_start_trae_task 补救
- 全程零手动复制 prompt

1. devfleet_list_devices()
   → 确认 Trae 工作设备 online + devTool=trae
   → 离线则报错并提示启动 DevFleet 桌面端 Agent

2. devfleet_dispatch_task({
     title: "E2E: README 追加测试行",
     prompt: "在 README.md 末尾追加一行：\\n\\n<!-- devfleet-e2e test line -->",
     device_id: "${deviceHint}",
     repo_url: "${repoUrl}",
     branch: "main"
   })
   → 每次 dispatch 只创建一个子任务；多设备并行时 AI 自行多次调用并传 task_id
   → dispatch 后工作设备 Agent 自动: activate Trae → 点「新任务」→ 粘贴 prompt
   → AI 无需再调 computer_use，除非任务日志显示 CU 失败

3. # Trae Agent 在 agent-workspace 改码、commit、push 子分支
   # AI 不介入，只等待

4. devfleet_wait_for_task({ task_id, timeout_ms: 600000 })
   → status=completed 后继续

5. devfleet_merge_task({
     task_id,
     workspace_path: "${mergeWorkspace}",
     push: true
   })
   → 汇报各步耗时 + merge commit hash

# 期望体验: MCP 调用 ms 级 · Computer Use ~2s · Trae 改码 ~10-60s · 全程零手动`;
}

export function buildCursorRulePlaybook(): string {
  return `---
description: DevFleet E2E 闭环 — 用户提到 DevFleet/派发/Trae 改码时自动遵循
globs:
alwaysApply: false
---

当用户使用 DevFleet MCP 跑多设备编码闭环时：

1. 按序调用 list_devices → dispatch_task → wait_for_task → merge_task
2. **不要**在 dispatch 后让用户手动打开 Trae 或复制 prompt；Trae 工作设备 Agent 会自动 Computer Use
3. 仅当任务日志含 \`[pipeline:computer_use] 自动控制失败\` 时，才调用 devfleet_computer_use_start_trae_task 补救
4. wait_for_task 超时前不要中断；完成后 merge 并汇报各阶段耗时
5. merge 失败时检查 workspace_path 是否为绝对路径且 origin 与任务 repo_url 一致`;
}
