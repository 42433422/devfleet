/** 主设备合并任务：桌面本地 Git 或 MCP 话术 */

export type MergeTaskInput = {
  taskId: string;
  repoUrl: string;
  branch: string;
  workspacePath: string;
  subtaskBranches: string[];
  push?: boolean;
};

export function buildMergeMcpPrompt(input: MergeTaskInput): string {
  const branches = input.subtaskBranches.map((b) => `- ${b}`).join('\n');
  const push = input.push !== false;
  return `请帮我在主设备本地仓库完成 DevFleet 多设备分支合并，并确认成功。

## 任务信息
- task_id: ${input.taskId}
- 仓库: ${input.repoUrl}
- 基础分支: ${input.branch}
- 本地路径: ${input.workspacePath || '（请替换为主设备上该仓库的绝对路径）'}
- 是否推送: ${push ? '是' : '否'}

## 待合并分支
${branches || '- （无子任务分支）'}

## 说明
Trae 工作设备在 dispatch 后已自动 Computer Use，无需用户手动打开 Trae。
若子任务已全部 completed，直接合并即可。

## 请调用 MCP 工具
devfleet_merge_task({
  "task_id": "${input.taskId}",
  "workspace_path": "${input.workspacePath || '/path/to/repo'}",
  "push": ${push}
})

合并成功后告诉我 commit SHA 与各阶段耗时。`;
}

export function defaultMergeWorkspace(): string {
  if (typeof navigator === 'undefined') return '';
  const p = navigator.platform.toLowerCase();
  if (p.includes('win')) return 'C:\\DevFleet\\repos\\my-project';
  if (p.includes('mac')) return '/Users/Shared/DevFleet/repos/my-project';
  return '/opt/DevFleet/repos/my-project';
}
