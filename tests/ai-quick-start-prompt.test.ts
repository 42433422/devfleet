import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiQuickStartPrompt } from '../src/lib/aiQuickStartPrompt.ts';

test('buildAiQuickStartPrompt 包含一键多设备闭环指令', () => {
  const prompt = buildAiQuickStartPrompt({
    mcpPath: '/tmp/devfleet-mcp.mjs',
    apiUrl: 'http://localhost:3001',
    token: 'test-jwt-token',
    platform: 'unix',
    traeVariant: 'cn',
    mergeWorkspace: '/tmp/devfleet-merge',
  });

  assert.match(prompt, /请用 排比 Para 调度所有在线工作设备完成我的开发任务/);
  assert.match(prompt, /devfleet_list_devices/);
  assert.match(prompt, /devfleet_dispatch_task/);
  assert.match(prompt, /devfleet_wait_for_task/);
  assert.match(prompt, /devfleet_merge_task/);
  assert.match(prompt, /isPrimary!=true/);
  assert.match(prompt, /\/tmp\/devfleet-mcp\.mjs/);
  assert.match(prompt, /http:\/\/localhost:3001/);
  assert.match(prompt, /test-jwt-token/);
  assert.match(prompt, /\/tmp\/devfleet-merge/);
});
