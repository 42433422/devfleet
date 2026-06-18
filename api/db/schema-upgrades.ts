import type { DevFleetDatabase } from './sqlite.js';

const COLUMN_UPGRADES: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'devices', column: 'bind_code', ddl: 'ALTER TABLE devices ADD COLUMN bind_code TEXT' },
  { table: 'devices', column: 'bind_code_expires_at', ddl: 'ALTER TABLE devices ADD COLUMN bind_code_expires_at TEXT' },
  { table: 'devices', column: 'device_token_hash', ddl: 'ALTER TABLE devices ADD COLUMN device_token_hash TEXT' },
  { table: 'devices', column: 'activated', ddl: 'ALTER TABLE devices ADD COLUMN activated INTEGER NOT NULL DEFAULT 1' },
  { table: 'devices', column: 'connection_allowed', ddl: 'ALTER TABLE devices ADD COLUMN connection_allowed INTEGER NOT NULL DEFAULT 1' },
  { table: 'devices', column: 'is_primary', ddl: 'ALTER TABLE devices ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0' },
  { table: 'devices', column: 'dev_tool', ddl: 'ALTER TABLE devices ADD COLUMN dev_tool TEXT' },
  { table: 'devices', column: 'capabilities', ddl: 'ALTER TABLE devices ADD COLUMN capabilities TEXT' },
  { table: 'tool_statuses', column: 'current_task', ddl: 'ALTER TABLE tool_statuses ADD COLUMN current_task TEXT' },
  { table: 'tasks', column: 'description', ddl: "ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
  { table: 'tasks', column: 'repo_url', ddl: "ALTER TABLE tasks ADD COLUMN repo_url TEXT NOT NULL DEFAULT ''" },
  { table: 'tasks', column: 'branch', ddl: "ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT 'main'" },
  { table: 'tasks', column: 'completed_at', ddl: 'ALTER TABLE tasks ADD COLUMN completed_at TEXT' },
  { table: 'tasks', column: 'merge_commit_sha', ddl: 'ALTER TABLE tasks ADD COLUMN merge_commit_sha TEXT' },
  { table: 'sub_tasks', column: 'title', ddl: "ALTER TABLE sub_tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''" },
  { table: 'sub_tasks', column: 'description', ddl: "ALTER TABLE sub_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
  { table: 'sub_tasks', column: 'depends_on', ddl: "ALTER TABLE sub_tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'" },
  { table: 'sub_tasks', column: 'sort_order', ddl: 'ALTER TABLE sub_tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0' },
  { table: 'sub_tasks', column: 'attempt_count', ddl: 'ALTER TABLE sub_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0' },
  { table: 'sub_tasks', column: 'max_attempts', ddl: 'ALTER TABLE sub_tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 2' },
  { table: 'sub_tasks', column: 'last_error', ddl: 'ALTER TABLE sub_tasks ADD COLUMN last_error TEXT' },
  { table: 'sub_tasks', column: 'updated_at', ddl: 'ALTER TABLE sub_tasks ADD COLUMN updated_at TEXT' },
  { table: 'log_entries', column: 'device_id', ddl: 'ALTER TABLE log_entries ADD COLUMN device_id TEXT' },
  { table: 'log_entries', column: 'task_id', ddl: 'ALTER TABLE log_entries ADD COLUMN task_id TEXT' },
];

function hasColumn(database: DevFleetDatabase, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function applySchemaUpgrades(database: DevFleetDatabase): void {
  for (const upgrade of COLUMN_UPGRADES) {
    if (!hasColumn(database, upgrade.table, upgrade.column)) {
      database.exec(upgrade.ddl);
    }
  }
  database.prepare(
    `UPDATE sub_tasks
     SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now'))
     WHERE updated_at IS NULL OR updated_at = ''`,
  ).run();
  database.exec('CREATE INDEX IF NOT EXISTS idx_devices_bind_code ON devices(bind_code)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(device_token_hash)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_sub_tasks_updated_at ON sub_tasks(updated_at)');
}
