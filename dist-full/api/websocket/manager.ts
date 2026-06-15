import type { WebSocket, Server as WSServer } from 'ws';
import { db } from '../db/store.js';
import { verifyToken } from '../middleware/auth.js';
import type { ToolStatusItem } from '../db/store.js';

type ClientWS = WebSocket & { _userId?: string };

interface WSMessage {
  type: string;
  tools?: Array<Pick<ToolStatusItem, 'tool_name' | 'status' | 'current_task'>>;
}

const clients: Set<ClientWS> = new Set();
const deviceWS = new Map<string, WebSocket>();

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
      const bindCode = url.searchParams.get('bindCode') || '';
      const device = db.devices.findByBindCode(bindCode);
      if (!device) {
        ws.close(4001, '绑定码无效');
        return;
      }
      deviceWS.set(device.id, ws);
      db.devices.update(device.id, { status: 'online' });
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
          }
        } catch (err) {
          console.error('Device message parse error:', err);
        }
      });

      ws.on('close', () => {
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

export function hasDevice(deviceId: string) {
  return deviceWS.has(deviceId);
}

export function getOnlineDeviceIds() {
  return Array.from(deviceWS.keys());
}
