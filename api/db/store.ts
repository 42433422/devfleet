import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { genId } from '../lib/utils.js';

const DB_FILE = process.env.DEVFLEET_DB_FILE
  ? path.resolve(process.env.DEVFLEET_DB_FILE)
  : path.resolve(process.cwd(), 'api', 'data', 'db.json');
const DATA_DIR = path.dirname(DB_FILE);

interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

interface Device {
  id: string;
  user_id: string;
  name: string;
  bind_code?: string;
  bind_code_expires_at?: string;
  device_token_hash?: string;
  status: 'online' | 'offline' | 'connecting';
  activated: boolean;
  connection_allowed?: boolean;
  is_primary?: boolean;
  /** 主设备指定的本机开发工具，默认 trae */
  dev_tool?: 'codex' | 'trae' | 'cursor' | 'claude_code';
  last_seen: string;
}

interface ToolStatusItem {
  id: string;
  device_id: string;
  tool_name: 'codex' | 'trae' | 'cursor' | 'claude_code';
  status: 'running' | 'idle' | 'not_installed';
  current_task?: string;
}

interface Task {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'merged';
  repo_url: string;
  branch: string;
  created_at: string;
  completed_at?: string;
  merge_commit_sha?: string;
}

interface SubTask {
  id: string;
  task_id: string;
  device_id: string;
  tool_name: 'codex' | 'trae' | 'cursor' | 'claude_code';
  status: 'pending' | 'running' | 'completed' | 'failed';
  branch_name: string;
  progress: number;
  created_at: string;
  completed_at?: string;
}

interface LogEntry {
  id: string;
  sub_task_id: string;
  content: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  timestamp: string;
}

interface DB {
  users: User[];
  devices: Device[];
  tool_statuses: ToolStatusItem[];
  tasks: Task[];
  sub_tasks: SubTask[];
  log_entries: LogEntry[];
}

let cachedDB: DB | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultDB(): DB {
  return {
    users: [],
    devices: [],
    tool_statuses: [],
    tasks: [],
    sub_tasks: [],
    log_entries: [],
  };
}

