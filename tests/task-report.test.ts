import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

async function withTaskReportServer(fn: (base: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-task-report-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'task-report.db');
  process.env.JWT_SECRET = 'task-report-test-secret';

  const { default: app } = await import('../api/app.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');
  const http = await import('node:http');
  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    await fn(base);
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('POST /api/devices/me/task-report 路由已注册', async () => {
  await withTaskReportServer(async (baseUrl) => {
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
});
