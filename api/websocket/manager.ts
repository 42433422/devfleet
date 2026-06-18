import type { WebSocket, Server as WSServer } from 'ws';
import { db, type RemoteCommand } from '../db/store.js';
import { verifyToken } from '../middleware/auth.js';
import { normalizeDevTool } from '../lib/utils.js';
import { parseCapabilities } from '../lib/capabilities.js';
import {
  dispatchPendingForDevice,
  dispatchReadySubs,
  handleSubTaskFailure,
  reconcileTask,
  rescheduleDeviceTasks,
} from '../lib/dispatch.js';
import { syncCollabMessageForSubtask } from '../lib/collab.js';
import type { ToolStatusItem } from '../db/store.js';

type ClientWS = WebSocket & {
  _userId?: string;
  _deviceId?: string;
  _heartbeatTimer?: ReturnType<typeof setInterval>;
  _pongTimer?: ReturnType<typeof setTimeout>;
};

interface WSMessage {
  type: string;
  tools?: Array<Pick<ToolStatusItem, 'tool_name' | 'status' | 'current_task'>>;
  capabilities?: Record<string, unknown>;
  task_id?: string;
  subtask_id?: string;
  progress?: number;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  content?: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
  command_id?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

const clients: Set<ClientWS> = new Set();
const deviceWS = new Map<string, WebSocket>();
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteCommandTimers = new Map<string, ReturnType<typeof setTimeout>>();
const HEARTBEAT_MS = Number(process.env.DEVFLEET_WS_HEARTBEAT_MS) || 30_000;
const PONG_TIMEOUT_MS = Number(process.env.DEVFLEET_WS_PONG_TIMEOUT_MS) || 10_000;
const REMOTE_COMMAND_TIMEOUT_GRACE_MS = Number(process.env.DEVFLEET_REMOTE_COMMAND_TIMEOUT_GRACE_MS) || 5_000;
const DEVICE_LINK_HEALTHY_MS = Number(process.env.DEVFLEET_DEVICE_LINK_HEALTHY_MS)
  || (HEARTBEAT_MS * 2 + PONG_TIMEOUT_MS + 5_000);
const DEVICE_LINK_STALE_MS = Number(process.env.DEVFLEET_DEVICE_LINK_STALE_MS) || (DEVICE_LINK_HEALTHY_MS * 2);

interface DeviceLinkState {
  deviceId: string;
  connectedAtMs: number;
  lastSeenMs: number;
  lastPongMs?: number;
  lastReason: string;
}

const deviceLinks = new Map<string, DeviceLinkState>();

function clearHeartbeat(ws: ClientWS | WebSocket) {
  const socket = ws as ClientWS;
  if (socket._heartbeatTimer) {
    clearInterval(socket._heartbeatTimer);
    socket._heartbeatTimer = undefined;
  }
  if (socket._pongTimer) {
    clearTimeout(socket._pongTimer);
    socket._pongTimer = undefined;
  }
}

function schedulePongTimeout(ws: ClientWS) {
  if (ws._pongTimer) clearTimeout(ws._pongTimer);
  ws._pongTimer = setTimeout(() => {
    const deviceId = ws._deviceId;
    console.warn(
      `WebSocket pong timeout${deviceId ? ` for device ${deviceId}` : ''}; terminating stale connection`,
    );
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }, PONG_TIMEOUT_MS);
}

function markDeviceLinkHealthy(deviceId: string, reason: string) {
  const now = Date.now();
  const state = deviceLinks.get(deviceId);
  if (state) {
    state.lastSeenMs = now;
    state.lastReason = reason;
    return;
  }
  deviceLinks.set(deviceId, {
    deviceId,
    connectedAtMs: now,
    lastSeenMs: now,
    lastReason: reason,
  });
}

function markDevicePong(deviceId: string) {
  const now = Date.now();
  const state = deviceLinks.get(deviceId);
  if (state) {
    state.lastSeenMs = now;
    state.lastPongMs = now;
    state.lastReason = '收到 pong';
    return;
  }
  deviceLinks.set(deviceId, {
    deviceId,
    connectedAtMs: now,
    lastSeenMs: now,
    lastPongMs: now,
    lastReason: '收到 pong',
  });
}

function clearDeviceLink(deviceId: string) {
  deviceLinks.delete(deviceId);
}

function clearOfflineTimer(deviceId: string) {
  const timer = offlineTimers.get(deviceId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(deviceId);
  }
}

export function getDeviceLinkHealth(deviceId: string) {
  const state = deviceLinks.get(deviceId);
  if (!state || !deviceWS.has(deviceId)) {
    return { healthy: false, reason: '设备离线（无 WebSocket）', lastReason: state?.lastReason };
  }
  const now = Date.now();
  const lastActive = state.lastPongMs || state.lastSeenMs;
  if (now - lastActive > DEVICE_LINK_STALE_MS) {
    return {
      healthy: false,
      reason: `链路长时间无响应（${Math.round((now - lastActive) / 1000)}s）`,
      lastReason: state.lastReason,
    };
  }
  if (now - lastActive > DEVICE_LINK_HEALTHY_MS) {
    return {
      healthy: false,
      reason: `链路心跳抖动（${Math.round((now - lastActive) / 1000)}s）`,
      lastReason: state.lastReason,
    };
  }
  return { healthy: true, reason: '链路正常', lastReason: state.lastReason };
}

function startHeartbeat(ws: ClientWS) {
  clearHeartbeat(ws);
  ws._heartbeatTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearHeartbeat(ws);
      return;
    }
    try {
      ws.ping();
      schedulePongTimeout(ws);
    } catch {
      clearHeartbeat(ws);
      ws.terminate();
    }
  }, HEARTBEAT_MS);
}

