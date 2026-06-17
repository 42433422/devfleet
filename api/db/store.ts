import 'dotenv/config';
import { createHash } from 'node:crypto';
import { genId } from '../lib/utils.js';
import { getDatabase, flushDB as sqliteFlush, withTransaction } from './sqlite.js';

interface User {
  id: string;
  email: string;
  password_hash: string;
  is_guest?: boolean;
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
  dev_tool?: 'codex' | 'trae' | 'cursor' | 'claude_code';
  last_seen: string;
  capabilities?: string;
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
  updated_at: string;
  completed_at?: string;
  title?: string;
  description?: string;
  depends_on?: string[] | string;
  sort_order?: number;
  attempt_count?: number;
  max_attempts?: number;
  last_error?: string;
}

interface LogEntry {
  id: string;
  sub_task_id: string;
  content: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  timestamp: string;
  device_id?: string;
  task_id?: string;
}

type UserRow = User & { is_guest: number };

function sql() {
  return getDatabase();
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    is_guest: Boolean(row.is_guest),
    created_at: row.created_at,
  };
}

function rowToDevice(row: Record<string, unknown>): Device {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    bind_code: row.bind_code ? String(row.bind_code) : undefined,
    bind_code_expires_at: row.bind_code_expires_at ? String(row.bind_code_expires_at) : undefined,
    device_token_hash: row.device_token_hash ? String(row.device_token_hash) : undefined,
    status: String(row.status) as Device['status'],
    activated: Boolean(row.activated),
    connection_allowed: row.connection_allowed === undefined ? true : Boolean(row.connection_allowed),
    is_primary: Boolean(row.is_primary),
    dev_tool: row.dev_tool ? String(row.dev_tool) as Device['dev_tool'] : undefined,
    last_seen: String(row.last_seen),
    capabilities: row.capabilities ? String(row.capabilities) : undefined,
  };
}

function rowToTool(row: Record<string, unknown>): ToolStatusItem {
  return {
    id: String(row.id),
    device_id: String(row.device_id),
    tool_name: String(row.tool_name) as ToolStatusItem['tool_name'],
    status: String(row.status) as ToolStatusItem['status'],
    current_task: row.current_task ? String(row.current_task) : undefined,
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as Task['status'],
    repo_url: String(row.repo_url),
    branch: String(row.branch),
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : undefined,
    merge_commit_sha: row.merge_commit_sha ? String(row.merge_commit_sha) : undefined,
  };
}

function parseDependsOnColumn(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToSubTask(row: Record<string, unknown>): SubTask {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    device_id: String(row.device_id),
    tool_name: String(row.tool_name) as SubTask['tool_name'],
    status: String(row.status) as SubTask['status'],
    branch_name: String(row.branch_name),
    progress: Number(row.progress),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at ? String(row.completed_at) : undefined,
    title: row.title ? String(row.title) : undefined,
    description: row.description ? String(row.description) : undefined,
    depends_on: parseDependsOnColumn(row.depends_on),
    sort_order: row.sort_order === undefined ? 0 : Number(row.sort_order),
    attempt_count: row.attempt_count === undefined ? 0 : Number(row.attempt_count),
    max_attempts: row.max_attempts === undefined ? 2 : Number(row.max_attempts),
    last_error: row.last_error ? String(row.last_error) : undefined,
  };
}

function rowToLog(row: Record<string, unknown>): LogEntry {
  return {
    id: String(row.id),
    sub_task_id: String(row.sub_task_id),
    content: String(row.content),
    level: String(row.level) as LogEntry['level'],
    timestamp: String(row.timestamp),
    device_id: row.device_id ? String(row.device_id) : undefined,
    task_id: row.task_id ? String(row.task_id) : undefined,
  };
}

export function flushDB() {
  sqliteFlush();
}

