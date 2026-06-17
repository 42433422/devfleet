import { create } from 'zustand';
import { resolveFetch } from '@/lib/api';
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

  login: async (email, password) => {
    clearAuthSession();
    const res = await resolveFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const data = await res.json() as { token?: string; access_token?: string; user?: AuthUser; error?: string };
    if (!res.ok) {
      throw new Error(data.error || '登录失败，请检查邮箱和密码');
    }
    const token = data.token || data.access_token;
    if (!token) {
      throw new Error('服务响应异常');
    }
    const user = data.user || parseUserFromToken(token) || { id: '1', email: email.trim() };
    applyAuthSession(token, user);
    set({ token, user });
  },

  register: async (email, password) => {
    clearAuthSession();
    const res = await resolveFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const data = await res.json() as { token?: string; access_token?: string; user?: AuthUser; error?: string };
    if (!res.ok) {
      throw new Error(data.error || '注册失败');
    }
    const token = data.token || data.access_token;
    if (!token) {
      throw new Error('服务响应异常');
    }
    const user = data.user || parseUserFromToken(token) || { id: '1', email: email.trim() };
    applyAuthSession(token, user);
    set({ token, user });
  },

  syncSession: (token, user) => set({ token, user }),

  guestLogin: async () => {
    clearAuthSession();
    const res = await resolveFetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json() as { token?: string; access_token?: string; user?: AuthUser; error?: string };
    if (!res.ok) {
      throw new Error(data.error || '无法连接服务');
    }
    const token = data.token || data.access_token;
    if (!token) throw new Error('服务响应异常');
    const user = data.user || parseUserFromToken(token) || { id: '1', email: 'guest@devfleet.local' };
    applyAuthSession(token, user);
    set({ token, user });
  },
}));

import { registerAuthStoreSync } from '@/lib/authSession';
registerAuthStoreSync((token, user) => {
  useAuthStore.setState({ token, user });
});
