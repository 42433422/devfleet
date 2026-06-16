import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('guest 登录复用同一访客用户', async () => {
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
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});
