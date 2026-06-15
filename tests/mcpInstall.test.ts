import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildDevfleetStdioConfig,
  buildTraeInstallLinks,
  buildTraeMcpJson,
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

test('Trae 一键安装 deeplink 编码 stdio 配置', () => {
  const links = buildTraeInstallLinks(sample);
  assert.match(links.deeplink, /^trae:\/\/mcp\/install/);
  assert.equal(links.mcpJson, buildTraeMcpJson(sample));
});

test('Codex MCP 命令包含环境变量', () => {
  const cmd = buildCodexMcpCommand(sample, 'windows');
  assert.match(cmd, /^codex mcp add devfleet/);
  assert.match(cmd, /DEVFLEET_API_URL=/);
  assert.match(cmd, /DEVFLEET_TOKEN="test-token"/);
});
