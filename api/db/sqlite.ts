import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { migrateIfNeeded, importJsonIfPending } from './migrate.js';
import { applySchemaUpgrades } from './schema-upgrades.js';

export type DevFleetDatabase = Database.Database;

function resolveDbPath(): string {
  const fromEnv = process.env.DEVFLEET_DB_FILE?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (resolved.endsWith('.json')) {
      return resolved.replace(/\.json$/i, '.db');
    }
    return resolved;
  }
  return path.resolve(process.cwd(), 'api', 'data', 'devfleet.db');
}

const DATA_DIR = path.dirname(resolveDbPath());

let dbInstance: DevFleetDatabase | null = null;
let openDbPath: string | null = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function applySchema(database: DevFleetDatabase) {
  database.exec(SCHEMA_SQL);
}

export function getDatabase(): DevFleetDatabase {
  const targetPath = resolveDbPath();
  if (dbInstance && openDbPath !== targetPath) {
    closeDatabase();
  }
  if (dbInstance) return dbInstance;

  ensureDataDir();
  migrateIfNeeded(targetPath);

  dbInstance = new Database(targetPath);
  openDbPath = targetPath;
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  applySchema(dbInstance);
  applySchemaUpgrades(dbInstance);
  importJsonIfPending(dbInstance, targetPath);
  return dbInstance;
}

export function flushDB() {
  try {
    getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore if not in WAL mode yet
  }
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    openDbPath = null;
  }
}

export function getDbPath(): string {
  return resolveDbPath();
}

export function withTransaction(database: DevFleetDatabase, fn: () => void): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    fn();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
