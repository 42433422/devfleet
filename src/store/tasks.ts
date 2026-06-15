import { create } from 'zustand';
import { api } from '@/lib/api';
import type { ToolName } from './devices';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'merged';
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: string;
  content: string;
  level: LogLevel;
  timestamp: string;
}

export interface SubTask {
  id: string;
  task_id: string;
  device_id: string;
  tool_name: ToolName;
  status: SubTaskStatus;
  branch_name: string;
  progress: number;
  logs: LogEntry[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  subTasks: SubTask[];
  created_at: string;
  completed_at?: string;
  repo_url: string;
  branch: string;
}

interface TaskCreateData {
  title: string;
  description: string;
  repo_url: string;
  branch: string;
}

interface TasksState {
  tasks: Task[];
  currentTask: Task | null;
  fetchTasks: () => Promise<void>;
  fetchTask: (id: string) => Promise<void>;
  createTask: (data: TaskCreateData) => Promise<Task>;
  mergeTask: (id: string) => Promise<void>;
  updateTaskProgress: (taskId: string, subTaskId: string, progress: number, status?: SubTaskStatus) => void;
  appendTaskLog: (taskId: string, subTaskId: string, log: LogEntry) => void;
  addTask: (task: Task) => void;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  currentTask: null,

  fetchTasks: async () => {
    try {
      const result = await api<{ tasks: Task[] }>('/api/tasks');
      const tasks = result?.tasks || [];
      set({ tasks });
    } catch {
      set({ tasks: [] });
    }
  },

  fetchTask: async (id: string) => {
    try {
      const result = await api<{ task: Task }>(`/api/tasks/${id}`);
      const task = result?.task;
      if (task && task.id) {
        set({
          currentTask: task,
          tasks: get().tasks.map((t) => (t.id === id ? task : t)),
        });
      }
    } catch {
      set({ currentTask: null });
    }
  },

  createTask: async (data: TaskCreateData) => {
    const result = await api<{ task: Task }>('/api/tasks', {
      method: 'POST',
      body: data as unknown as Record<string, unknown>,
    });
    const task = result?.task;
    if (task && task.id) {
      set({ tasks: [task, ...get().tasks] });
    }
    return task;
  },

  mergeTask: async (id: string) => {
    await api(`/api/tasks/${id}/merge`, { method: 'POST' });
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'merged' as TaskStatus } : t)),
      currentTask: s.currentTask?.id === id ? { ...s.currentTask, status: 'merged' as TaskStatus } : s.currentTask,
    }));
  },

  updateTaskProgress: (taskId: string, subTaskId: string, progress: number, status?: SubTaskStatus) => {
    set((s) => {
      const updater = (t: Task): Task => ({
        ...t,
        subTasks: t.subTasks.map((st) =>
          st.id === subTaskId ? { ...st, progress, status: status ?? st.status } : st
        ),
      });
      return {
        tasks: s.tasks.map((t) => (t.id === taskId ? updater(t) : t)),
        currentTask: s.currentTask?.id === taskId ? updater(s.currentTask) : s.currentTask,
      };
    });
  },

  appendTaskLog: (taskId: string, subTaskId: string, log: LogEntry) => {
    set((s) => {
      const updater = (t: Task): Task => ({
        ...t,
        subTasks: t.subTasks.map((st) =>
          st.id === subTaskId ? { ...st, logs: [...st.logs, log].slice(-200) } : st
        ),
      });
      return {
        tasks: s.tasks.map((t) => (t.id === taskId ? updater(t) : t)),
        currentTask: s.currentTask?.id === taskId ? updater(s.currentTask) : s.currentTask,
      };
    });
  },

  addTask: (task: Task) => {
    set((s) => ({ tasks: [task, ...s.tasks] }));
  },
}));
