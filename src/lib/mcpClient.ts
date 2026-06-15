import { isDesktopApp } from '@/lib/agent';

export type McpClientTool = 'trae' | 'codex' | 'cursor' | 'claude_code';
export type McpClientState = 'not_installed' | 'not_configured' | 'configured' | 'needs_update' | 'error';
export type TraeVariant = 'cn' | 'intl';

export interface McpClientStatus {
  tool: McpClientTool;
  installed: boolean;
  configured: boolean;
  matchesCurrent: boolean;
  state: McpClientState;
  detail?: string;
}

export interface McpClientOptions {
  mcpPath: string;
  apiUrl: string;
  token: string;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopApp()) throw new Error('请在 DevFleet 桌面客户端中使用一键配置');
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

function commandArgs(options: McpClientOptions) {
  return {
    mcpPath: options.mcpPath,
    apiUrl: options.apiUrl,
    token: options.token,
  };
}

export const mcpClientApi = {
  isDesktop: isDesktopApp,
  ensureBundle: () => invoke<string>('ensure_mcp_bundle'),
  statuses: (options: McpClientOptions) =>
    invoke<McpClientStatus[]>('mcp_client_statuses', commandArgs(options)),
  install: (tool: McpClientTool, options: McpClientOptions) =>
    invoke<McpClientStatus>('install_mcp_client', { tool, ...commandArgs(options) }),
  /** 检测本机 Trae 版本（cn / intl） */
  detectTraeVariant: () =>
    invoke<TraeVariant>('detect_trae_variant'),
};
