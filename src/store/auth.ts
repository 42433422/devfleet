import { create } from 'zustand';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  register: (email: string, password: string) => Promise<void>;
}

const getStoredToken = () => localStorage.getItem('devfleet_token');

const getStoredUser = (): User | null => {
  try {
    const stored = localStorage.getItem('devfleet_user');
    if (stored) return JSON.parse(stored);
  } catch {
    return null;
  }
  return null;
};

const parseUserFromToken = (token: string): User | null => {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return { id: decoded.id || decoded.sub || '1', email: decoded.email || '' };
  } catch {
    return { id: '1', email: 'user@devfleet.local' };
  }
};

export const useAuthStore = create<AuthState>((set) => {
  const token = getStoredToken();
  const storedUser = getStoredUser();
  const user = storedUser || (token ? parseUserFromToken(token) : null);
  
  return {
    user,
    token,

    login: async (email: string, password: string) => {
      const data = await api<{ token?: string; access_token?: string; user?: User }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      const token = data.token || data.access_token;
      if (!token) throw new Error('登录响应缺少 token');
      const user = data.user || parseUserFromToken(token) || { id: '1', email };
      localStorage.setItem('devfleet_token', token);
      localStorage.setItem('devfleet_user', JSON.stringify(user));
      set({ token, user });
    },

    logout: () => {
      localStorage.removeItem('devfleet_token');
      localStorage.removeItem('devfleet_user');
      set({ user: null, token: null });
    },

    register: async (email: string, password: string) => {
      const data = await api<{ token?: string; access_token?: string; user?: User }>('/api/auth/register', {
        method: 'POST',
        body: { email, password },
      });
      const token = data.token || data.access_token;
      if (!token) throw new Error('注册响应缺少 token');
      const user = data.user || parseUserFromToken(token) || { id: '1', email };
      localStorage.setItem('devfleet_token', token);
      localStorage.setItem('devfleet_user', JSON.stringify(user));
      set({ token, user });
    },
  };
});
