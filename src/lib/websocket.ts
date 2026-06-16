import { useDevicesStore, type DeviceCapabilities, type DeviceStatus, type ToolStatus } from '@/store/devices';
import { useTasksStore, type LogEntry, type SubTaskStatus, type Task } from '@/store/tasks';
import { getApiBaseUrl } from '@/lib/api';
import { apiBaseToWsBase } from '@/lib/serverAddress';

type WSMessage =
  | { type: 'device_status'; device_id: string; status: DeviceStatus; tools?: ToolStatus[]; capabilities?: DeviceCapabilities }
  | { type: 'task_progress'; task_id: string; subtask_id: string; progress: number; status?: SubTaskStatus }
  | { type: 'task_log'; task_id: string; subtask_id: string; device_id?: string; device_name?: string; log: LogEntry }
  | { type: 'task_status'; task_id: string; status: Task['status'] }
  | { type: 'task_merged'; task_id: string; commit_sha: string }
  | { type: 'device_dev_tool'; device_id: string; devTool: ToolStatus['toolName'] }
  | { type: 'task_created'; task_id: string } & Partial<Pick<Task, 'title' | 'description' | 'status' | 'subTasks' | 'created_at' | 'repo_url' | 'branch'>>
  | { type: 'pong' };

interface WSCallbacks {
  onDeviceStatus?: (msg: Extract<WSMessage, { type: 'device_status' }>) => void;
  onTaskProgress?: (msg: Extract<WSMessage, { type: 'task_progress' }>) => void;
  onTaskLog?: (msg: Extract<WSMessage, { type: 'task_log' }>) => void;
  onTaskCreated?: (msg: Extract<WSMessage, { type: 'task_created' }>) => void;
}

const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_MS = 25_000;
const PONG_TIMEOUT_MS = 12_000;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pongTimer: number | null = null;
  private reconnectDelay = MIN_RECONNECT_MS;
  private isConnecting = false;
  private shouldReconnect = true;
  private lastToken = '';
  private lastHost: string | undefined;
  private lastCallbacks: WSCallbacks | undefined;

  connect(token: string, host?: string, callbacks?: WSCallbacks) {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.shouldReconnect = true;
    this.lastToken = token;
    this.lastHost = host;
    this.lastCallbacks = callbacks;
    this.isConnecting = true;

    const wsHost = host || getApiBaseUrl().replace(/^https?:\/\//, '') || 'localhost:3001';
    const configuredBase = (import.meta.env.VITE_WS_BASE_URL || apiBaseToWsBase(getApiBaseUrl()) || '').replace(/\/$/, '');
    const wsBase = configuredBase || `ws://${wsHost}`;
    const url = `${wsBase}/ws/client?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket connection error:', err);
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnecting = false;
      this.reconnectDelay = MIN_RECONNECT_MS;
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as WSMessage;
        if (!data || !data.type) return;

        if (data.type === 'pong') {
          this.resetPongTimeout();
          return;
        }

        const { updateDeviceStatus, updateToolStatus, updateDeviceDevTool } = useDevicesStore.getState();
        const { updateTaskProgress, updateTaskStatus, appendTaskLog, addTask, tasks } = useTasksStore.getState();

        switch (data.type) {
          case 'device_status':
            updateDeviceStatus(data.device_id, data.status, data.capabilities);
            if (data.tools) updateToolStatus(data.device_id, data.tools);
            callbacks?.onDeviceStatus?.(data);
            break;
          case 'device_dev_tool':
            updateDeviceDevTool(data.device_id, data.devTool);
            break;
          case 'task_progress':
            updateTaskProgress(data.task_id, data.subtask_id, data.progress, data.status);
            callbacks?.onTaskProgress?.(data);
            break;
          case 'task_log':
            appendTaskLog(data.task_id, data.subtask_id, data.log, {
              device_id: data.device_id,
              device_name: data.device_name,
            });
            callbacks?.onTaskLog?.(data);
            break;
          case 'task_status':
            updateTaskStatus(data.task_id, data.status);
            break;
          case 'task_merged':
            updateTaskStatus(data.task_id, 'merged');
            break;
          case 'task_created':
            if (data.task_id && !tasks.some((t) => t.id === data.task_id)) {
              addTask({
                id: data.task_id,
                title: data.title || '新任务',
                description: data.description || '',
                status: data.status || 'pending',
                subTasks: data.subTasks || [],
                created_at: data.created_at || new Date().toISOString(),
                repo_url: data.repo_url || '',
                branch: data.branch || 'main',
              });
            }
            callbacks?.onTaskCreated?.(data);
            break;
        }
      } catch (err) {
        console.error('WebSocket message parse error:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      this.isConnecting = false;
    };

    this.ws.onclose = () => {
      this.isConnecting = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.resetPongTimeout();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ type: 'ping' });
      this.resetPongTimeout();
    }, HEARTBEAT_MS);
  }

  private resetPongTimeout() {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
    }
    this.pongTimer = window.setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    }, PONG_TIMEOUT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer !== null) return;
    const jitter = Math.floor(Math.random() * 400);
    const delay = this.reconnectDelay + jitter;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
      this.connect(this.lastToken, this.lastHost, this.lastCallbacks);
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  send(data: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
}

export const wsClient = new WebSocketClient();
