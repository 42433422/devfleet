import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildDevfleetStdioConfig,
  buildTraeInstallLinks,
  buildTraeMcpJson,
  buildTraeDeeplink,
  buildTraeLegacyDeeplink,
  DEVFLEET_MCP_SERVER_NAME,
} from '../src/lib/mcpInstall.ts';

const sample = {
  mcpPath: 'C:\\DevFleet\\mcp\\devfleet-mcp.mjs',
  apiUrl: 'http://localhost:3001',
  token: 'test-token',
};

test('DevFleet stdio 配置包含 API 地址与令牌', () => {
  const cfg = buildDevfleetStdioConfig(sample);
  assert.equal(cfg.command, 'node');
  assert.deepEqual(cfg.args, [sample.mcpPath]);
  assert.equal(cfg.env.DEVFLEET_API_URL, 'http://localhost:3001');
  assert.equal(cfg.env.DEVFLEET_TOKEN, 'test-token');
  assert.match(cfg.env.NO_PROXY, /192\.168\.0\.0\/16/);
  assert.match(cfg.env.NO_PROXY, /localhost/);
  assert.equal(cfg.env.no_proxy, cfg.env.NO_PROXY);
});

test('Trae / Cursor 共用 mcpServers JSON 格式', () => {
  const json = buildTraeMcpJson(sample);
  const parsed = JSON.parse(json) as { mcpServers: Record<string, unknown> };
  assert.ok(parsed.mcpServers[DEVFLEET_MCP_SERVER_NAME]);
});

test('Cursor 一键安装 deeplink 编码 stdio 配置', () => {
  const links = buildCursorInstallLinks(sample);
  assert.match(links.deeplink, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install/);
  assert.match(links.webUrl, /^https:\/\/cursor\.com\/en\/install-mcp/);
  assert.equal(links.mcpJson, buildTraeMcpJson(sample));
});

test('Trae 一键安装 deeplink 使用新版 mcp/install 格式', () => {
  const links = buildTraeInstallLinks(sample);
  assert.match(links.deeplinkCn, /^trae-cn:\/\/mcp\/install/);
  assert.match(links.deeplinkIntl, /^trae:\/\/mcp\/install/);
  assert.match(links.legacyDeeplinkCn, /^trae-cn:\/\/trae\.ai-ide\/mcp-import/);
  assert.match(links.legacyDeeplinkIntl, /^trae:\/\/trae\.ai-ide\/mcp-import/);
  assert.match(links.deeplinkCn, /type=stdio/);
  assert.equal(links.mcpJson, buildTraeMcpJson(sample));
  assert.equal(links.variant, 'cn');
});

test('buildTraeDeeplink 生成新版协议链接', () => {
  const config = buildDevfleetStdioConfig(sample);
  const cnLink = buildTraeDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'cn');
  const intlLink = buildTraeDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'intl');
  assert.match(cnLink, /^trae-cn:\/\/mcp\/install\?/);
  assert.match(intlLink, /^trae:\/\/mcp\/install\?/);
  assert.match(cnLink, /name=devfleet/);
  assert.match(cnLink, /type=stdio/);
});

test('buildTraeLegacyDeeplink 生成旧版协议链接', () => {
  const config = buildDevfleetStdioConfig(sample);
  const legacyCn = buildTraeLegacyDeeplink(DEVFLEET_MCP_SERVER_NAME, config, 'cn');
  assert.match(legacyCn, /^trae-cn:\/\/trae\.ai-ide\/mcp-import/);
});

test('Trae 安装链接支持指定国际版', () => {
  const links = buildTraeInstallLinks(sample, 'intl');
  assert.equal(links.variant, 'intl');
  assert.match(links.deeplink, /^trae:\/\/mcp\/install/);
});

test('Codex MCP 命令包含环境变量', () => {
  const cmd = buildCodexMcpCommand(sample, 'windows');
  assert.match(cmd, /^codex mcp add devfleet/);
  assert.match(cmd, /DEVFLEET_API_URL=/);
  assert.match(cmd, /DEVFLEET_TOKEN="test-token"/);
  assert.match(cmd, /NO_PROXY=/);
  assert.match(cmd, /no_proxy=/);
});
