import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMcpAutoSetupPrompt } from '../src/lib/mcpSetupPrompt.ts';

test('buildMcpAutoSetupPrompt 包含连接参数与客户端指引', () => {
  const prompt = buildMcpAutoSetupPrompt({
    mcpPath: '/tmp/devfleet-mcp.mjs',
    apiUrl: 'http://localhost:3001',
    token: 'test-jwt-token',
    platform: 'unix',
    traeVariant: 'cn',
  });
  assert.match(prompt, /请立即帮我在本机完成 DevFleet MCP 接入/);
  assert.match(prompt, /\/tmp\/devfleet-mcp\.mjs/);
  assert.match(prompt, /http:\/\/localhost:3001/);
  assert.match(prompt, /test-jwt-token/);
  assert.match(prompt, /devfleet_list_devices/);
  assert.match(prompt, /Cursor/);
  assert.match(prompt, /Trae CN/);
  assert.match(prompt, /codex mcp add devfleet/);
  assert.match(prompt, /Claude/);
});