function handleAppMessage(ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]) {
  try {
    const msg = JSON.parse(raw.toString()) as WSMessage;
    if (msg.type === 'ping') {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      const socket = ws as ClientWS;
      if (socket._deviceId) {
        markDeviceLinkHealthy(socket._deviceId, '收到客户端心跳');
      }
    }
  } catch {
    // ignore non-json frames
  }
}

function serializeRemoteCommand(command: RemoteCommand) {
  return {
    id: command.id,
    user_id: command.user_id,
    device_id: command.device_id,
    title: command.title,
    shell: command.shell,
    script: command.script,
    cwd: command.cwd,
    status: command.status,
    timeout_seconds: command.timeout_seconds,
    exit_code: command.exit_code,
    stdout: command.stdout,
    stderr: command.stderr,
    error: command.error,
    logs: command.logs,
    created_at: command.created_at,
    started_at: command.started_at,
    completed_at: command.completed_at,
    updated_at: command.updated_at,
  };
}

function remoteCommandDeadlineMs(command: RemoteCommand) {
  const startedMs = Date.parse(command.started_at || command.updated_at || command.created_at);
  const baseMs = Number.isFinite(startedMs) ? startedMs : Date.now();
  return baseMs + command.timeout_seconds * 1000 + REMOTE_COMMAND_TIMEOUT_GRACE_MS;
}

function clearRemoteCommandTimer(commandId: string) {
  const timer = remoteCommandTimers.get(commandId);
  if (timer) {
    clearTimeout(timer);
    remoteCommandTimers.delete(commandId);
  }
}

function remoteCommandTimeoutError(command: RemoteCommand) {
  return `Remote command timed out after ${command.timeout_seconds}s without device result`;
}

export function reconcileRemoteCommandTimeout(command: RemoteCommand): RemoteCommand {
  if (command.status !== 'running') {
    clearRemoteCommandTimer(command.id);
    return command;
  }
  if (Date.now() < remoteCommandDeadlineMs(command)) return command;

  clearRemoteCommandTimer(command.id);
  const completedAt = new Date().toISOString();
  const error = remoteCommandTimeoutError(command);
  const updated = db.remoteCommands.update(command.id, {
    status: 'failed',
    error,
    completed_at: completedAt,
    logs: [
      ...command.logs,
      { timestamp: completedAt, level: 'error', content: error },
    ].slice(-500),
  });
  if (updated) {
    broadcast(updated.user_id, {
      type: 'remote_command_result',
      device_id: updated.device_id,
      command_id: updated.id,
      command: serializeRemoteCommand(updated),
    });
    return updated;
  }
  return command;
}

function scheduleRemoteCommandTimeout(command: RemoteCommand) {
  clearRemoteCommandTimer(command.id);
  if (command.status !== 'running') return;
  const delay = Math.max(0, remoteCommandDeadlineMs(command) - Date.now());
  remoteCommandTimers.set(command.id, setTimeout(() => {
    const latest = db.remoteCommands.findById(command.id);
    if (latest) reconcileRemoteCommandTimeout(latest);
  }, delay));
}

export function reconcileRemoteCommandTimeoutsForDevice(deviceId: string) {
  for (const command of db.remoteCommands.findRunningByDeviceId(deviceId)) {
    const updated = reconcileRemoteCommandTimeout(command);
    if (updated.status === 'running') scheduleRemoteCommandTimeout(updated);
  }
}

