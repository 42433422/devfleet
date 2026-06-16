import { create } from 'zustand';
import { api } from '@/lib/api';
import {
  applyAuthSession,
  clearAuthSession,
  getStoredToken,
  getStoredUser,
  parseUserFromToken,
  type AuthUser,
} from '@/lib/authSession';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  register: (email: string, password: string) => Promise<void>;
  guestLogin: () => Promise<void>;
  syncSession: (token: string | null, user: AuthUser | null) => void;
}

const initialToken = getStoredToken();
const storedUser = getStoredUser();
const initialUser = storedUser || (initialToken ? parseUserFromToken(initialToken) : null);

export const useAuthStore = create<AuthState>((set) => ({
  user: initialUser,
  token: initialToken,

  syncSession: (token, user) => set({ token, user }),

  login: async (email: string, password: string) => {
    const data = await api<{ token?: string; access_token?: string; user?: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    const token = data.token || data.access_token;
    if (!token) throw new Error('登录响应缺少 token');
    const user = data.user || parseUserFromToken(token) || { id: '1', email };
    applyAuthSession(token, user);
    set({ token, user });
  },

  logout: () => {
    clearAuthSession();
    set({ user: null, token: null });
  },

  register: async (email: string, password: string) => {
    const data = await api<{ token?: string; access_token?: string; user?: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    const token = data.token || data.access_token;
    if (!token) throw new Error('注册响应缺少 token');
    const user = data.user || parseUserFromToken(token) || { id: '1', email };
    applyAuthSession(token, user);
    set({ token, user });
  },

  guestLogin: async () => {
    const data = await api<{ token?: string; access_token?: string; user?: AuthUser }>('/api/auth/guest', {
      method: 'POST',
    });
    const token = data.token || data.access_token;
    if (!token) throw new Error('访客登录响应缺少 token');
    const user = data.user || parseUserFromToken(token) || { id: '1', email: 'guest@devfleet.local' };
    applyAuthSession(token, user);
    set({ token, user });
  },
}));

import { registerAuthStoreSync } from '@/lib/authSession';
registerAuthStoreSync((token, user) => {
  useAuthStore.setState({ token, user });
});
