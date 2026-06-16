import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('全新空目录启动服务端可自动建库并完成 guest 登录', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-fresh-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'fresh.db');
  process.env.JWT_SECRET = 'fresh-db-test-secret';

  const { closeDatabase } = await import('../api/db/sqlite.js');
  closeDatabase();

  const { bootstrapDatabase } = await import('../api/lib/dbBootstrap.js');
  bootstrapDatabase();

  const { default: app } = await import('../api/app.js');
  const http = await import('node:http');
  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.ok, true);

    const auth = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const authBody = await auth.json() as { token: string; user: { id: string; email: string } };
    assert.equal(auth.ok, true);
    assert.equal(authBody.user.email, 'guest@devfleet.local');
    assert.ok(authBody.token.length > 10);

    const headers = { Authorization: `Bearer ${authBody.token}` };
    const devices = await fetch(`${base}/api/devices`, { headers });
    const devicesBody = await devices.json() as { devices: Array<{ name: string }> };
    assert.equal(devices.ok, true);
    assert.ok(devicesBody.devices.length >= 1);
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('bootstrapDatabase 预置 guest 会话与默认设备', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-bootstrap-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'bootstrap.db');
  process.env.JWT_SECRET = 'bootstrap-test-secret';

  const { closeDatabase } = await import('../api/db/sqlite.js');
  closeDatabase();

  try {
    const { bootstrapDatabase } = await import('../api/lib/dbBootstrap.js');
    bootstrapDatabase();
    const { db } = await import('../api/db/store.js');
    const guest = db.users.findGuest();
    assert.ok(guest);
    assert.equal(guest.email, 'guest@devfleet.local');
    assert.ok(db.devices.countByUserId(guest.id) >= 1);
  } finally {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});
