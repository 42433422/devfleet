import {
  getApiBaseUrl,
  ensureApiBaseConfigured,
  DEFAULT_API_BASE,
  API_BASE_STORAGE_KEY,
} from './apiBase';
import { isDesktopApp } from './agent';

ensureApiBaseConfigured();

export { getApiBaseUrl, ensureApiBaseConfigured, apiUrl, DEFAULT_API_BASE } from './apiBase';

const getToken = () => localStorage.getItem('devfleet_token');

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: Record<string, unknown>;
}

function formatNetworkError(error: unknown, baseUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) {
    return new Error(
      `无法连接 DevFleet 服务端（${baseUrl}）。请确认本机服务已启动，或在登录页将地址改回 ${DEFAULT_API_BASE}`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function fetchWithBase(base: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${base.replace(/\/$/, '')}${path}`, init);
  } catch (error) {
    throw formatNetworkError(error, base);
  }
}

async function resolveFetch(path: string, init: RequestInit): Promise<Response> {
  const primary = getApiBaseUrl();
  try {
    return await fetchWithBase(primary, path, init);
  } catch (primaryError) {
    if (isDesktopApp() && primary !== DEFAULT_API_BASE) {
      try {
        const res = await fetchWithBase(DEFAULT_API_BASE, path, init);
        localStorage.setItem(API_BASE_STORAGE_KEY, DEFAULT_API_BASE);
        return res;
      } catch {
        throw primaryError;
      }
    }
    throw primaryError;
  }
}

async function guestLogin(): Promise<string | null> {
  try {
    const res = await resolveFetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = data.token || data.access_token;
    if (!token) return null;
    localStorage.setItem('devfleet_token', token);
    const user = data.user || { id: '1', email: 'guest@devfleet.local' };
    localStorage.setItem('devfleet_user', JSON.stringify(user));
    return token;
  } catch {
    return null;
  }
}

export const api = async <T = Record<string, unknown>>(
  url: string,
  options: RequestOptions = {}
): Promise<T> => {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const bodyContent = options.body !== undefined && typeof options.body !== 'string'
    ? JSON.stringify(options.body)
    : options.body;

  const fetchInit: RequestInit = {
    ...options,
    headers,
    body: bodyContent as RequestInit['body'],
  };

  let res = await resolveFetch(url, fetchInit);

  if (res.status === 401) {
    const newToken = await guestLogin();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await resolveFetch(url, { ...fetchInit, headers });
    } else {
      localStorage.removeItem('devfleet_token');
      const onLogin = location.hash.includes('/login') || location.pathname.endsWith('/login');
      if (!onLogin) {
        location.hash = '#/login';
      }
      throw new Error('未授权，请重新登录');
    }
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new Error((data as { error?: string; message?: string })?.error || (data as { error?: string; message?: string })?.message || `请求失败 (${res.status})`);
  }

  return data as T ?? ({} as T);
};