export function sendRemoteCommandToDevice(command: RemoteCommand): RemoteCommand | undefined {
  const newAttempt = command.status !== 'running' || !command.started_at;
  const startedAt = newAttempt ? new Date().toISOString() : command.started_at;
  const running = db.remoteCommands.update(command.id, {
    status: 'running',
    started_at: startedAt,
    completed_at: newAttempt ? undefined : command.completed_at,
    error: undefined,
  });
  if (!running) return undefined;
  scheduleRemoteCommandTimeout(running);
  const sent = sendToDevice(running.device_id, {
    type: 'execute_command',
    command_id: running.id,
    title: running.title,
    shell: running.shell,
    script: running.script,
    cwd: running.cwd,
    timeout_seconds: running.timeout_seconds,
  });
  if (!sent) {
    clearRemoteCommandTimer(running.id);
    const queuedAt = new Date().toISOString();
    return db.remoteCommands.update(running.id, {
      status: 'pending',
      started_at: undefined,
      error: '设备连接已断开，等待重连后补发',
      logs: [
        ...running.logs,
        {
          timestamp: queuedAt,
          level: 'warn',
          content: '设备连接已断开，命令保持排队，等待重连后自动补发',
        },
      ].slice(-500),
    });
  }
  broadcast(running.user_id, {
    type: 'remote_command',
    device_id: running.device_id,
    command: serializeRemoteCommand(running),
  });
  return running;
}

function dispatchPendingRemoteCommandsForDevice(deviceId: string) {
  reconcileRemoteCommandTimeoutsForDevice(deviceId);
  for (const command of db.remoteCommands.findPendingByDeviceId(deviceId)) {
    sendRemoteCommandToDevice(command);
  }
}

