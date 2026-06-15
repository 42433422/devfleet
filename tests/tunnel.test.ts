import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

test('tunnel API 默认未开启', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-tunnel-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'db.json');
  process.env.JWT_SECRET = 'tunnel-test-secret';

  const { default: app } = await import('../api/app.js');
  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const auth = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tunnel@example.com', password: 'secret123' }),
    });
    const { token } = await auth.json() as { token: string };

    const res = await fetch(`${baseUrl}/api/tunnel/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { active: boolean; url: string | null };
    assert.equal(res.ok, true);
    assert.equal(body.active, false);
    assert.equal(body.url, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('getTunnelStatus 初始状态', async () => {
  const { getTunnelStatus } = await import('../api/tunnel/manager.js');
  const status = getTunnelStatus();
  assert.equal(status.active, false);
  assert.equal(status.url, null);
});
