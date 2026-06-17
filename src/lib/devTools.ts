export const DEV_TOOLS = ['trae', 'codex', 'cursor', 'claude_code'] as const;
export type DevTool = (typeof DEV_TOOLS)[number];
export const DEFAULT_DEV_TOOL: DevTool = 'trae';

export const DEV_TOOL_LABELS: Record<DevTool, string> = {
  trae: 'Trae',
  codex: 'Codex',
  cursor: 'Cursor',
  claude_code: 'Claude Code',
};

export function isDevTool(value: string): value is DevTool {
  return (DEV_TOOLS as readonly string[]).includes(value);
}

export function normalizeDevTool(value: unknown): DevTool {
  return typeof value === 'string' && isDevTool(value) ? value : DEFAULT_DEV_TOOL;
}

/** 主设备调度；有工作设备时任务只派发给非主设备 */
export function selectExecutionDevices<T extends { isPrimary?: boolean }>(devices: T[]): T[] {
  const workers = devices.filter((device) => !device.isPrimary);
  return workers.length > 0 ? workers : devices;
}

/** Cursor 设备用 Cursor Agent；Trae 优先 Trae Agent CLI，失败则 Computer Use；其余走 Codex CLI */
export function deviceUsesCodexExecutor(devTool: DevTool): boolean {
  return devTool !== 'cursor' && devTool !== 'trae';
}

export function deviceUsesCursorExecutor(devTool: DevTool): boolean {
  return devTool === 'cursor';
}

export function deviceUsesTraeExecutor(devTool: DevTool): boolean {
  return devTool === 'trae';
}

export function executorLabel(devTool: DevTool): string {
  if (devTool === 'cursor') return 'Cursor Agent CLI';
  if (devTool === 'trae') return 'Trae Agent CLI（Computer Use 兜底）';
  return 'Codex CLI';
}

/** 服务端 / 本机代理上报的工具运行态（idle = 已安装未启动） */
export type ToolApiStatus = 'not_installed' | 'idle' | 'running';

export type ToolRuntimeStatus = 'not_installed' | 'not_started' | 'started';

export const TOOL_RUNTIME_LABELS: Record<ToolRuntimeStatus, string> = {
  not_installed: '未安装',
  not_started: '未启动',
  started: '已启动',
};

/** 未安装时的提示（不依赖下载链接，用户自行安装即可） */
export const TOOL_INSTALL_HINTS: Record<DevTool, string> = {
  trae: 'Trae IDE 设备会回退 Computer Use；如需纯 CLI 请安装 TRAE Agent（github.com/bytedance/trae-agent，命令 trae-cli run），并设置 TRAE_CONFIG_FILE 环境变量',
  codex: '请安装 Codex CLI 并执行 codex login',
  cursor: '请安装 Cursor 或 Cursor Agent CLI（agent login）',
  claude_code: '请安装 Claude Code CLI 或桌面客户端',
};

export function normalizeToolRuntimeStatus(status: string): ToolRuntimeStatus {
  if (status === 'not_installed') return 'not_installed';
  if (status === 'running') return 'started';
  return 'not_started';
}

export function formatToolRuntimeLabel(status: string, currentTask?: string): string {
  if (status === 'running' && currentTask) return '执行中';
  return TOOL_RUNTIME_LABELS[normalizeToolRuntimeStatus(status)];
}

export function canStartTool(tool: {
  toolName: DevTool | string;
  status: string;
  installed?: boolean;
}): boolean {
  if (!tool.installed) return false;
  if (normalizeToolRuntimeStatus(tool.status) === 'started') return false;
  return tool.toolName !== 'codex';
}
