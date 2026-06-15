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

/** Cursor 设备用 Cursor Agent；其余默认走 Codex CLI */
export function deviceUsesCodexExecutor(devTool: DevTool): boolean {
  return devTool !== 'cursor';
}

export function deviceUsesCursorExecutor(devTool: DevTool): boolean {
  return devTool === 'cursor';
}

export function executorLabel(devTool: DevTool): string {
  return devTool === 'cursor' ? 'Cursor Agent CLI' : 'Codex CLI';
}
