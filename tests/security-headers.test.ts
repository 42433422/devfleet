import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

test('API 返回 CSP 头并拒绝未知 CORS Origin', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-sec-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'sec.db');
  process.env.JWT_SECRET = 'security-test';

  const { default: app } = await import('../api/app.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');

  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.ok, true);
    const csp = health.headers.get('content-security-policy');
    assert.ok(csp?.includes("default-src 'none'"));

    const blocked = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(blocked.status, 403);
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});
