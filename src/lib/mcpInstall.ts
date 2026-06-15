/** DevFleet MCP 多客户端安装配置（Trae / Codex / Cursor） */

export const DEVFLEET_MCP_SERVER_NAME = 'devfleet';

export type McpStdioConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type DevfleetMcpOptions = {
  mcpPath: string;
  apiUrl: string;
  token?: string;
};

export function buildDevfleetStdioConfig(options: DevfleetMcpOptions): McpStdioConfig {
  const apiUrl = String(options.apiUrl || '').trim().replace(/\/$/, '');
  return {
    command: 'node',
    args: [options.mcpPath],
    env: {
      DEVFLEET_API_URL: apiUrl,
      DEVFLEET_TOKEN: String(options.token || '').trim(),
    },
  };
}

export function wrapMcpJson(serverName: string, serverConfig: McpStdioConfig): string {
  return JSON.stringify({ mcpServers: { [serverName]: serverConfig } }, null, 2);
}

export function buildTraeMcpJson(options: DevfleetMcpOptions): string {
  return wrapMcpJson(DEVFLEET_MCP_SERVER_NAME, buildDevfleetStdioConfig(options));
}

export function buildCursorMcpJson(options: DevfleetMcpOptions): string {
  return buildTraeMcpJson(options);
}

function toBase64Json(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  return btoa(unescape(encodeURIComponent(json)));
}

export function buildCursorDeeplink(serverName: string, serverConfig: McpStdioConfig): string {
  const configB64 = toBase64Json(serverConfig);
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(serverName)}&config=${encodeURIComponent(configB64)}`;
}

export function buildCursorWebInstallUrl(serverName: string, serverConfig: McpStdioConfig): string {
  const configB64 = toBase64Json(serverConfig);
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(serverName)}&config=${encodeURIComponent(configB64)}`;
}

export function buildCursorInstallLinks(options: DevfleetMcpOptions) {
  const config = buildDevfleetStdioConfig(options);
  return {
    config,
    mcpJson: wrapMcpJson(DEVFLEET_MCP_SERVER_NAME, config),
    deeplink: buildCursorDeeplink(DEVFLEET_MCP_SERVER_NAME, config),
    webUrl: buildCursorWebInstallUrl(DEVFLEET_MCP_SERVER_NAME, config),
  };
}

export function buildCodexMcpCommand(options: DevfleetMcpOptions, platform: 'windows' | 'unix' = 'unix'): string {
  const apiUrl = String(options.apiUrl || '').trim().replace(/\/$/, '');
  const token = String(options.token || '').trim();
  const mcpPath = options.mcpPath;
  const quote = platform === 'windows'
    ? (value: string) => `"${value.replace(/"/g, '\\"')}"`
    : (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `codex mcp add ${DEVFLEET_MCP_SERVER_NAME} --env DEVFLEET_API_URL=${quote(apiUrl)} --env DEVFLEET_TOKEN=${quote(token)} -- node ${quote(mcpPath)}`;
}

/** 按平台返回 MCP 包默认解压路径 */
export function defaultMcpPath(): string {
  if (typeof navigator === 'undefined') return '/opt/devfleet/mcp/devfleet-mcp.mjs';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'C:\\DevFleet\\mcp\\devfleet-mcp.mjs';
  if (platform.includes('mac')) return '/Users/Shared/DevFleet/mcp/devfleet-mcp.mjs';
  return '/opt/devfleet/mcp/devfleet-mcp.mjs';
}