export function attachWebSocket(wss: WSServer) {
  wss.on('connection', (ws: ClientWS, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    ws.on('pong', () => {
      if (ws._pongTimer) {
        clearTimeout(ws._pongTimer);
        ws._pongTimer = undefined;
      }
      if (ws._deviceId) {
        markDevicePong(ws._deviceId);
      }
    });
    ws.on('ping', () => {
      if (ws._pongTimer) {
        clearTimeout(ws._pongTimer);
        ws._pongTimer = undefined;
      }
      if (ws._deviceId) {
        markDeviceLinkHealthy(ws._deviceId, '收到设备 ping');
      }
    });

    if (pathname.startsWith('/ws/client')) {
      const token = url.searchParams.get('token') || '';
      const user = verifyToken(token);
      if (!user) {
        ws.close(4001, '未授权');
        return;
      }
      ws._userId = user.id;
      clients.add(ws);
      startHeartbeat(ws);
      ws.on('message', (raw) => handleAppMessage(ws, raw));
      ws.on('close', () => {
        clearHeartbeat(ws);
        clients.delete(ws);
      });
      ws.on('error', (err) => {
        console.error('Client WebSocket error:', err);
      });
      return;
    }

    if (pathname.startsWith('/ws/device')) {
      const deviceToken = url.searchParams.get('token') || '';
      const device = db.devices.findByDeviceToken(deviceToken);
      if (!device) {
        ws.close(4001, '设备令牌无效');
        return;
      }
      const previous = deviceWS.get(device.id);
      if (previous && previous !== ws) previous.close(4000, '设备已在新的连接上线');
      clearOfflineTimer(device.id);
      ws._deviceId = device.id;
      deviceWS.set(device.id, ws);
      markDeviceLinkHealthy(device.id, '连接已建立');
      startHeartbeat(ws);
      db.devices.update(device.id, { status: 'online', activated: true });
      sendBindingIdentity(device.id);
      broadcast(device.user_id, {
        type: 'device_status',
        device_id: device.id,
        status: 'online',
      });
      dispatchPendingRemoteCommandsForDevice(device.id);
      for (const taskId of dispatchPendingForDevice(device.user_id, device.id)) {
        reconcileTask(device.user_id, taskId);
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WSMessage;
          if (msg.type === 'ping') {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            markDeviceLinkHealthy(device.id, '收到设备心跳');
            return;
          }

          if (msg.type === 'tool_status') {
            markDeviceLinkHealthy(device.id, '工具状态上报');
            if (!msg.capabilities || typeof msg.capabilities !== 'object') {
              return;
            }
            db.tools.bulkUpsert(device.id, msg.tools || []);
            if (msg.capabilities) {
              const caps = { ...msg.capabilities, updated_at: new Date().toISOString() };
              db.devices.update(device.id, { capabilities: JSON.stringify(caps) });
            }
            const tools = (msg.tools || []).map((t) => ({
              toolName: t.tool_name,
              status: t.status,
              currentTask: t.current_task,
            }));
            const caps = msg.capabilities ? parseCapabilities(msg.capabilities) : parseCapabilities(device.capabilities);
            broadcast(device.user_id, {
              type: 'device_status',
              device_id: device.id,
              status: 'online',
              tools,
              capabilities: caps,
            });
            return;
          }

          if (msg.type === 'task_progress' && msg.task_id && msg.subtask_id) {
            markDeviceLinkHealthy(device.id, '任务进度上报');
            const task = db.tasks.findById(msg.task_id);
            const sub = db.subTasks.findById(msg.subtask_id);
            if (!task || !sub || task.user_id !== device.user_id || sub.task_id !== task.id || sub.device_id !== device.id) return;
            const progress = typeof msg.progress === 'number' ? Math.max(0, Math.min(100, msg.progress)) : sub.progress;
            const status = msg.status || (progress === 100 ? 'completed' : 'running');
            if (status === 'failed') {
              const finalSubTask = handleSubTaskFailure(device.user_id, task.id, sub.id, '设备上报失败') || sub;
              const collab = syncCollabMessageForSubtask(sub.id, finalSubTask.status, msg.content || '设备上报失败');
              if (collab) {
                broadcast(device.user_id, {
                  type: 'collab_message',
                  session_id: collab.session.id,
                  message: collab.assistantMessage || collab.userMessage,
                });
              }
              reconcileTask(device.user_id, task.id);
              return;
            }
            const updated = db.subTasks.update(sub.id, {
              progress,
              status,
              ...(status === 'completed' || status === 'failed' ? { completed_at: new Date().toISOString() } : {}),
            });
            if (!updated) return;
            if (status === 'completed' || status === 'failed') {
              db.tools.upsert(device.id, sub.tool_name, { status: 'idle', current_task: undefined });
            }
            broadcast(device.user_id, {
              type: 'task_progress',
              task_id: task.id,
              subtask_id: sub.id,
              progress: updated.progress,
              status: updated.status,
            });
            const collab = syncCollabMessageForSubtask(
              sub.id,
              updated.status,
              msg.content || (updated.status === 'completed' ? '远端设备上报完成' : undefined),
            );
            if (collab) {
              broadcast(device.user_id, {
                type: 'collab_message',
                session_id: collab.session.id,
                message: collab.assistantMessage || collab.userMessage,
              });
            }
            if (status === 'completed') {
              dispatchReadySubs(device.user_id, task.id);
            }
            reconcileTask(device.user_id, task.id);
            return;
          }

          if (msg.type === 'command_log' && msg.command_id && msg.content?.trim()) {
            markDeviceLinkHealthy(device.id, '远程命令日志上报');
            const command = db.remoteCommands.findById(msg.command_id);
            if (!command || command.user_id !== device.user_id || command.device_id !== device.id) return;
            const updated = db.remoteCommands.appendLog(command.id, {
              content: msg.content.trim(),
              level: msg.level || 'info',
            });
            if (!updated) return;
            broadcast(device.user_id, {
              type: 'remote_command_log',
              device_id: device.id,
              command_id: command.id,
              command: serializeRemoteCommand(updated),
            });
            return;
          }

          if (msg.type === 'command_result' && msg.command_id) {
            markDeviceLinkHealthy(device.id, '远程命令结果上报');
            const command = db.remoteCommands.findById(msg.command_id);
            if (!command || command.user_id !== device.user_id || command.device_id !== device.id) return;
            clearRemoteCommandTimer(command.id);
            const exitCode = typeof msg.exit_code === 'number' ? msg.exit_code : undefined;
            const status = msg.status === 'completed' || (msg.status !== 'failed' && exitCode === 0)
              ? 'completed'
              : 'failed';
            const updated = db.remoteCommands.update(command.id, {
              status,
              exit_code: exitCode,
              stdout: msg.stdout,
              stderr: msg.stderr,
              error: msg.error,
              started_at: msg.started_at || command.started_at,
              completed_at: msg.completed_at || new Date().toISOString(),
            });
            if (!updated) return;
            broadcast(device.user_id, {
              type: 'remote_command_result',
              device_id: device.id,
              command_id: command.id,
              command: serializeRemoteCommand(updated),
            });
            return;
          }

          if (msg.type === 'task_log' && msg.task_id && msg.subtask_id && msg.content?.trim()) {
            markDeviceLinkHealthy(device.id, '任务日志上报');
            const task = db.tasks.findById(msg.task_id);
            const sub = db.subTasks.findById(msg.subtask_id);
            if (!task || !sub || task.user_id !== device.user_id || sub.task_id !== task.id || sub.device_id !== device.id) return;
            const log = db.logs.create({
              sub_task_id: sub.id,
              content: msg.content.trim(),
              level: msg.level || 'info',
              device_id: device.id,
              task_id: task.id,
            });
            broadcast(device.user_id, {
              type: 'task_log',
              task_id: task.id,
              subtask_id: sub.id,
              device_id: device.id,
              device_name: device.name,
              log,
            });
          }
        } catch (err) {
          console.error('Device message parse error:', err);
        }
      });

      ws.on('close', () => {
        clearHeartbeat(ws);
        if (deviceWS.get(device.id) !== ws) return;
        const closedSocket = ws;
        deviceWS.delete(device.id);
        clearDeviceLink(device.id);
        const hasRunning = db.subTasks.findAllByDeviceId(device.id).some((s) => s.status === 'running');
        const offlineDelayMs = hasRunning ? 120_000 : 8_000;
        clearOfflineTimer(device.id);
        const timer = setTimeout(() => {
          offlineTimers.delete(device.id);
          const current = deviceWS.get(device.id);
          if (current && current !== closedSocket && current.readyState === current.OPEN) return;
          if (current === closedSocket) return;
          db.devices.update(device.id, { status: 'offline' });
          rescheduleDeviceTasks(device.user_id, device.id);
          broadcast(device.user_id, {
            type: 'device_status',
            device_id: device.id,
            status: 'offline',
          });
        }, offlineDelayMs);
        offlineTimers.set(device.id, timer);
      });

      ws.on('error', (err) => {
        console.error('Device WebSocket error:', err);
      });
      return;
    }

    ws.close(4004, '未知路径');
  });
}

