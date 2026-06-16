import fs from 'fs';
import path from 'path';

interface LegacyDb {
  users?: Array<{
    id: string;
    email: string;
    password_hash: string;
    created_at: string;
  }>;
  devices?: Array<Record<string, unknown>>;
  tool_statuses?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  sub_tasks?: Array<Record<string, unknown>>;
  log_entries?: Array<Record<string, unknown>>;
}

function jsonPathFor(dbPath: string): string {
  if (dbPath.endsWith('.db')) {
    return dbPath.replace(/\.db$/i, '.json');
  }
  return `${dbPath}.json`;
}

function boolish(value: unknown, defaultValue = true): number {
  if (value === undefined || value === null) return defaultValue ? 1 : 0;
  return value === false || value === 0 ? 0 : 1;
}

export function migrateIfNeeded(dbPath: string): void {
  if (fs.existsSync(dbPath)) return;

  const jsonPath = jsonPathFor(dbPath);
  if (!fs.existsSync(jsonPath)) return;

  // Defer actual import until SQLite is opened; mark for migration
  const marker = `${dbPath}.migrate-from-json`;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, jsonPath, 'utf-8');
  }
}

export function importJsonIfPending(database: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }; exec: (sql: string) => void; transaction: (fn: () => void) => () => void }, dbPath: string): void {
  const marker = `${dbPath}.migrate-from-json`;
  if (!fs.existsSync(marker)) return;

  const jsonPath = fs.readFileSync(marker, 'utf-8').trim();
  if (!fs.existsSync(jsonPath)) {
    fs.unlinkSync(marker);
    return;
  }

  let legacy: LegacyDb;
  try {
    legacy = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as LegacyDb;
  } catch {
    console.error(`[DB] JSON migration failed: cannot parse ${jsonPath}`);
    return;
  }

  const importAll = () => {
    database.exec('BEGIN IMMEDIATE');
    try {
    for (const user of legacy.users || []) {
      const isGuest = user.email.includes('@devfleet.local') && user.email.startsWith('guest') ? 1 : 0;
      database.prepare(
        `INSERT OR IGNORE INTO users (id, email, password_hash, is_guest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(user.id, user.email, user.password_hash || '', isGuest, user.created_at);
    }

    for (const device of legacy.devices || []) {
      database.prepare(
        `INSERT OR IGNORE INTO devices (
          id, user_id, name, bind_code, bind_code_expires_at, device_token_hash,
          status, activated, connection_allowed, is_primary, dev_tool, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        device.id,
        device.user_id,
        device.name,
        device.bind_code ?? null,
        device.bind_code_expires_at ?? null,
        device.device_token_hash ?? null,
        device.status ?? 'offline',
        boolish(device.activated),
        boolish(device.connection_allowed),
        boolish(device.is_primary, false),
        device.dev_tool ?? null,
        device.last_seen ?? new Date().toISOString(),
      );
    }

    for (const tool of legacy.tool_statuses || []) {
      database.prepare(
        `INSERT OR IGNORE INTO tool_statuses (id, device_id, tool_name, status, current_task)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        tool.id,
        tool.device_id,
        tool.tool_name,
        tool.status ?? 'idle',
        tool.current_task ?? null,
      );
    }

    for (const task of legacy.tasks || []) {
      database.prepare(
        `INSERT OR IGNORE INTO tasks (
          id, user_id, title, description, status, repo_url, branch,
          created_at, completed_at, merge_commit_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.user_id,
        task.title,
        task.description ?? '',
        task.status ?? 'pending',
        task.repo_url ?? '',
        task.branch ?? 'main',
        task.created_at,
        task.completed_at ?? null,
        task.merge_commit_sha ?? null,
      );
    }

    for (const sub of legacy.sub_tasks || []) {
      database.prepare(
        `INSERT OR IGNORE INTO sub_tasks (
          id, task_id, device_id, tool_name, status, branch_name, progress, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sub.id,
        sub.task_id,
        sub.device_id,
        sub.tool_name,
        sub.status ?? 'pending',
        sub.branch_name,
        sub.progress ?? 0,
        sub.created_at,
        sub.completed_at ?? null,
      );
    }

    for (const log of legacy.log_entries || []) {
      database.prepare(
        `INSERT OR IGNORE INTO log_entries (id, sub_task_id, content, level, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        log.id,
        log.sub_task_id,
        log.content,
        log.level ?? 'info',
        log.timestamp ?? new Date().toISOString(),
      );
    }

    database.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_json', ?)`,
    ).run(jsonPath);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  importAll();
  fs.renameSync(jsonPath, `${jsonPath}.bak`);
  fs.unlinkSync(marker);
  console.log(`[DB] migrated ${jsonPath} -> ${dbPath}`);
}
