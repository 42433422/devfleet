import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP 服务公开真实多设备调度工具', async () => {
  const client = new Client({ name: 'devfleet-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist-mcp/devfleet-mcp.mjs')],
    env: {
      ...process.env,
      DEVFLEET_API_URL: 'http://127.0.0.1:1',
      DEVFLEET_TOKEN: 'test-token',
    } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'devfleet_call_remote_codex',
      'devfleet_computer_use_open_trae_workspace',
      'devfleet_computer_use_start_trae_task',
      'devfleet_computer_use_submit_trae_task',
      'devfleet_dispatch_task',
      'devfleet_get_collab_session',
      'devfleet_get_task',
      'devfleet_list_collab_sessions',
      'devfleet_list_devices',
      'devfleet_merge_task',
      'devfleet_next_task',
      'devfleet_report_task_progress',
      'devfleet_run_remote_command',
      'devfleet_send_collab_message',
      'devfleet_start_collab_session',
      'devfleet_wait_collab_message',
      'devfleet_wait_for_task',
    ]);
  } finally {
    await client.close();
  }
});
