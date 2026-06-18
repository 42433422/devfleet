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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'merge_conflict' | 'merged';
  repo_url: string;
  branch: string;
  created_at: string;
  completed_at?: string;
  merge_commit_sha?: string;
  merge_conflict?: string;
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

interface CollabSession {
  id: string;
  user_id: string;
  device_id: string;
  task_id: string;
  title: string;
  status: 'open' | 'paused' | 'closed';
  repo_url: string;
  branch: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

interface CollabMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  task_id?: string;
  sub_task_id?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

interface RemoteCommandLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  content: string;
}

interface RemoteCommand {
  id: string;
  user_id: string;
  device_id: string;
  title: string;
  shell: 'powershell' | 'cmd' | 'sh' | 'bash';
  script: string;
  cwd?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  timeout_seconds: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  logs: RemoteCommandLog[];
  created_at: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
}

interface ModPackInstallation {
  id: string;
  user_id: string;
  pack_id: string;
  status: 'installed' | 'disabled';
  installed_at: string;
  updated_at: string;
}

interface ModPermissionGrant {
  id: string;
  user_id: string;
  pack_id: string;
  mod_id: string;
  permission_key: string;
  granted: boolean;
  reason?: string;
  updated_at: string;
}

interface ModAcceptanceCheckResult {
  id: string;
  title: string;
  status: 'passed' | 'failed';
  required: boolean;
  detail: string;
}

interface ModAcceptanceRun {
  id: string;
  user_id: string;
  pack_id: string;
  status: 'passed' | 'failed';
  score: number;
  check_results: ModAcceptanceCheckResult[];
  started_at: string;
  completed_at: string;
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
    merge_conflict: row.merge_conflict ? String(row.merge_conflict) : undefined,
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

function rowToCollabSession(row: Record<string, unknown>): CollabSession {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    device_id: String(row.device_id),
    task_id: String(row.task_id),
    title: String(row.title),
    status: String(row.status) as CollabSession['status'],
    repo_url: String(row.repo_url),
    branch: String(row.branch),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at ? String(row.closed_at) : undefined,
  };
}

function rowToCollabMessage(row: Record<string, unknown>): CollabMessage {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    role: String(row.role) as CollabMessage['role'],
    content: String(row.content),
    task_id: row.task_id ? String(row.task_id) : undefined,
    sub_task_id: row.sub_task_id ? String(row.sub_task_id) : undefined,
    status: String(row.status) as CollabMessage['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseRemoteCommandLogs(value: unknown): RemoteCommandLog[] {
  if (Array.isArray(value)) return value as RemoteCommandLog[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as RemoteCommandLog[] : [];
  } catch {
    return [];
  }
}

function rowToRemoteCommand(row: Record<string, unknown>): RemoteCommand {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    device_id: String(row.device_id),
    title: String(row.title),
    shell: String(row.shell) as RemoteCommand['shell'],
    script: String(row.script),
    cwd: row.cwd ? String(row.cwd) : undefined,
    status: String(row.status) as RemoteCommand['status'],
    timeout_seconds: Number(row.timeout_seconds),
    exit_code: row.exit_code === null || row.exit_code === undefined ? undefined : Number(row.exit_code),
    stdout: row.stdout ? String(row.stdout) : undefined,
    stderr: row.stderr ? String(row.stderr) : undefined,
    error: row.error ? String(row.error) : undefined,
    logs: parseRemoteCommandLogs(row.logs),
    created_at: String(row.created_at),
    started_at: row.started_at ? String(row.started_at) : undefined,
    completed_at: row.completed_at ? String(row.completed_at) : undefined,
    updated_at: String(row.updated_at),
  };
}

function rowToModInstallation(row: Record<string, unknown>): ModPackInstallation {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    pack_id: String(row.pack_id),
    status: String(row.status) as ModPackInstallation['status'],
    installed_at: String(row.installed_at),
    updated_at: String(row.updated_at),
  };
}