export const db = {
  users: {
    findAll(): User[] {
      const rows = sql().prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
      return rows.map(rowToUser);
    },
    findById(id: string): User | undefined {
      const row = sql().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },
    findByEmail(email: string): User | undefined {
      const row = sql().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },
    findGuest(): User | undefined {
      const row = sql().prepare(
        `SELECT * FROM users WHERE is_guest = 1 AND email = 'guest@devfleet.local' LIMIT 1`,
      ).get() as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },
    create(data: Omit<User, 'id' | 'created_at'> & { id?: string }): User {
      const user: User = {
        id: data.id || genId(),
        created_at: new Date().toISOString(),
        email: data.email,
        password_hash: data.password_hash,
        is_guest: data.is_guest ?? false,
      };
      sql().prepare(
        `INSERT INTO users (id, email, password_hash, is_guest, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(user.id, user.email, user.password_hash, user.is_guest ? 1 : 0, user.created_at);
      return user;
    },
    reassignData(fromUserId: string, toUserId: string): void {
      const database = sql();
      withTransaction(database, () => {
        database.prepare('UPDATE devices SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
        database.prepare('UPDATE tasks SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
        database.prepare('DELETE FROM users WHERE id = ?').run(fromUserId);
      });
    },
  },

  devices: {
    countByUserId(userId: string): number {
      const row = sql().prepare('SELECT COUNT(*) AS count FROM devices WHERE user_id = ?').get(userId) as { count: number };
      return row.count;
    },
    findAllByUserId(userId: string): Device[] {
      const rows = sql().prepare(
        `SELECT * FROM devices WHERE user_id = ? AND activated = 1 ORDER BY last_seen DESC`,
      ).all(userId) as Record<string, unknown>[];
      return rows.map(rowToDevice);
    },
    findById(id: string): Device | undefined {
      const row = sql().prepare('SELECT * FROM devices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToDevice(row) : undefined;
    },
    findByBindCode(bindCode: string): Device | undefined {
      const row = sql().prepare('SELECT * FROM devices WHERE bind_code = ?').get(bindCode) as Record<string, unknown> | undefined;
      return row ? rowToDevice(row) : undefined;
    },
    findByDeviceToken(deviceToken: string): Device | undefined {
      const hash = createHash('sha256').update(deviceToken).digest('hex');
      const row = sql().prepare(
        `SELECT * FROM devices WHERE device_token_hash = ? AND activated = 1 AND connection_allowed = 1`,
      ).get(hash) as Record<string, unknown> | undefined;
      return row ? rowToDevice(row) : undefined;
    },
    create(data: Omit<Device, 'id' | 'last_seen'> & { last_seen?: string }): Device {
      const device: Device = {
        id: genId(),
        last_seen: data.last_seen || new Date().toISOString(),
        ...data,
      };
      sql().prepare(
        `INSERT INTO devices (
          id, user_id, name, bind_code, bind_code_expires_at, device_token_hash,
          status, activated, connection_allowed, is_primary, dev_tool, last_seen, capabilities
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        device.id,
        device.user_id,
        device.name,
        device.bind_code ?? null,
        device.bind_code_expires_at ?? null,
        device.device_token_hash ?? null,
        device.status,
        device.activated === false ? 0 : 1,
        device.connection_allowed === false ? 0 : 1,
        device.is_primary ? 1 : 0,
        device.dev_tool ?? null,
        device.last_seen,
        device.capabilities ?? null,
      );
      return device;
    },
    update(id: string, patch: Partial<Device>): Device | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, last_seen: new Date().toISOString() };
      sql().prepare(
        `UPDATE devices SET
          name = ?, bind_code = ?, bind_code_expires_at = ?, device_token_hash = ?,
          status = ?, activated = ?, connection_allowed = ?, is_primary = ?,
          dev_tool = ?, last_seen = ?, capabilities = ?
         WHERE id = ?`,
      ).run(
        next.name,
        next.bind_code ?? null,
        next.bind_code_expires_at ?? null,
        next.device_token_hash ?? null,
        next.status,
        next.activated === false ? 0 : 1,
        next.connection_allowed === false ? 0 : 1,
        next.is_primary ? 1 : 0,
        next.dev_tool ?? null,
        next.last_seen,
        next.capabilities ?? null,
        id,
      );
      return next;
    },
    setPrimary(userId: string, id: string): Device | undefined {
      const database = sql();
      const target = this.findById(id);
      if (!target || target.user_id !== userId || target.activated === false) return undefined;
      withTransaction(database, () => {
        database.prepare('UPDATE devices SET is_primary = 0 WHERE user_id = ?').run(userId);
        database.prepare('UPDATE devices SET is_primary = 1 WHERE id = ?').run(id);
      });
      return this.findById(id);
    },
    remove(id: string): void {
      const database = sql();
      withTransaction(database, () => {
        database.prepare('DELETE FROM tool_statuses WHERE device_id = ?').run(id);
        database.prepare('DELETE FROM devices WHERE id = ?').run(id);
      });
    },
  },

  tools: {
    findAllByDeviceId(deviceId: string): ToolStatusItem[] {
      const rows = sql().prepare('SELECT * FROM tool_statuses WHERE device_id = ?').all(deviceId) as Record<string, unknown>[];
      return rows.map(rowToTool);
    },
    upsert(deviceId: string, toolName: ToolStatusItem['tool_name'], patch: Partial<ToolStatusItem>): ToolStatusItem {
      const existing = sql().prepare(
        'SELECT * FROM tool_statuses WHERE device_id = ? AND tool_name = ?',
      ).get(deviceId, toolName) as Record<string, unknown> | undefined;

      if (!existing) {
        const item: ToolStatusItem = {
          id: genId(),
          device_id: deviceId,
          tool_name: toolName,
          status: patch.status || 'idle',
          current_task: patch.current_task,
        };
        sql().prepare(
          `INSERT INTO tool_statuses (id, device_id, tool_name, status, current_task) VALUES (?, ?, ?, ?, ?)`,
        ).run(item.id, item.device_id, item.tool_name, item.status, item.current_task ?? null);
        return item;
      }

      const item = rowToTool({
        ...existing,
        status: patch.status ?? existing.status,
        current_task: patch.current_task !== undefined ? patch.current_task : existing.current_task,
      });
      sql().prepare(
        'UPDATE tool_statuses SET status = ?, current_task = ? WHERE id = ?',
      ).run(item.status, item.current_task ?? null, item.id);
      return item;
    },
    tryClaimRunning(deviceId: string, toolName: ToolStatusItem['tool_name'], taskId: string): boolean {
      const database = sql();
      const existing = database.prepare(
        'SELECT * FROM tool_statuses WHERE device_id = ? AND tool_name = ?',
      ).get(deviceId, toolName) as Record<string, unknown> | undefined;

      if (existing?.status === 'running' && existing.current_task && existing.current_task !== taskId) {
        return false;
      }

      this.upsert(deviceId, toolName, { status: 'running', current_task: taskId });
      return true;
    },
    bulkUpsert(deviceId: string, items: Array<{ tool_name: ToolStatusItem['tool_name']; status: ToolStatusItem['status']; current_task?: string }>): void {
      items.forEach((it) => this.upsert(deviceId, it.tool_name, { status: it.status, current_task: it.current_task }));
    },
  },

  tasks: {
    findAllByUserId(userId: string): Task[] {
      const rows = sql().prepare(
        'SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC',
      ).all(userId) as Record<string, unknown>[];
      return rows.map(rowToTask);
    },
    findById(id: string): Task | undefined {
      const row = sql().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToTask(row) : undefined;
    },
    create(data: Omit<Task, 'id' | 'created_at' | 'status'> & { status?: Task['status'] }): Task {
      const task: Task = {
        id: genId(),
        status: data.status || 'pending',
        created_at: new Date().toISOString(),
        user_id: data.user_id,
        title: data.title,
        description: data.description,
        repo_url: data.repo_url,
        branch: data.branch,
      };
      sql().prepare(
        `INSERT INTO tasks (id, user_id, title, description, status, repo_url, branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.user_id, task.title, task.description, task.status, task.repo_url, task.branch, task.created_at);
      return task;
    },
    update(id: string, patch: Partial<Task>): Task | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      sql().prepare(
        `UPDATE tasks SET title = ?, description = ?, status = ?, repo_url = ?, branch = ?,
         completed_at = ?, merge_commit_sha = ? WHERE id = ?`,
      ).run(
        next.title,
        next.description,
        next.status,
        next.repo_url,
        next.branch,
        next.completed_at ?? null,
        next.merge_commit_sha ?? null,
        id,
      );
      return next;
    },
    remove(id: string): void {
      const database = sql();
      withTransaction(database, () => {
        const subIds = (database.prepare('SELECT id FROM sub_tasks WHERE task_id = ?').all(id) as Array<{ id: string }>).map((s) => s.id);
        for (const subId of subIds) {
          database.prepare('DELETE FROM log_entries WHERE sub_task_id = ?').run(subId);
        }
        database.prepare('DELETE FROM sub_tasks WHERE task_id = ?').run(id);
        database.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      });
    },
  },

  subTasks: {
    findAllByStatus(status: SubTask['status']): SubTask[] {
      const rows = sql().prepare('SELECT * FROM sub_tasks WHERE status = ?').all(status) as Record<string, unknown>[];
      return rows.map(rowToSubTask);
    },
    findAllByTaskId(taskId: string): SubTask[] {
      const rows = sql().prepare('SELECT * FROM sub_tasks WHERE task_id = ?').all(taskId) as Record<string, unknown>[];
      return rows.map(rowToSubTask);
    },
    findAllByDeviceId(deviceId: string): SubTask[] {
      const rows = sql().prepare('SELECT * FROM sub_tasks WHERE device_id = ?').all(deviceId) as Record<string, unknown>[];
      return rows.map(rowToSubTask);
    },
    findById(id: string): SubTask | undefined {
      const row = sql().prepare('SELECT * FROM sub_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToSubTask(row) : undefined;
    },
    create(data: Omit<SubTask, 'id' | 'created_at' | 'progress'> & { progress?: number }): SubTask {
      const sub: SubTask = {
        id: genId(),
        progress: data.progress ?? 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        task_id: data.task_id,
        device_id: data.device_id,
        tool_name: data.tool_name,
        status: data.status,
        branch_name: data.branch_name,
        title: data.title,
        description: data.description,
        depends_on: data.depends_on ?? [],
        sort_order: data.sort_order ?? 0,
        attempt_count: data.attempt_count ?? 0,
        max_attempts: data.max_attempts ?? 2,
        last_error: data.last_error,
      };
      sql().prepare(
        `INSERT INTO sub_tasks (
          id, task_id, device_id, tool_name, status, branch_name, progress, created_at, updated_at,
          title, description, depends_on, sort_order, attempt_count, max_attempts, last_error, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sub.id,
        sub.task_id,
        sub.device_id,
        sub.tool_name,
        sub.status,
        sub.branch_name,
        sub.progress,
        sub.created_at,
        sub.updated_at,
        sub.title ?? '',
        sub.description ?? '',
        JSON.stringify(sub.depends_on ?? []),
        sub.sort_order ?? 0,
        sub.attempt_count ?? 0,
        sub.max_attempts ?? 2,
        sub.last_error ?? null,
        null,
      );
      return sub;
    },
    update(id: string, patch: Partial<SubTask>): SubTask | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      sql().prepare(
        `UPDATE sub_tasks SET
          status = ?, branch_name = ?, progress = ?, completed_at = ?, device_id = ?,
          tool_name = ?, title = ?, description = ?, depends_on = ?, sort_order = ?,
          attempt_count = ?, max_attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.status,
        next.branch_name,
        next.progress,
        next.completed_at ?? null,
        next.device_id,
        next.tool_name,
        next.title ?? '',
        next.description ?? '',
        JSON.stringify(next.depends_on ?? []),
        next.sort_order ?? 0,
        next.attempt_count ?? 0,
        next.max_attempts ?? 2,
        next.last_error ?? null,
        new Date().toISOString(),
        id,
      );
      return next;
    },
  },

  logs: {
    findAllBySubTaskId(subTaskId: string): LogEntry[] {
      const rows = sql().prepare(
        'SELECT * FROM log_entries WHERE sub_task_id = ? ORDER BY timestamp ASC',
      ).all(subTaskId) as Record<string, unknown>[];
      return rows.map(rowToLog);
    },
    create(data: Omit<LogEntry, 'id' | 'timestamp'> & { timestamp?: string }): LogEntry {
      const log: LogEntry = {
        id: genId(),
        timestamp: data.timestamp || new Date().toISOString(),
        sub_task_id: data.sub_task_id,
        content: data.content,
        level: data.level,
      };
      sql().prepare(
        `INSERT INTO log_entries (id, sub_task_id, content, level, timestamp, device_id, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        log.id,
        log.sub_task_id,
        log.content,
        log.level,
        log.timestamp,
        log.device_id ?? null,
        log.task_id ?? null,
      );
      return log;
    },
  },
};

export type { User, Device, ToolStatusItem, Task, SubTask, LogEntry };
