import type { WebSocket, Server as WSServer } from 'ws';
import { db } from '../db/store.js';
import { verifyToken } from '../middleware/auth.js';
import type { ToolStatusItem } from '../db/store.js';

type ClientWS = WebSocket & { _userId?: string };

interface WSMessage {
  type: string;
  tools?: Array<Pick<ToolStatusItem, 'tool_name' | 'status' | 'current_task'>>;
  task_id?: string;
  subtask_id?: string;
  progress?: number;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  content?: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

const clients: Set<ClientWS> = new Set();
const deviceWS = new Map<string, WebSocket>();

function reconcileTask(userId: string, taskId: string) {
  const task = db.tasks.findById(taskId);
  if (!task) return;
  const subs = db.subTasks.findAllByTaskId(taskId);
  const nextStatus = subs.some((sub) => sub.status === 'failed')
    ? 'failed'
    : subs.length > 0 && subs.every((sub) => sub.status === 'completed')
      ? 'completed'
      : 'running';
  if (task.status !== nextStatus) {
    db.tasks.update(taskId, {
      status: nextStatus,
      ...((nextStatus === 'completed' || nextStatus === 'failed') ? { completed_at: new Date().toISOString() } : {}),
    });
    broadcast(userId, { type: 'task_status', task_id: taskId, status: nextStatus });
  }
}

export function attachWebSocket(wss: WSServer) {
  wss.on('connection', (ws: ClientWS, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/ws/client')) {
      const token = url.searchParams.get('token') || '';
      const user = verifyToken(token);
      if (!user) {
        ws.close(4001, '未授权');
        return;
      }
      ws._userId = user.id;
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
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
      deviceWS.set(device.id, ws);
      db.devices.update(device.id, { status: 'online', activated: true });
      sendBindingIdentity(device.id);
      broadcast(device.user_id, {
        type: 'device_status',
        device_id: device.id,
        status: 'online',
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WSMessage;
          if (msg.type === 'tool_status') {
            db.tools.bulkUpsert(device.id, msg.tools || []);
            const tools = (msg.tools || []).map((t) => ({
              toolName: t.tool_name,
              status: t.status,
              currentTask: t.current_task,
            }));
            broadcast(device.user_id, {
              type: 'device_status',
              device_id: device.id,
              status: 'online',
              tools,
            });
            return;
          }

          if (msg.type === 'task_progress' && msg.task_id && msg.subtask_id) {
            const task = db.tasks.findById(msg.task_id);
            const sub = db.subTasks.findById(msg.subtask_id);
            if (!task || !sub || task.user_id !== device.user_id || sub.task_id !== task.id || sub.device_id !== device.id) return;
            const progress = typeof msg.progress === 'number' ? Math.max(0, Math.min(100, msg.progress)) : sub.progress;
            const status = msg.status || (progress === 100 ? 'completed' : 'running');
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
            reconcileTask(device.user_id, task.id);
            return;
          }

          if (msg.type === 'task_log' && msg.task_id && msg.subtask_id && msg.content?.trim()) {
            const task = db.tasks.findById(msg.task_id);
            const sub = db.subTasks.findById(msg.subtask_id);
            if (!task || !sub || task.user_id !== device.user_id || sub.task_id !== task.id || sub.device_id !== device.id) return;
            const log = db.logs.create({
              sub_task_id: sub.id,
              content: msg.content.trim(),
              level: msg.level || 'info',
            });
            broadcast(device.user_id, {
              type: 'task_log',
              task_id: task.id,
              subtask_id: sub.id,
              log,
            });
          }
        } catch (err) {
          console.error('Device message parse error:', err);
        }
      });

      ws.on('close', () => {
        if (deviceWS.get(device.id) !== ws) return;
        deviceWS.delete(device.id);
        db.devices.update(device.id, { status: 'offline' });
        broadcast(device.user_id, {
          type: 'device_status',
          device_id: device.id,
          status: 'offline',
        });
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

export function sendToDevice(deviceId: string, msg: Record<string, unknown>) {
  const ws = deviceWS.get(deviceId);
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch (err) {
      console.error('Send to device error:', err);
    }
  }
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
}

export function getOnlineDeviceIds() {
  return Array.from(deviceWS.keys());
}
