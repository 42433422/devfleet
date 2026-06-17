/** 复制给任意 AI 助手，让其自动完成排比 Para MCP 接入 */

import { PRODUCT_NAME } from './brand';

import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildDevfleetStdioConfig,
  buildTraeInstallLinks,
  type DevfleetMcpOptions,
  type TraeVariant,
} from './mcpInstall';

export type McpSetupPromptOptions = DevfleetMcpOptions & {
  platform?: 'windows' | 'unix';
  traeVariant?: TraeVariant;
};

export function buildMcpAutoSetupPrompt(options: McpSetupPromptOptions): string {
  const mcpPath = String(options.mcpPath || '').trim();
  const apiUrl = String(options.apiUrl || '').trim().replace(/\/$/, '');
  const token = String(options.token || '').trim();
  const platform = options.platform ?? 'unix';
  const traeVariant = options.traeVariant ?? 'cn';
  const isMac = platform === 'unix' && typeof navigator !== 'undefined'
    && navigator.platform.toLowerCase().includes('mac');
  const isWin = platform === 'windows';

  const stdio = buildDevfleetStdioConfig({ mcpPath, apiUrl, token });
  const cursor = buildCursorInstallLinks({ mcpPath, apiUrl, token });
  const trae = buildTraeInstallLinks({ mcpPath, apiUrl, token }, traeVariant);
  const codexCmd = buildCodexMcpCommand({ mcpPath, apiUrl, token }, platform);

  const cursorPaths = isMac
    ? '~/.cursor/mcp.json 或 ~/Library/Application Support/Cursor/User/mcp.json'
    : isWin
      ? '%USERPROFILE%\\.cursor\\mcp.json'
      : '~/.cursor/mcp.json 或 ~/.config/Cursor/User/mcp.json';

  const traePaths = traeVariant === 'cn'
    ? (isMac
      ? '~/Library/Application Support/Trae CN/User/mcp.json（或 TRAE SOLO CN）'
      : isWin
        ? '%APPDATA%\\Trae CN\\User\\mcp.json'
        : '~/.config/Trae CN/User/mcp.json')
    : (isMac
      ? '~/Library/Application Support/Trae/User/mcp.json'
      : '~/.config/Trae/User/mcp.json');

  const claudePaths = isMac
    ? '~/.claude.json 或 ~/Library/Application Support/Claude/claude_desktop_config.json'
    : '~/.claude.json';

  return `请立即帮我在本机完成 ${PRODUCT_NAME} MCP 接入。不要只给教程——请直接写入配置文件或执行命令，完成后调用 devfleet_list_devices 验证并汇报结果。

## 你要做的事
1. 判断我当前使用的 AI 客户端（Cursor / Trae CN / Trae / Codex CLI / Claude Code / 其他）
2. 按下方对应方式写入 ${PRODUCT_NAME} MCP 配置（合并到已有 mcpServers，保留其他 server）
3. 若 MCP 文件不存在：从 https://github.com/42433422/devfleet/releases/latest 下载 devfleet-mcp.zip 解压到合适目录，或让用户确认已解压
4. 配置完成后调用 MCP 工具 devfleet_list_devices；成功则回复「${PRODUCT_NAME} MCP 已就绪」+ 在线设备列表

## 连接参数（必须使用以下值）
- MCP 入口文件: ${mcpPath}
- ${PRODUCT_NAME} API: ${apiUrl}
- DEVFLEET_TOKEN: ${token || `（用户需在 ${PRODUCT_NAME} Integration 页复制 JWT）`}

## stdio 配置（所有客户端共用）
${JSON.stringify({ mcpServers: { devfleet: stdio } }, null, 2)}

---

### Cursor
- 配置文件: ${cursorPaths}
- 写入上述 JSON（合并 mcpServers.devfleet）
- 或打开安装链接（若支持）: ${cursor.deeplink}
- 完成后重启 Cursor / 刷新 MCP

### Trae ${traeVariant === 'cn' ? 'CN' : ''}
- 配置文件: ${traePaths}
- 写入 JSON 同上；或通过 MCP 导入 deeplink: ${trae.deeplink}
- 完成后在 Trae 设置 → MCP 确认 devfleet 已启用

### Codex CLI
- 在终端执行:
${codexCmd}
- 或手动编辑 Codex MCP 配置加入 devfleet server

### Claude Code / Claude Desktop
- 配置文件: ${claudePaths}
- 在 mcpServers 中加入 devfleet（JSON 同上）

---

## 验证
devfleet_list_devices() → 应返回 devices 数组（至少包含已绑定设备）

## 注意
- DEVFLEET_TOKEN 是用户 JWT，勿泄露到公开仓库
- MCP 必须跑在主设备本机（API 通常为 localhost）
- 配置与「设备管理」里的工作设备 Agent 无关；MCP 只负责主设备调度`;
}
