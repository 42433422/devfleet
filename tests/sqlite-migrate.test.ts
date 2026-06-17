import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('JSON 数据库可迁移到 SQLite', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-sqlite-'));
  const jsonPath = path.join(tempDir, 'devfleet.json');
  const dbPath = path.join(tempDir, 'devfleet.db');

  const legacy = {
    users: [{
      id: 'u1',
      email: 'legacy@example.com',
      password_hash: 'hash',
      created_at: new Date().toISOString(),
    }],
    devices: [],
    tool_statuses: [],
    tasks: [],
    sub_tasks: [],
    log_entries: [],
  };
  fs.writeFileSync(jsonPath, JSON.stringify(legacy, null, 2));

  process.env.DEVFLEET_DB_FILE = dbPath;
  process.env.JWT_SECRET = 'sqlite-migrate-test';

  const { closeDatabase } = await import('../api/db/sqlite.js');
  const { db } = await import('../api/db/store.js');

  const users = db.users.findAll();
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'legacy@example.com');
  assert.ok(fs.existsSync(dbPath));
  assert.ok(fs.existsSync(`${jsonPath}.bak`));

  closeDatabase();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
