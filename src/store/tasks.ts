import { create } from 'zustand';
import { api } from '@/lib/api';
import type { ToolName } from './devices';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'merge_conflict' | 'merged';
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: string;
  content: string;
  level: LogLevel;
  timestamp: string;
  device_id?: string;
  device_name?: string;
  subtask_id?: string;
  subtask_title?: string;
}

export interface SubTask {
  id: string;
  task_id: string;
  device_id: string;
  device_name?: string;
  tool_name: ToolName;
  status: SubTaskStatus;
  branch_name: string;
  progress: number;
  title?: string;
  description?: string;
  depends_on?: string[];
  sort_order?: number;
  attempt_count?: number;
  max_attempts?: number;
  last_error?: string;
  blocked?: boolean;
  logs: LogEntry[];
  created_at?: string;
  completed_at?: string;
}

export interface MergeConflictRecord {
  status: 'open';
  detected_at: string;
  subtask_id?: string;
  branch_name?: string;
  conflict_files: string[];
  detail: string;
  source?: string;
  workspace_path?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  subTasks: SubTask[];
  created_at: string;
  completed_at?: string;
  merge_commit_sha?: string;
  merge_conflict?: MergeConflictRecord | null;
  repo_url: string;
  branch: string;
}

interface TaskCreateData {
  title: string;
  description: string;
  repo_url: string;
  branch: string;
  sequential?: boolean;
  assignments?: Array<{ device_id: string; sub_index?: number }>;
}

interface TasksState {
  tasks: Task[];
  currentTask: Task | null;
  loading: boolean;
  currentTaskLoading: boolean;
  error: string | null;
  fetchTasks: () => Promise<void>;
  fetchTask: (id: string) => Promise<void>;
  createTask: (data: TaskCreateData) => Promise<Task>;
  mergeTask: (id: string, mergeCommitSha: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  updateTaskProgress: (taskId: string, subTaskId: string, progress: number, status?: SubTaskStatus) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  appendTaskLog: (
    taskId: string,
    subTaskId: string,
    log: LogEntry,
    meta?: { device_id?: string; device_name?: string },
  ) => void;
  addTask: (task: Task) => void;
  clearError: () => void;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  currentTask: null,
  loading: false,
  currentTaskLoading: false,
  error: null,

  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api<{ tasks: Task[] }>('/api/tasks');
      const tasks = result?.tasks || [];
      set({ tasks, loading: false });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  fetchTask: async (id: string) => {
    set({ currentTaskLoading: true, error: null });
    try {
      const result = await api<{ task: Task }>(`/api/tasks/${id}`);
      const task = result?.task;
      if (task && task.id) {
        set({
          currentTask: task,
          currentTaskLoading: false,
          tasks: get().tasks.map((t) => (t.id === id ? task : t)),
        });
      }
    } catch (error) {
      set({ currentTask: null, currentTaskLoading: false, error: errorMessage(error) });
    }
  },

  createTask: async (data: TaskCreateData) => {
    try {
      const result = await api<{ task: Task }>('/api/tasks', {
        method: 'POST',
        body: data as unknown as Record<string, unknown>,
      });
      const task = result?.task;
      if (task && task.id) {
        set((state) => ({
          tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)],
          error: null,
        }));
      }
      return task;
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  mergeTask: async (id: string, mergeCommitSha: string) => {
    await api(`/api/tasks/${id}/merge`, {
      method: 'POST',
      body: { merge_commit_sha: mergeCommitSha },
    });
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'merged' as TaskStatus } : t)),
      currentTask: s.currentTask?.id === id ? { ...s.currentTask, status: 'merged' as TaskStatus } : s.currentTask,
      error: null,
    }));
  },

  deleteTask: async (id: string) => {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== id),
      currentTask: state.currentTask?.id === id ? null : state.currentTask,
      error: null,
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

  updateTaskStatus: (taskId: string, status: TaskStatus) => {
    set((state) => ({
      tasks: state.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
      currentTask: state.currentTask?.id === taskId ? { ...state.currentTask, status } : state.currentTask,
    }));
  },

  appendTaskLog: (taskId: string, subTaskId: string, log: LogEntry, meta?: { device_id?: string; device_name?: string }) => {
    const enriched: LogEntry = {
      ...log,
      device_id: meta?.device_id || log.device_id,
      device_name: meta?.device_name || log.device_name,
      subtask_id: subTaskId,
    };
    set((s) => {
      const updater = (t: Task): Task => ({
        ...t,
        subTasks: t.subTasks.map((st) =>
          st.id === subTaskId ? { ...st, logs: [...st.logs, enriched].slice(-200) } : st
        ),
      });
      return {
        tasks: s.tasks.map((t) => (t.id === taskId ? updater(t) : t)),
        currentTask: s.currentTask?.id === taskId ? updater(s.currentTask) : s.currentTask,
      };
    });
  },

  addTask: (task: Task) => {
    set((s) => ({ tasks: s.tasks.some((item) => item.id === task.id) ? s.tasks : [task, ...s.tasks] }));
  },

  clearError: () => set({ error: null }),
}));
