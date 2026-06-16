/** 从任务状态与日志推导 E2E 流水线阶段（对齐 showcase step pills） */

export type PipelineStepId =
  | 'dispatch'
  | 'computer_use'
  | 'trae'
  | 'wait'
  | 'merge';

export type PipelineStep = {
  id: PipelineStepId;
  label: string;
  shortLabel: string;
  state: 'pending' | 'active' | 'done' | 'failed';
};

const STEP_DEFS: Array<{ id: PipelineStepId; label: string; shortLabel: string }> = [
  { id: 'dispatch', label: '② dispatch_task', shortLabel: '派发' },
  { id: 'computer_use', label: '③ computer_use', shortLabel: 'Computer Use' },
  { id: 'trae', label: '④ Trae 改码', shortLabel: 'Trae' },
  { id: 'wait', label: '⑤ wait_for_task', shortLabel: '等待' },
  { id: 'merge', label: '⑥ merge_task', shortLabel: '合并' },
];

type SubTaskLike = {
  status: string;
  progress?: number;
  logs?: Array<{ content: string; level?: string }>;
};

type TaskLike = {
  status: string;
  merge_commit_sha?: string;
  subTasks: SubTaskLike[];
};

function allLogs(task: TaskLike): string {
  return task.subTasks
    .flatMap((st) => st.logs || [])
    .map((log) => log.content)
    .join('\n');
}

function hasLogMatch(task: TaskLike, pattern: RegExp): boolean {
  return pattern.test(allLogs(task));
}

function anySubFailed(task: TaskLike): boolean {
  return task.subTasks.some((st) => st.status === 'failed');
}

function avgProgress(task: TaskLike): number {
  if (task.subTasks.length === 0) return 0;
  return Math.round(
    task.subTasks.reduce((sum, st) => sum + (st.progress || 0), 0) / task.subTasks.length,
  );
}

export function derivePipelineSteps(task: TaskLike): PipelineStep[] {
  const logs = allLogs(task);
  const failed = task.status === 'failed' || anySubFailed(task);
  const progress = avgProgress(task);

  const dispatchDone = task.subTasks.length > 0;
  const computerDone =
    hasLogMatch(task, /\[pipeline:computer_use\].*已自动打开 Trae/) ||
    hasLogMatch(task, /已通过内置 Computer Use/) ||
    hasLogMatch(task, /\[pipeline:trae\]/) ||
    progress >= 40;
  const computerFailed =
    failed &&
    hasLogMatch(task, /\[pipeline:computer_use\].*失败/) &&
    !computerDone;
  const traeDone =
    hasLogMatch(task, /\[pipeline:trae\].*检测到/) ||
    hasLogMatch(task, /检测到 Trae Agent 代码变更/) ||
    task.subTasks.some((st) => st.status === 'completed' && (st.progress || 0) >= 80);
  const waitDone =
    task.status === 'completed' ||
    task.status === 'merged' ||
    task.subTasks.every((st) => st.status === 'completed');
  const mergeDone = task.status === 'merged' || Boolean(task.merge_commit_sha);

  const states: Record<PipelineStepId, PipelineStep['state']> = {
    dispatch: dispatchDone ? 'done' : 'active',
    computer_use: computerFailed
      ? 'failed'
      : computerDone
        ? 'done'
        : dispatchDone
          ? 'active'
          : 'pending',
    trae: failed && !traeDone && computerDone
      ? 'failed'
      : traeDone
        ? 'done'
        : computerDone
          ? 'active'
          : 'pending',
    wait: waitDone ? 'done' : traeDone || progress >= 40 ? 'active' : 'pending',
    merge: mergeDone ? 'done' : waitDone ? 'active' : 'pending',
  };

  if (failed && !mergeDone && waitDone) {
    states.merge = 'failed';
  }

  return STEP_DEFS.map((def) => ({
    ...def,
    state: states[def.id],
  }));
}

export function pipelineSummary(steps: PipelineStep[]): string {
  const active = steps.find((s) => s.state === 'active');
  if (active) return `进行中: ${active.shortLabel}`;
  if (steps.every((s) => s.state === 'done')) return '闭环已完成';
  if (steps.some((s) => s.state === 'failed')) return '某阶段失败，请查看日志';
  return '等待开始';
}
