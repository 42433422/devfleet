import { db, type SubTask, type Task } from '../db/store.js';
import { normalizeDevTool, selectExecutionDevices, type DevTool } from './utils.js';
import { broadcast, hasDevice, sendToDevice } from '../websocket/manager.js';

const MAX_ATTEMPTS_DEFAULT = 2;

export function parseDependsOn(value: unknown): string[] {
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

export function areDependenciesMet(sub: SubTask, subs: SubTask[]): boolean {
  const deps = parseDependsOn(sub.depends_on);
  if (deps.length === 0) return true;
  return deps.every((depId) => {
    const dep = subs.find((item) => item.id === depId);
    return dep?.status === 'completed';
  });
}

export function isSubBlocked(sub: SubTask, subs: SubTask[]): boolean {
  return sub.status === 'pending' && !areDependenciesMet(sub, subs);
}

function deviceCanExecute(deviceId: string): boolean {
  if (!hasDevice(deviceId)) return false;
  const device = db.devices.findById(deviceId);
  if (!device) return false;
  const tools = db.tools.findAllByDeviceId(deviceId);
  if (tools.length === 0) return true;
  const devTool = normalizeDevTool(device.dev_tool);
  const row = tools.find((t) => t.tool_name === devTool);
  return !row || row.status !== 'running' || !row.current_task;
}

export function pickDeviceForSub(
  userId: string,
  taskId: string,
  preferredDeviceId?: string,
  excludeDeviceIds: string[] = [],
): string | null {
  const exclude = new Set(excludeDeviceIds);
  if (preferredDeviceId && !exclude.has(preferredDeviceId) && deviceCanExecute(preferredDeviceId)) {
    return preferredDeviceId;
  }
  const online = db.devices.findAllByUserId(userId).filter((d) => hasDevice(d.id) && !exclude.has(d.id));
  const candidates = selectExecutionDevices(online);
  return candidates.find((d) => deviceCanExecute(d.id))?.id ?? null;
}

export function dispatchSubTask(userId: string, task: Task, sub: SubTask): boolean {
  if (!['pending', 'running'].includes(sub.status)) return false;
  const subs = db.subTasks.findAllByTaskId(task.id);
  if (!areDependenciesMet(sub, subs)) return false;
  if (!hasDevice(sub.device_id) || !deviceCanExecute(sub.device_id)) return false;

  const device = db.devices.findById(sub.device_id);
  const toolName = normalizeDevTool(device?.dev_tool || sub.tool_name);
  if (!db.tools.tryClaimRunning(sub.device_id, toolName, task.id)) return false;

  if (sub.status === 'pending') {
    db.subTasks.update(sub.id, { status: 'running' });
  }

  sendToDevice(sub.device_id, {
    type: 'execute_task',
    task_id: task.id,
    subtask_id: sub.id,
    title: sub.title || '子任务',
    description: sub.description || task.description,
    repo_url: task.repo_url,
    base_branch: task.branch,
    work_branch: sub.branch_name,
    tool: toolName,
    attempt: (sub.attempt_count ?? 0) + 1,
  });
  return true;
}

export function dispatchReadySubs(userId: string, taskId: string): number {
  const task = db.tasks.findById(taskId);
  if (!task) return 0;
  const subs = db.subTasks.findAllByTaskId(taskId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  let dispatched = 0;
  for (const sub of subs) {
    if (sub.status !== 'pending' && sub.status !== 'running') continue;
    if (!areDependenciesMet(sub, subs)) continue;
    if (sub.status === 'running') continue;
    if (dispatchSubTask(userId, task, sub)) dispatched += 1;
  }
  return dispatched;
}

export function handleSubTaskFailure(
  userId: string,
  taskId: string,
  subtaskId: string,
  errorMessage?: string,
): SubTask | null {
  const task = db.tasks.findById(taskId);
  const sub = db.subTasks.findById(subtaskId);
  if (!task || !sub || sub.task_id !== taskId) return null;

  const attempt = (sub.attempt_count ?? 0) + 1;
  const maxAttempts = sub.max_attempts ?? MAX_ATTEMPTS_DEFAULT;
  const failedDeviceId = sub.device_id;

  db.tools.upsert(sub.device_id, sub.tool_name, { status: 'idle', current_task: undefined });

  if (attempt < maxAttempts) {
    const nextDevice = pickDeviceForSub(userId, taskId, undefined, [failedDeviceId]);
    if (nextDevice) {
      const deviceName = db.devices.findById(nextDevice)?.name || nextDevice;
      const updated = db.subTasks.update(subtaskId, {
        status: 'pending',
        device_id: nextDevice,
        tool_name: normalizeDevTool(db.devices.findById(nextDevice)?.dev_tool || sub.tool_name),
        progress: 0,
        attempt_count: attempt,
        last_error: errorMessage || sub.last_error,
      });
      if (updated) {
        const log = db.logs.create({
          sub_task_id: sub.id,
          content: `子任务失败，自动换设备重试（第 ${attempt}/${maxAttempts} 次）→ ${deviceName}`,
          level: 'warn',
          device_id: nextDevice,
          task_id: taskId,
        });
        broadcast(userId, {
          type: 'task_log',
          task_id: taskId,
          subtask_id: sub.id,
          device_id: nextDevice,
          device_name: deviceName,
          log,
        });
        dispatchReadySubs(userId, taskId);
        return updated;
      }
    }
  }

  const updated = db.subTasks.update(subtaskId, {
    status: 'failed',
    progress: 0,
    attempt_count: attempt,
    completed_at: new Date().toISOString(),
    last_error: errorMessage || sub.last_error || '执行失败',
  });
  if (updated) {
    broadcast(userId, {
      type: 'task_progress',
      task_id: taskId,
      subtask_id: subtaskId,
      progress: 0,
      status: 'failed',
    });
  }
  return updated ?? null;
}

export function reconcileTask(userId: string, taskId: string) {
  const task = db.tasks.findById(taskId);
  if (!task) return null;
  const subs = db.subTasks.findAllByTaskId(taskId);

  dispatchReadySubs(userId, taskId);

  const terminal = subs.filter((s) => s.status === 'completed' || s.status === 'failed');
  const hasRetryableFailed = subs.some((s) => s.status === 'failed');
  const allCompleted = subs.length > 0 && subs.every((s) => s.status === 'completed');
  const anyRunning = subs.some((s) => s.status === 'running');
  const anyPendingReady = subs.some((s) => s.status === 'pending' && areDependenciesMet(s, subs));

  let nextStatus: Task['status'] = 'running';
  if (allCompleted) nextStatus = 'completed';
  else if (hasRetryableFailed && !anyRunning && !anyPendingReady) nextStatus = 'failed';

  if (task.status !== nextStatus) {
    db.tasks.update(taskId, {
      status: nextStatus,
      ...((nextStatus === 'completed' || nextStatus === 'failed') ? { completed_at: new Date().toISOString() } : {}),
    });
    broadcast(userId, { type: 'task_status', task_id: taskId, status: nextStatus });
  }

  terminal.forEach((sub) => {
    if (sub.status === 'completed' || sub.status === 'failed') {
      db.tools.upsert(sub.device_id, sub.tool_name, { status: 'idle', current_task: undefined });
    }
  });

  return task;
}

export function rescheduleDeviceTasks(userId: string, deviceId: string): void {
  const subs = db.subTasks.findAllByDeviceId(deviceId).filter((s) => s.status === 'running' || s.status === 'pending');
  for (const sub of subs) {
    const task = db.tasks.findById(sub.task_id);
    if (!task || task.user_id !== userId) continue;
    handleSubTaskFailure(userId, sub.task_id, sub.id, '设备离线，自动换设备重试');
  }
}

export function executorMissing(deviceId: string): boolean {
  const device = db.devices.findById(deviceId);
  if (!device) return true;
  const tools = db.tools.findAllByDeviceId(deviceId);
  if (tools.length === 0) return false;
  const devTool = normalizeDevTool(device.dev_tool) as DevTool;
  if (devTool === 'cursor') {
    const cursor = tools.find((t) => t.tool_name === 'cursor');
    return !cursor || cursor.status === 'not_installed';
  }
  if (devTool === 'trae') {
    const trae = tools.find((t) => t.tool_name === 'trae');
    return !trae || trae.status === 'not_installed';
  }
  const codex = tools.find((t) => t.tool_name === 'codex');
  return !codex || codex.status === 'not_installed';
}
