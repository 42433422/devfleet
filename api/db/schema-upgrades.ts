import type { DevFleetDatabase } from './sqlite.js';

const COLUMN_UPGRADES: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'devices', column: 'capabilities', ddl: 'ALTER TABLE devices ADD COLUMN capabilities TEXT' },
  { table: 'sub_tasks', column: 'title', ddl: "ALTER TABLE sub_tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''" },
  { table: 'sub_tasks', column: 'description', ddl: "ALTER TABLE sub_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
  { table: 'sub_tasks', column: 'depends_on', ddl: "ALTER TABLE sub_tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'" },
  { table: 'sub_tasks', column: 'sort_order', ddl: 'ALTER TABLE sub_tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0' },
  { table: 'sub_tasks', column: 'attempt_count', ddl: 'ALTER TABLE sub_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0' },
  { table: 'sub_tasks', column: 'max_attempts', ddl: 'ALTER TABLE sub_tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 2' },
  { table: 'sub_tasks', column: 'last_error', ddl: 'ALTER TABLE sub_tasks ADD COLUMN last_error TEXT' },
  { table: 'sub_tasks', column: 'updated_at', ddl: 'ALTER TABLE sub_tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' },
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
}
