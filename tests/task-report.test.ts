import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = (process.env.DEVFLEET_API_URL || 'http://localhost:3001').replace(/\/$/, '');

test('POST /api/devices/me/task-report 路由已注册', async (t) => {
  const health = await fetch(`${baseUrl}/api/health`);
  if (!health.ok) {
    t.skip('DevFleet API 未运行，跳过 task-report 路由测试');
    return;
  }

  const payload = {
    task_id: '00000000-0000-0000-0000-000000000001',
    subtask_id: '00000000-0000-0000-0000-000000000002',
    progress: 50,
    status: 'running',
    content: 'Trae 正在改码',
    level: 'info',
  };

  const noAuth = await fetch(`${baseUrl}/api/devices/me/task-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(noAuth.status, 401);

  const badDevice = await fetch(`${baseUrl}/api/devices/me/task-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${'a'.repeat(64)}`,
    },
    body: JSON.stringify(payload),
  });
  assert.ok(
    [401, 404].includes(badDevice.status),
    `无效设备 token 应返回 401 或 404，实际 ${badDevice.status}`,
  );
});
