import { create } from 'zustand';
import { api } from '@/lib/api';
import type { DeviceStatus } from './devices';
import type { TaskStatus } from './tasks';

export type CollabSessionStatus = 'open' | 'paused' | 'closed';
export type CollabMessageRole = 'user' | 'assistant' | 'system';
export type CollabMessageStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface CollabMessage {
  id: string;
  session_id: string;
  role: CollabMessageRole;
  content: string;
  task_id?: string;
  sub_task_id?: string;
  status: CollabMessageStatus;
  created_at: string;
  updated_at: string;
}

export interface CollabSession {
  id: string;
  title: string;
  status: CollabSessionStatus;
  device_id: string;
  device_name?: string;
  device_status: DeviceStatus;
  task_id: string;
  task_status?: TaskStatus;
  repo_url: string;
  branch: string;
  turn_count: number;
  queued_count: number;
  running_count: number;
  active_message_id?: string;
  context_summary?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  messages: CollabMessage[];
}

interface CreateCollabSessionData {
  device_id: string;
  title: string;
  repo_url?: string;
  branch: string;
}

interface CollabState {
  sessions: CollabSession[];
  currentSession: CollabSession | null;
  loading: boolean;
  currentLoading: boolean;
  sending: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  fetchSession: (id: string) => Promise<void>;
  createSession: (data: CreateCollabSessionData) => Promise<CollabSession>;
  sendMessage: (sessionId: string, content: string) => Promise<CollabSession>;
  closeSession: (sessionId: string) => Promise<CollabSession>;
  upsertSession: (session: CollabSession) => void;
  upsertMessage: (sessionId: string, message: CollabMessage) => void;
  clearError: () => void;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';

function sortSessions(sessions: CollabSession[]): CollabSession[] {
  return [...sessions].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

function mergeSessionList(sessions: CollabSession[], session: CollabSession): CollabSession[] {
  return sortSessions([session, ...sessions.filter((item) => item.id !== session.id)]);
}

export const useCollabStore = create<CollabState>((set) => ({
  sessions: [],
  currentSession: null,
  loading: false,
  currentLoading: false,
  sending: false,
  error: null,

  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api<{ sessions: CollabSession[] }>('/api/collab/sessions');
      set({ sessions: result.sessions || [], loading: false });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  fetchSession: async (id: string) => {
    set({ currentLoading: true, error: null });
    try {
      const result = await api<{ session: CollabSession }>(`/api/collab/sessions/${id}`);
      const session = result.session;
      set((state) => ({
        currentSession: session,
        currentLoading: false,
        sessions: mergeSessionList(state.sessions, session),
      }));
    } catch (error) {
      set({ currentLoading: false, error: errorMessage(error) });
    }
  },

  createSession: async (data) => {
    set({ currentLoading: true, error: null });
    try {
      const result = await api<{ session: CollabSession }>('/api/collab/sessions', {
        method: 'POST',
        body: data as unknown as Record<string, unknown>,
      });
      const session = result.session;
      set((state) => ({
        currentSession: session,
        currentLoading: false,
        sessions: mergeSessionList(state.sessions, session),
      }));
      return session;
    } catch (error) {
      set({ currentLoading: false, error: errorMessage(error) });
      throw error;
    }
  },

  sendMessage: async (sessionId, content) => {
    set({ sending: true, error: null });
    try {
      const result = await api<{ session: CollabSession }>(`/api/collab/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: { content },
      });
      const session = result.session;
      set((state) => ({
        currentSession: state.currentSession?.id === session.id ? session : state.currentSession,
        sessions: mergeSessionList(state.sessions, session),
        sending: false,
      }));
      return session;
    } catch (error) {
      set({ sending: false, error: errorMessage(error) });
      throw error;
    }
  },

  closeSession: async (sessionId) => {
    const result = await api<{ session: CollabSession }>(`/api/collab/sessions/${sessionId}/close`, {
      method: 'POST',
    });
    const session = result.session;
    set((state) => ({
      currentSession: state.currentSession?.id === session.id ? session : state.currentSession,
      sessions: mergeSessionList(state.sessions, session),
      error: null,
    }));
    return session;
  },

  upsertSession: (session) => {
    set((state) => ({
      currentSession: state.currentSession?.id === session.id ? session : state.currentSession,
      sessions: mergeSessionList(state.sessions, session),
    }));
  },

  upsertMessage: (sessionId, message) => {
    set((state) => {
      const update = (session: CollabSession): CollabSession => {
        if (session.id !== sessionId) return session;
        const messages = [
          ...session.messages.filter((item) => item.id !== message.id),
          message,
        ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        return { ...session, messages, updated_at: message.updated_at };
      };
      return {
        currentSession: state.currentSession ? update(state.currentSession) : state.currentSession,
        sessions: sortSessions(state.sessions.map(update)),
      };
    });
  },

  clearError: () => set({ error: null }),
}));
