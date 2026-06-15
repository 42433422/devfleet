import { create } from 'zustand';

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
  setDemoUser: () => void;
}

const getStoredToken = () => localStorage.getItem('devfleet_token');

const getStoredUser = (): User | null => {
  try {
    const stored = localStorage.getItem('devfleet_user');
    if (stored) return JSON.parse(stored);
  } catch {}
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
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '登录失败');
      const data = await res.json();
      const token = data.token || data.access_token;
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
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '注册失败');
      const data = await res.json();
      const token = data.token || data.access_token;
      const user = data.user || parseUserFromToken(token) || { id: '1', email };
      localStorage.setItem('devfleet_token', token);
      localStorage.setItem('devfleet_user', JSON.stringify(user));
      set({ token, user });
    },

    setDemoUser: () => {
      const user = { id: 'demo', email: 'demo@example.com' };
      const token = 'demo-token';
      localStorage.setItem('devfleet_token', token);
      localStorage.setItem('devfleet_user', JSON.stringify(user));
      set({ token, user });
    },
  };
});
