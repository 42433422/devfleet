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

const DEFAULT_NO_PROXY_ENTRIES = [
  'localhost',
  '127.0.0.1',
  '::1',
  '.local',
  '*.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
] as const;

function isLanNoProxyHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) return true;
  const parts = normalized.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');
}

function lanHostFromUrl(value: string): string | null {
  try {
    const host = new URL(value).hostname;
    return isLanNoProxyHost(host) ? host : null;
  } catch {
    return null;
  }
}

function buildNoProxyValue(apiUrl: string): string {
  const entries: string[] = [...DEFAULT_NO_PROXY_ENTRIES];
  const host = lanHostFromUrl(apiUrl);
  if (host && !entries.some((entry) => entry.toLowerCase() === host.toLowerCase())) {
    entries.push(host);
  }
  return entries.join(',');
}

export function buildDevfleetStdioConfig(options: DevfleetMcpOptions): McpStdioConfig {
  const apiUrl = String(options.apiUrl || '').trim().replace(/\/$/, '');
  const noProxy = buildNoProxyValue(apiUrl);
  return {
    command: 'node',
    args: [options.mcpPath],
    env: {
      DEVFLEET_API_URL: apiUrl,
      DEVFLEET_TOKEN: String(options.token || '').trim(),
      NO_PROXY: noProxy,
      no_proxy: noProxy,
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

export type TraeVariant = 'cn' | 'intl';

export function buildTraeDeeplink(
  serverName: string,
  serverConfig: McpStdioConfig,
  variant: TraeVariant = 'cn',
): string {
  const configB64 = toBase64Json(serverConfig);
  const scheme = variant === 'cn' ? 'trae-cn' : 'trae';
  return `${scheme}://mcp/install?name=${encodeURIComponent(serverName)}&type=stdio&config=${encodeURIComponent(configB64)}`;
}

/** 旧版 deeplink 格式（兼容旧版 Trae） */
export function buildTraeLegacyDeeplink(
  serverName: string,
  serverConfig: McpStdioConfig,
  variant: TraeVariant = 'cn',
): string {
  const configB64 = toBase64Json(serverConfig);
  const scheme = variant === 'cn' ? 'trae-cn' : 'trae';
  return `${scheme}://trae.ai-ide/mcp-import?name=${encodeURIComponent(serverName)}&type=stdio&config=${encodeURIComponent(configB64)}`;
}

export function buildTraeInstallLinks(options: DevfleetMcpOptions, variant?: TraeVariant) {
  const config = buildDevfleetStdioConfig(options);
  const resolvedVariant = variant ?? detectTraeVariant();
  return {
    config,
    variant: resolvedVariant,
    mcpJson: wrapMcpJson(DEVFLEET_MCP_SERVER_NAME, config),
    deeplinkCn: buildTraeDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'cn'),
    deeplinkIntl: buildTraeDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'intl'),
    deeplink: buildTraeDeeplink(DEVFLEET_MCP_SERVER_NAME, config, resolvedVariant),
    legacyDeeplinkCn: buildTraeLegacyDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'cn'),
    legacyDeeplinkIntl: buildTraeLegacyDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'intl'),
  };
}

/** 根据本机安装情况自动检测 Trae 版本 */
export function detectTraeVariant(): TraeVariant {
  if (typeof navigator === 'undefined') return 'cn';
  const platform = navigator.platform.toLowerCase();
  // macOS: 检测 /Applications 下是否有 Trae CN
  if (platform.includes('mac')) {
    // 浏览器环境无法直接检测文件系统，默认 cn
    return 'cn';
  }
  // Windows / Linux 默认 cn
  return 'cn';
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
  const noProxy = buildNoProxyValue(apiUrl);
  const mcpPath = options.mcpPath;
  const quote = platform === 'windows'
    ? (value: string) => `"${value.replace(/"/g, '\\"')}"`
    : (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `codex mcp add ${DEVFLEET_MCP_SERVER_NAME} --env DEVFLEET_API_URL=${quote(apiUrl)} --env DEVFLEET_TOKEN=${quote(token)} --env NO_PROXY=${quote(noProxy)} --env no_proxy=${quote(noProxy)} -- node ${quote(mcpPath)}`;
}

/** 按平台返回 MCP 包默认解压路径 */
export function defaultMcpPath(): string {
  if (typeof navigator === 'undefined') return '/opt/devfleet/mcp/devfleet-mcp.mjs';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'C:\\DevFleet\\mcp\\devfleet-mcp.mjs';
  if (platform.includes('mac')) return '/Users/Shared/DevFleet/mcp/devfleet-mcp.mjs';
  return '/opt/devfleet/mcp/devfleet-mcp.mjs';
}