interface BroadcastMessage {
  type: string;
  device_id?: string;
  task_id?: string;
  subtask_id?: string;
  status?: string;
  progress?: number;
  commit_sha?: string;
  tools?: Array<{ toolName: string; status: string; currentTask?: string }>;
  log?: { id: string; content: string; level: string; timestamp: string };
  [key: string]: unknown;
}

export function broadcast(userId: string, msg: BroadcastMessage) {
  const payload = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws._userId === userId && ws.readyState === ws.OPEN) {
      try {
        ws.send(payload);
      } catch (err) {
        console.error('Broadcast send error:', err);
      }
    }
  });
}

export function sendToDevice(deviceId: string, msg: Record<string, unknown>): boolean {
  const ws = deviceWS.get(deviceId);
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('Send to device error:', err);
    }
  }
  return false;
}

export function sendBindingIdentity(deviceId: string) {
  const device = db.devices.findById(deviceId);
  if (!device) return;
  const owner = db.users.findById(device.user_id);
  const primaryDevice = db.devices.findAllByUserId(device.user_id).find((item) => item.is_primary);
  sendToDevice(deviceId, {
    type: 'binding_identity',
    controller: {
      id: device.user_id,
      email: owner?.email || '未知账号',
      primaryDevice: primaryDevice ? { id: primaryDevice.id, name: primaryDevice.name } : null,
    },
    devTool: normalizeDevTool(device.dev_tool),
  });
}

export function sendBindingIdentityToUser(userId: string) {
  db.devices.findAllByUserId(userId).forEach((device) => sendBindingIdentity(device.id));
}

export function hasDevice(deviceId: string) {
  return deviceWS.has(deviceId);
}

export function disconnectDeviceSocket(deviceId: string, reason = '设备已断开') {
  const socket = deviceWS.get(deviceId);
  if (socket) {
    deviceWS.delete(deviceId);
    socket.close(4000, reason);
  }
  clearDeviceLink(deviceId);
  clearOfflineTimer(deviceId);
}

export function getOnlineDeviceIds() {
  return Array.from(deviceWS.keys());
}

export function resetWebSocketStateForTest() {
  for (const socket of clients) {
    clearHeartbeat(socket);
    try {
      socket.terminate();
    } catch {
      // ignore test cleanup errors
    }
  }
  clients.clear();

  for (const [deviceId, socket] of deviceWS) {
    clearHeartbeat(socket);
    clearDeviceLink(deviceId);
    try {
      socket.terminate();
    } catch {
      // ignore test cleanup errors
    }
  }
  deviceWS.clear();

  for (const timer of offlineTimers.values()) {
    clearTimeout(timer);
  }
  offlineTimers.clear();
  for (const timer of remoteCommandTimers.values()) {
    clearTimeout(timer);
  }
  remoteCommandTimers.clear();
  deviceLinks.clear();
}
