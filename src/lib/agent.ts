export interface LocalToolStatus {
  toolName: 'trae' | 'codex' | 'cursor' | 'claude_code';
  status: 'running' | 'idle' | 'not_installed';
  installed: boolean;
  executable?: string;
  currentTask?: string;
}

export interface AgentConfig {
  apiBaseUrl: string;
  deviceId: string;
  deviceName: string;
  controllerId: string;
  controllerEmail: string;
  controllerDeviceId?: string;
  controllerDeviceName?: string;
  workspaceRoot: string;
  devTool: string;
  defaultEditor: string;
  executor: string;
}

export interface AgentStatus {
  configured: boolean;
  connected: boolean;
  config?: AgentConfig;
  tools: LocalToolStatus[];
  runningTask?: string;
  lastError?: string;
}

export const isDesktopApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (!isDesktopApp()) throw new Error('本机代理只能在 DevFleet 桌面客户端中运行');
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
};

export interface MergeTaskResult {
  success: boolean;
  commit: string;
  branch: string;
  mergedBranches: string[];
  pushed: boolean;
}

export const agentApi = {
  status: () => invoke<AgentStatus>('agent_status'),
  bind: (data: { apiBaseUrl: string; bindCode: string; deviceName: string; workspaceRoot: string }) => invoke<AgentStatus>('agent_bind', data),
  start: () => invoke<AgentStatus>('agent_start'),
  stop: () => invoke<AgentStatus>('agent_stop'),
  unbind: () => invoke<AgentStatus>('agent_unbind'),
  /** 启动本机 IDE（Trae / Cursor / Claude Code） */
  startTool: (tool: string, workspace: string) => invoke<void>('agent_open_tool', { tool, workspace }),
  openTool: (tool: string, workspace: string) => invoke<void>('agent_open_tool', { tool, workspace }),
  mergeTask: (data: { workspacePath: string; branch: string; subtaskBranches: string[]; push?: boolean }) =>
    invoke<MergeTaskResult>('agent_merge_task', {
      workspacePath: data.workspacePath,
      branch: data.branch,
      subtaskBranches: data.subtaskBranches,
      push: data.push ?? true,
    }),
};