function loadDB(): DB {
  if (cachedDB) return cachedDB;
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    cachedDB = defaultDB();
    return cachedDB;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    cachedDB = JSON.parse(raw) as DB;
  } catch (error) {
    throw new Error(`[DB] 无法读取 ${DB_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cachedDB!;
}

function saveDBNow() {
  if (!cachedDB) return;
  ensureDir();
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(cachedDB, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempFile, DB_FILE);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Preserve the original write error.
    }
    console.error('[DB] write failed', error);
  }
}

function saveDB() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    saveDBNow();
  }, 50);
}

export function flushDB() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  saveDBNow();
}

export const db = {
  // ===== Users =====
  users: {
    findAll(): User[] {
      return loadDB().users;
    },
    findById(id: string): User | undefined {
      return loadDB().users.find((u) => u.id === id);
    },
    findByEmail(email: string): User | undefined {
      return loadDB().users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    },
    create(data: Omit<User, 'id' | 'created_at'>): User {
      const dbData = loadDB();
      const user: User = {
        id: genId(),
        created_at: new Date().toISOString(),
        ...data,
      };
      dbData.users.push(user);
      saveDB();
      return user;
    },
  },

  // ===== Devices =====
  devices: {
    findAllByUserId(userId: string): Device[] {
      // Devices created before the activated field was introduced are treated as active.
      return loadDB().devices.filter((d) => d.user_id === userId && d.activated !== false);
    },
    findById(id: string): Device | undefined {
      return loadDB().devices.find((d) => d.id === id);
    },
    findByBindCode(bindCode: string): Device | undefined {
      return loadDB().devices.find((d) => d.bind_code === bindCode);
    },
    findByDeviceToken(deviceToken: string): Device | undefined {
      const hash = createHash('sha256').update(deviceToken).digest('hex');
      return loadDB().devices.find((d) => d.device_token_hash === hash && d.activated !== false && d.connection_allowed !== false);
    },
    create(data: Omit<Device, 'id' | 'last_seen'> & { last_seen?: string }): Device {
      const dbData = loadDB();
      const device: Device = {
        id: genId(),
        last_seen: new Date().toISOString(),
        ...data,
      };
      dbData.devices.push(device);
      saveDB();
      return device;
    },
    update(id: string, patch: Partial<Device>): Device | undefined {
      const dbData = loadDB();
      const idx = dbData.devices.findIndex((d) => d.id === id);
      if (idx === -1) return undefined;
      dbData.devices[idx] = { ...dbData.devices[idx], ...patch, last_seen: new Date().toISOString() };
      saveDB();
      return dbData.devices[idx];
    },
    setPrimary(userId: string, id: string): Device | undefined {
      const dbData = loadDB();
      const target = dbData.devices.find((d) => d.id === id && d.user_id === userId && d.activated !== false);
      if (!target) return undefined;
      dbData.devices.forEach((device) => {
        if (device.user_id === userId) device.is_primary = device.id === id;
      });
      saveDB();
      return target;
    },
    remove(id: string): void {
      const dbData = loadDB();
      dbData.devices = dbData.devices.filter((d) => d.id !== id);
      dbData.tool_statuses = dbData.tool_statuses.filter((t) => t.device_id !== id);
      saveDB();
    },
  },

  // ===== Tool Statuses =====
  tools: {
    findAllByDeviceId(deviceId: string): ToolStatusItem[] {
      return loadDB().tool_statuses.filter((t) => t.device_id === deviceId);
    },
    upsert(deviceId: string, toolName: ToolStatusItem['tool_name'], patch: Partial<ToolStatusItem>): ToolStatusItem {
      const dbData = loadDB();
      let item = dbData.tool_statuses.find((t) => t.device_id === deviceId && t.tool_name === toolName);
      if (!item) {
        item = {
          id: genId(),
          device_id: deviceId,
          tool_name: toolName,
          status: 'idle',
          ...patch,
        };
        dbData.tool_statuses.push(item);
      } else {
        Object.assign(item, patch);
      }
      saveDB();
      return item;
    },
    bulkUpsert(deviceId: string, items: Array<{ tool_name: ToolStatusItem['tool_name']; status: ToolStatusItem['status']; current_task?: string }>): void {
      items.forEach((it) => this.upsert(deviceId, it.tool_name, { status: it.status, current_task: it.current_task }));
    },
  },

  // ===== Tasks =====
  tasks: {
    findAllByUserId(userId: string): Task[] {
      return loadDB().tasks.filter((t) => t.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    findById(id: string): Task | undefined {
      return loadDB().tasks.find((t) => t.id === id);
    },
    create(data: Omit<Task, 'id' | 'created_at' | 'status'> & { status?: Task['status'] }): Task {
      const dbData = loadDB();
      const task: Task = {
        id: genId(),
        status: 'pending',
        created_at: new Date().toISOString(),
        ...data,
      };
      dbData.tasks.push(task);
      saveDB();
      return task;
    },
    update(id: string, patch: Partial<Task>): Task | undefined {
      const dbData = loadDB();
      const idx = dbData.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return undefined;
      dbData.tasks[idx] = { ...dbData.tasks[idx], ...patch };
      saveDB();
      return dbData.tasks[idx];
    },
    remove(id: string): void {
      const dbData = loadDB();
      dbData.tasks = dbData.tasks.filter((t) => t.id !== id);
      const subIds = dbData.sub_tasks.filter((s) => s.task_id === id).map((s) => s.id);
      dbData.sub_tasks = dbData.sub_tasks.filter((s) => s.task_id !== id);
      dbData.log_entries = dbData.log_entries.filter((l) => !subIds.includes(l.sub_task_id));
      saveDB();
    },
  },

  // ===== SubTasks =====
  subTasks: {
    findAllByTaskId(taskId: string): SubTask[] {
      return loadDB().sub_tasks.filter((s) => s.task_id === taskId);
    },
    findAllByDeviceId(deviceId: string): SubTask[] {
      return loadDB().sub_tasks.filter((s) => s.device_id === deviceId);
    },
    findById(id: string): SubTask | undefined {
      return loadDB().sub_tasks.find((s) => s.id === id);
    },
    create(data: Omit<SubTask, 'id' | 'created_at' | 'progress'> & { progress?: number }): SubTask {
      const dbData = loadDB();
      const sub: SubTask = {
        id: genId(),
        progress: 0,
        created_at: new Date().toISOString(),
        ...data,
      };
      dbData.sub_tasks.push(sub);
      saveDB();
      return sub;
    },
    update(id: string, patch: Partial<SubTask>): SubTask | undefined {
      const dbData = loadDB();
      const idx = dbData.sub_tasks.findIndex((s) => s.id === id);
      if (idx === -1) return undefined;
      dbData.sub_tasks[idx] = { ...dbData.sub_tasks[idx], ...patch };
      saveDB();
      return dbData.sub_tasks[idx];
    },
  },

  // ===== Logs =====
  logs: {
    findAllBySubTaskId(subTaskId: string): LogEntry[] {
      return loadDB().log_entries.filter((l) => l.sub_task_id === subTaskId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    },
    create(data: Omit<LogEntry, 'id' | 'timestamp'> & { timestamp?: string }): LogEntry {
      const dbData = loadDB();
      const log: LogEntry = {
        id: genId(),
        timestamp: new Date().toISOString(),
        ...data,
      };
      dbData.log_entries.push(log);
      saveDB();
      return log;
    },
  },
};

export type { User, Device, ToolStatusItem, Task, SubTask, LogEntry };
