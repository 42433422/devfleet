import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

async function withGuestServer(fn: (base: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-guest-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'guest.db');
  process.env.JWT_SECRET = 'guest-test-secret';

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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('guest 登录复用同一访客用户', async () => {
  await withGuestServer(async (base) => {
    const first = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const firstBody = await first.json() as { token: string; user: { id: string; email: string } };
    assert.equal(first.ok, true);
    assert.equal(firstBody.user.email, 'guest@devfleet.local');

    const second = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const secondBody = await second.json() as { token: string; user: { id: string; email: string } };
    assert.equal(second.ok, true);
    assert.equal(secondBody.user.id, firstBody.user.id);

    const { db } = await import('../api/db/store.js');
    const guests = db.users.findAll().filter((u) => u.is_guest);
    assert.equal(guests.length, 1);
  });
});

test('guest 登录后可访问设备与任务 API', async () => {
  await withGuestServer(async (base) => {
    const auth = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const authBody = await auth.json() as { token: string };
    assert.equal(auth.ok, true);

    const headers = {
      Authorization: `Bearer ${authBody.token}`,
      'Content-Type': 'application/json',
    };

    const devices = await fetch(`${base}/api/devices`, { headers });
    assert.equal(devices.ok, true);

    const tasks = await fetch(`${base}/api/tasks`, { headers });
    assert.equal(tasks.ok, true);

    const bind = await fetch(`${base}/api/devices/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Guest Device' }),
    });
    assert.equal(bind.ok, true);
    const bindBody = await bind.json() as { bindCode: string };
    assert.ok(bindBody.bindCode.length >= 4);
  });
});

test('历史 guest token 对应用户缺失时仍可访问 API', async () => {
  await withGuestServer(async (base) => {
    const { signToken } = await import('../api/middleware/auth.js');
    const staleToken = signToken({
      id: 'missing-guest-user',
      email: 'guest@devfleet.local',
    });

    const devices = await fetch(`${base}/api/devices`, {
      headers: { Authorization: `Bearer ${staleToken}` },
    });
    const body = await devices.json() as { devices: Array<{ id: string; name: string }> };

    assert.equal(devices.ok, true);
    assert.ok(body.devices.length >= 1);
  });
});

test('guest 登录合并遗留 guest_* 账号数据', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-guest-merge-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'guest.db');
  process.env.JWT_SECRET = 'guest-test-secret';

  const { db } = await import('../api/db/store.js');
  const legacy = db.users.create({
    email: 'guest_1781525403271@devfleet.local',
    password_hash: '',
    is_guest: false,
  });
  const legacyDevice = db.devices.create({
    user_id: legacy.id,
    name: 'Legacy Device',
    status: 'offline',
    activated: true,
    dev_tool: 'trae',
    is_primary: true,
  });

  const { default: app } = await import('../api/app.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');
  const http = await import('node:http');
  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const auth = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const authBody = await auth.json() as { token: string; user: { id: string; email: string } };
    assert.equal(auth.ok, true);
    assert.equal(authBody.user.email, 'guest@devfleet.local');

    const devices = await fetch(`${base}/api/devices`, {
      headers: { Authorization: `Bearer ${authBody.token}` },
    });
    const devicesBody = await devices.json() as { devices: Array<{ id: string; name: string }> };
    assert.equal(devices.ok, true);
    assert.equal(devicesBody.devices.some((device) => device.id === legacyDevice.id), true);
    assert.equal(devicesBody.devices.some((device) => device.name === 'Legacy Device'), true);

    const guests = db.users.findAll().filter((user) => user.email.includes('guest'));
    assert.equal(guests.length, 1);
    assert.equal(guests[0].email, 'guest@devfleet.local');
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
