import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Database from 'better-sqlite3';

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

test('旧 SQLite sub_tasks 缺 updated_at 时自动升级', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-sqlite-upgrade-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      activated INTEGER NOT NULL DEFAULT 1,
      connection_allowed INTEGER NOT NULL DEFAULT 1,
      is_primary INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      repo_url TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL
    );
    CREATE TABLE sub_tasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch_name TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE tool_statuses (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      UNIQUE(device_id, tool_name)
    );
    CREATE TABLE log_entries (
      id TEXT PRIMARY KEY,
      sub_task_id TEXT NOT NULL REFERENCES sub_tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      timestamp TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO users (id, email, password_hash, created_at)
      VALUES ('u1', 'legacy-sqlite@example.com', 'x', '2026-01-01T00:00:00.000Z');
    INSERT INTO devices (id, user_id, name, status, last_seen)
      VALUES ('d1', 'u1', 'Legacy Device', 'offline', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, user_id, title, status, created_at)
      VALUES ('t1', 'u1', 'Legacy Task', 'running', '2026-01-01T00:00:00.000Z');
    INSERT INTO sub_tasks (id, task_id, device_id, tool_name, status, branch_name, progress, created_at)
      VALUES ('s1', 't1', 'd1', 'codex', 'running', 'devfleet/legacy', 40, '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  process.env.DEVFLEET_DB_FILE = dbPath;
  process.env.JWT_SECRET = 'sqlite-upgrade-test';

  const { closeDatabase, getDatabase } = await import('../api/db/sqlite.js');
  closeDatabase();

  try {
    const database = getDatabase();
    const columns = database.prepare('PRAGMA table_info(sub_tasks)').all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === 'updated_at'), true);
    const row = database.prepare('SELECT updated_at FROM sub_tasks WHERE id = ?').get('s1') as { updated_at: string };
    assert.equal(row.updated_at, '2026-01-01T00:00:00.000Z');
    const indexes = database.prepare('PRAGMA index_list(sub_tasks)').all() as Array<{ name: string }>;
    assert.equal(indexes.some((index) => index.name === 'idx_sub_tasks_updated_at'), true);
  } finally {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
