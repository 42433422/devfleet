import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { migrateIfNeeded, importJsonIfPending } from './migrate.js';
import { applySchemaUpgrades } from './schema-upgrades.js';

export type DevFleetDatabase = Database.Database;

function defaultUserDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA?.trim()
      || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(base, 'com.devfleet.desktop');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME?.trim() || '';
    return path.join(home, 'Library', 'Application Support', 'com.devfleet.desktop');
  }
  const home = process.env.HOME?.trim() || '';
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  return path.join(base, 'com.devfleet.desktop');
}

function isPackagedServerCwd(): boolean {
  const cwd = process.cwd();
  return /(?:DevFleet|PaibiPara)\.app[\\/]Contents[\\/]Resources[\\/]server/i.test(cwd)
    || /[\\/]resources[\\/]server$/i.test(cwd)
    || /Program Files.*[\\/](?:DevFleet|PaibiPara)/i.test(cwd);
}

function resolveDbPath(): string {
  const fromEnv = process.env.DEVFLEET_DB_FILE?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (resolved.endsWith('.json')) {
      return resolved.replace(/\.json$/i, '.db');
    }
    return resolved;
  }

  const fromDataDir = process.env.DEVFLEET_DATA_DIR?.trim();
  if (fromDataDir) {
    return path.join(path.resolve(fromDataDir), 'devfleet.db');
  }

  if (process.env.DEVFLEET_DESKTOP === '1' || isPackagedServerCwd()) {
    return path.join(defaultUserDataDir(), 'devfleet.db');
  }

  return path.resolve(process.cwd(), 'api', 'data', 'devfleet.db');
}

let dbInstance: DevFleetDatabase | null = null;
let openDbPath: string | null = null;

function ensureDataDir(targetPath: string) {
  const dataDir = path.dirname(targetPath);
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法创建数据库目录 ${dataDir}：${message}。请确认排比 Para 已安装到用户目录，且系统未拦截对 AppData/Application Support 的写入。`,
    );
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

  ensureDataDir(targetPath);
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
    try {
      dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore close-time checkpoint errors; close still releases the handle
    }
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
