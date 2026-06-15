import { useDevicesStore, type DeviceStatus, type ToolStatus } from '@/store/devices';
import { useTasksStore, type LogEntry, type SubTaskStatus, type Task } from '@/store/tasks';

type WSMessage =
  | { type: 'device_status'; device_id: string; status: DeviceStatus; tools?: ToolStatus[] }
  | { type: 'task_progress'; task_id: string; subtask_id: string; progress: number; status?: SubTaskStatus }
  | { type: 'task_log'; task_id: string; subtask_id: string; log: LogEntry }
  | { type: 'task_created'; task_id: string } & Partial<Pick<Task, 'title' | 'description' | 'subTasks' | 'created_at' | 'repo_url' | 'branch'>>;

interface WSCallbacks {
  onDeviceStatus?: (msg: Extract<WSMessage, { type: 'device_status' }>) => void;
  onTaskProgress?: (msg: Extract<WSMessage, { type: 'task_progress' }>) => void;
  onTaskLog?: (msg: Extract<WSMessage, { type: 'task_log' }>) => void;
  onTaskCreated?: (msg: Extract<WSMessage, { type: 'task_created' }>) => void;
}

class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 2000;
  private isConnecting = false;

  connect(token: string, host?: string, callbacks?: WSCallbacks) {
    // Prevent multiple simultaneous connections
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // Skip WebSocket connection for demo token (no backend)
    if (token === 'demo-token') {
      return;
    }

    this.isConnecting = true;

    const wsHost = host || (typeof window !== 'undefined' ? window.location.host : 'localhost:3000');
    const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${wsHost}/ws/client?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket connection error:', err);
      this.isConnecting = false;
      this.scheduleReconnect(token, host, callbacks);
      return;
    }

    this.ws.onopen = () => {
      this.isConnecting = false;
      console.log('WebSocket connected');
    };

    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as WSMessage;
        if (!data || !data.type) return;

        const { updateDeviceStatus, updateToolStatus } = useDevicesStore.getState();
        const { updateTaskProgress, appendTaskLog, addTask, tasks } = useTasksStore.getState();

        switch (data.type) {
          case 'device_status':
            updateDeviceStatus(data.device_id, data.status);
            if (data.tools) updateToolStatus(data.device_id, data.tools);
            callbacks?.onDeviceStatus?.(data);
            break;
          case 'task_progress':
            updateTaskProgress(data.task_id, data.subtask_id, data.progress, data.status);
            callbacks?.onTaskProgress?.(data);
            break;
          case 'task_log':
            appendTaskLog(data.task_id, data.subtask_id, data.log);
            callbacks?.onTaskLog?.(data);
            break;
          case 'task_created':
            if (data.task_id && !tasks.some((t) => t.id === data.task_id)) {
              addTask({
                id: data.task_id,
                title: data.title || '新任务',
                description: data.description || '',
                status: 'pending',
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
      this.scheduleReconnect(token, host, callbacks);
    };
  }

  private scheduleReconnect(token: string, host: string | undefined, callbacks?: WSCallbacks) {
    if (this.reconnectTimer !== null) return;
    if (token === 'demo-token') return; // Don't reconnect for demo
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(token, host, callbacks);
    }, this.reconnectDelay);
  }

  disconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