function rowToModPermissionGrant(row: Record<string, unknown>): ModPermissionGrant {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    pack_id: String(row.pack_id),
    mod_id: String(row.mod_id),
    permission_key: String(row.permission_key),
    granted: Boolean(row.granted),
    reason: row.reason ? String(row.reason) : undefined,
    updated_at: String(row.updated_at),
  };
}

function parseCheckResults(value: unknown): ModAcceptanceCheckResult[] {
  if (Array.isArray(value)) return value as ModAcceptanceCheckResult[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ModAcceptanceCheckResult[] : [];
  } catch {
    return [];
  }
}

function rowToModAcceptanceRun(row: Record<string, unknown>): ModAcceptanceRun {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    pack_id: String(row.pack_id),
    status: String(row.status) as ModAcceptanceRun['status'],
    score: Number(row.score),
    check_results: parseCheckResults(row.check_results),
    started_at: String(row.started_at),
    completed_at: String(row.completed_at),
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
         completed_at = ?, merge_commit_sha = ?, merge_conflict = ? WHERE id = ?`,
      ).run(
        next.title,
        next.description,
        next.status,
        next.repo_url,
        next.branch,
        next.completed_at ?? null,
        next.merge_commit_sha ?? null,
        next.merge_conflict ?? null,
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

  collabSessions: {
    findAllByUserId(userId: string): CollabSession[] {
      const rows = sql().prepare(
        'SELECT * FROM collab_sessions WHERE user_id = ? ORDER BY updated_at DESC',
      ).all(userId) as Record<string, unknown>[];
      return rows.map(rowToCollabSession);
    },
    findById(id: string): CollabSession | undefined {
      const row = sql().prepare('SELECT * FROM collab_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToCollabSession(row) : undefined;
    },
    findByTaskId(taskId: string): CollabSession | undefined {
      const row = sql().prepare('SELECT * FROM collab_sessions WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
      return row ? rowToCollabSession(row) : undefined;
    },
    create(data: Omit<CollabSession, 'id' | 'created_at' | 'updated_at' | 'status'> & { status?: CollabSession['status'] }): CollabSession {
      const now = new Date().toISOString();
      const session: CollabSession = {
        id: genId(),
        status: data.status || 'open',
        created_at: now,
        updated_at: now,
        user_id: data.user_id,
        device_id: data.device_id,
        task_id: data.task_id,
        title: data.title,
        repo_url: data.repo_url,
        branch: data.branch,
        closed_at: data.closed_at,
      };
      sql().prepare(
        `INSERT INTO collab_sessions (
          id, user_id, device_id, task_id, title, status, repo_url, branch,
          created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.user_id,
        session.device_id,
        session.task_id,
        session.title,
        session.status,
        session.repo_url,
        session.branch,
        session.created_at,
        session.updated_at,
        session.closed_at ?? null,
      );
      return session;
    },
    update(id: string, patch: Partial<CollabSession>): CollabSession | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, updated_at: new Date().toISOString() };
      sql().prepare(
        `UPDATE collab_sessions SET
          device_id = ?, task_id = ?, title = ?, status = ?, repo_url = ?, branch = ?,
          updated_at = ?, closed_at = ?
         WHERE id = ?`,
      ).run(
        next.device_id,
        next.task_id,
        next.title,
        next.status,
        next.repo_url,
        next.branch,
        next.updated_at,
        next.closed_at ?? null,
        id,
      );
      return next;
    },
  },

  collabMessages: {
    findAllBySessionId(sessionId: string): CollabMessage[] {
      const rows = sql().prepare(
        'SELECT * FROM collab_messages WHERE session_id = ? ORDER BY created_at ASC',
      ).all(sessionId) as Record<string, unknown>[];
      return rows.map(rowToCollabMessage);
    },
    findBySubTaskId(subTaskId: string): CollabMessage | undefined {
      const row = sql().prepare(
        "SELECT * FROM collab_messages WHERE sub_task_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
      ).get(subTaskId) as Record<string, unknown> | undefined;
      return row ? rowToCollabMessage(row) : undefined;
    },
    create(data: Omit<CollabMessage, 'id' | 'created_at' | 'updated_at' | 'status'> & { status?: CollabMessage['status'] }): CollabMessage {
      const now = new Date().toISOString();
      const message: CollabMessage = {
        id: genId(),
        status: data.status || 'queued',
        created_at: now,
        updated_at: now,
        session_id: data.session_id,
        role: data.role,
        content: data.content,
        task_id: data.task_id,
        sub_task_id: data.sub_task_id,
      };
      sql().prepare(
        `INSERT INTO collab_messages (
          id, session_id, role, content, task_id, sub_task_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id,
        message.session_id,
        message.role,
        message.content,
        message.task_id ?? null,
        message.sub_task_id ?? null,
        message.status,
        message.created_at,
        message.updated_at,
      );
      return message;
    },
    update(id: string, patch: Partial<CollabMessage>): CollabMessage | undefined {
      const currentRow = sql().prepare('SELECT * FROM collab_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!currentRow) return undefined;
      const current = rowToCollabMessage(currentRow);
      const next = { ...current, ...patch, updated_at: new Date().toISOString() };
      sql().prepare(
        `UPDATE collab_messages SET
          role = ?, content = ?, task_id = ?, sub_task_id = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.role,
        next.content,
        next.task_id ?? null,
        next.sub_task_id ?? null,
        next.status,
        next.updated_at,
        id,
      );
      return next;
    },
  },

  remoteCommands: {
    findAllByUserId(userId: string, limit = 100): RemoteCommand[] {
      const rows = sql().prepare(
        `SELECT * FROM remote_commands
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(userId, limit) as Record<string, unknown>[];
      return rows.map(rowToRemoteCommand);
    },
    findAllByDeviceId(deviceId: string, limit = 100): RemoteCommand[] {
      const rows = sql().prepare(
        `SELECT * FROM remote_commands
         WHERE device_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(deviceId, limit) as Record<string, unknown>[];
      return rows.map(rowToRemoteCommand);
    },
    findPendingByDeviceId(deviceId: string): RemoteCommand[] {
      const rows = sql().prepare(
        `SELECT * FROM remote_commands
         WHERE device_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      ).all(deviceId) as Record<string, unknown>[];
      return rows.map(rowToRemoteCommand);
    },
    findRunningByDeviceId(deviceId: string): RemoteCommand[] {
      const rows = sql().prepare(
        `SELECT * FROM remote_commands
         WHERE device_id = ? AND status = 'running'
         ORDER BY started_at ASC, created_at ASC`,
      ).all(deviceId) as Record<string, unknown>[];
      return rows.map(rowToRemoteCommand);
    },
    findById(id: string): RemoteCommand | undefined {
      const row = sql().prepare('SELECT * FROM remote_commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToRemoteCommand(row) : undefined;
    },
    create(data: Omit<RemoteCommand, 'id' | 'created_at' | 'updated_at' | 'logs' | 'status'> & {
      id?: string;
      status?: RemoteCommand['status'];
      logs?: RemoteCommandLog[];
    }): RemoteCommand {
      const now = new Date().toISOString();
      const command: RemoteCommand = {
        id: data.id || genId(),
        status: data.status || 'pending',
        created_at: now,
        updated_at: now,
        user_id: data.user_id,
        device_id: data.device_id,
        title: data.title,
        shell: data.shell,
        script: data.script,
        cwd: data.cwd,
        timeout_seconds: data.timeout_seconds,
        exit_code: data.exit_code,
        stdout: data.stdout,
        stderr: data.stderr,
        error: data.error,
        logs: data.logs || [],
        started_at: data.started_at,
        completed_at: data.completed_at,
      };
      sql().prepare(
        `INSERT INTO remote_commands (
          id, user_id, device_id, title, shell, script, cwd, status,
          timeout_seconds, exit_code, stdout, stderr, error, logs,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        command.id,
        command.user_id,
        command.device_id,
        command.title,
        command.shell,
        command.script,
        command.cwd ?? null,
        command.status,
        command.timeout_seconds,
        command.exit_code ?? null,
        command.stdout ?? null,
        command.stderr ?? null,
        command.error ?? null,
        JSON.stringify(command.logs),
        command.created_at,
        command.started_at ?? null,
        command.completed_at ?? null,
        command.updated_at,
      );
      return command;
    },
    update(id: string, patch: Partial<RemoteCommand>): RemoteCommand | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, updated_at: new Date().toISOString() };
      sql().prepare(
        `UPDATE remote_commands SET
          title = ?, shell = ?, script = ?, cwd = ?, status = ?,
          timeout_seconds = ?, exit_code = ?, stdout = ?, stderr = ?, error = ?,
          logs = ?, started_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.shell,
        next.script,
        next.cwd ?? null,
        next.status,
        next.timeout_seconds,
        next.exit_code ?? null,
        next.stdout ?? null,
        next.stderr ?? null,
        next.error ?? null,
        JSON.stringify(next.logs),
        next.started_at ?? null,
        next.completed_at ?? null,
        next.updated_at,
        id,
      );
      return next;
    },
    appendLog(id: string, log: Omit<RemoteCommandLog, 'timestamp'> & { timestamp?: string }): RemoteCommand | undefined {
      const current = this.findById(id);
      if (!current) return undefined;
      const nextLogs = [
        ...current.logs,
        {
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level,
          content: log.content,
        },
      ].slice(-500);
      return this.update(id, { logs: nextLogs });
    },
  },

  modInstallations: {
    findAllByUserId(userId: string): ModPackInstallation[] {
      const rows = sql().prepare(
        'SELECT * FROM mod_pack_installations WHERE user_id = ? ORDER BY updated_at DESC',
      ).all(userId) as Record<string, unknown>[];
      return rows.map(rowToModInstallation);
    },
    findByUserAndPack(userId: string, packId: string): ModPackInstallation | undefined {
      const row = sql().prepare(
        'SELECT * FROM mod_pack_installations WHERE user_id = ? AND pack_id = ?',
      ).get(userId, packId) as Record<string, unknown> | undefined;
      return row ? rowToModInstallation(row) : undefined;
    },
    upsertInstalled(userId: string, packId: string, status: ModPackInstallation['status'] = 'installed'): ModPackInstallation {
      const current = this.findByUserAndPack(userId, packId);
      const now = new Date().toISOString();
      if (current) {
        sql().prepare(
          'UPDATE mod_pack_installations SET status = ?, updated_at = ? WHERE id = ?',
        ).run(status, now, current.id);
        return { ...current, status, updated_at: now };
      }

      const installation: ModPackInstallation = {
        id: genId(),
        user_id: userId,
        pack_id: packId,
        status,
        installed_at: now,
        updated_at: now,
      };
      sql().prepare(
        `INSERT INTO mod_pack_installations (id, user_id, pack_id, status, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        installation.id,
        installation.user_id,
        installation.pack_id,
        installation.status,
        installation.installed_at,
        installation.updated_at,
      );
      return installation;
    },
    updateStatus(userId: string, packId: string, status: ModPackInstallation['status']): ModPackInstallation | undefined {
      const current = this.findByUserAndPack(userId, packId);
      if (!current) return undefined;
      const updatedAt = new Date().toISOString();
      sql().prepare(
        'UPDATE mod_pack_installations SET status = ?, updated_at = ? WHERE id = ?',
      ).run(status, updatedAt, current.id);
      return { ...current, status, updated_at: updatedAt };
    },
  },

  modPermissions: {
    findAllByUserAndPack(userId: string, packId: string): ModPermissionGrant[] {
      const rows = sql().prepare(
        `SELECT * FROM mod_permission_grants
         WHERE user_id = ? AND pack_id = ?
         ORDER BY mod_id ASC, permission_key ASC`,
      ).all(userId, packId) as Record<string, unknown>[];
      return rows.map(rowToModPermissionGrant);
    },
    findBySpec(userId: string, packId: string, modId: string, permissionKey: string): ModPermissionGrant | undefined {
      const row = sql().prepare(
        `SELECT * FROM mod_permission_grants
         WHERE user_id = ? AND pack_id = ? AND mod_id = ? AND permission_key = ?`,
      ).get(userId, packId, modId, permissionKey) as Record<string, unknown> | undefined;
      return row ? rowToModPermissionGrant(row) : undefined;
    },
    upsert(data: Omit<ModPermissionGrant, 'id' | 'updated_at'> & { id?: string; updated_at?: string }): ModPermissionGrant {
      const current = this.findBySpec(data.user_id, data.pack_id, data.mod_id, data.permission_key);
      const updatedAt = data.updated_at || new Date().toISOString();
      if (current) {
        const next: ModPermissionGrant = {
          ...current,
          granted: data.granted,
          reason: data.reason,
          updated_at: updatedAt,
        };
        sql().prepare(
          `UPDATE mod_permission_grants
           SET granted = ?, reason = ?, updated_at = ?
           WHERE id = ?`,
        ).run(next.granted ? 1 : 0, next.reason ?? null, next.updated_at, next.id);
        return next;
      }

      const grant: ModPermissionGrant = {
        id: data.id || genId(),
        user_id: data.user_id,
        pack_id: data.pack_id,
        mod_id: data.mod_id,
        permission_key: data.permission_key,
        granted: data.granted,
        reason: data.reason,
        updated_at: updatedAt,
      };
      sql().prepare(
        `INSERT INTO mod_permission_grants (
          id, user_id, pack_id, mod_id, permission_key, granted, reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        grant.id,
        grant.user_id,
        grant.pack_id,
        grant.mod_id,
        grant.permission_key,
        grant.granted ? 1 : 0,
        grant.reason ?? null,
        grant.updated_at,
      );
      return grant;
    },
  },

  modAcceptanceRuns: {
    findAllByUserAndPack(userId: string, packId: string): ModAcceptanceRun[] {
      const rows = sql().prepare(
        `SELECT * FROM mod_acceptance_runs
         WHERE user_id = ? AND pack_id = ?
         ORDER BY completed_at DESC`,
      ).all(userId, packId) as Record<string, unknown>[];
      return rows.map(rowToModAcceptanceRun);
    },
    findLatestByUserAndPack(userId: string, packId: string): ModAcceptanceRun | undefined {
      const row = sql().prepare(
        `SELECT * FROM mod_acceptance_runs
         WHERE user_id = ? AND pack_id = ?
         ORDER BY completed_at DESC
         LIMIT 1`,
      ).get(userId, packId) as Record<string, unknown> | undefined;
      return row ? rowToModAcceptanceRun(row) : undefined;
    },
    create(data: Omit<ModAcceptanceRun, 'id' | 'started_at' | 'completed_at'> & { started_at?: string; completed_at?: string }): ModAcceptanceRun {
      const now = new Date().toISOString();
      const run: ModAcceptanceRun = {
        id: genId(),
        user_id: data.user_id,
        pack_id: data.pack_id,
        status: data.status,
        score: data.score,
        check_results: data.check_results,
        started_at: data.started_at || now,
        completed_at: data.completed_at || now,
      };
      sql().prepare(
        `INSERT INTO mod_acceptance_runs (
          id, user_id, pack_id, status, score, check_results, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.user_id,
        run.pack_id,
        run.status,
        run.score,
        JSON.stringify(run.check_results),
        run.started_at,
        run.completed_at,
      );
      return run;
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

export type {
  User,
  Device,
  ToolStatusItem,
  Task,
  SubTask,
  LogEntry,
  CollabSession,
  CollabMessage,
  RemoteCommand,
  RemoteCommandLog,
  ModPackInstallation,
  ModPermissionGrant,
  ModAcceptanceCheckResult,
  ModAcceptanceRun,
};
