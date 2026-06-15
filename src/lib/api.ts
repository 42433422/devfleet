import { getApiBaseUrl, ensureApiBaseConfigured, apiUrl } from './apiBase';

ensureApiBaseConfigured();

export { getApiBaseUrl, ensureApiBaseConfigured, apiUrl, DEFAULT_API_BASE } from './apiBase';

const getToken = () => localStorage.getItem('devfleet_token');

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: Record<string, unknown>;
}

async function guestLogin(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl('/api/auth/guest'), {
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

  let res = await fetch(apiUrl(url), {
    ...options,
    headers,
    body: bodyContent as RequestInit['body'],
  });

  if (res.status === 401) {
    const newToken = await guestLogin();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(apiUrl(url), {
        ...options,
        headers,
        body: bodyContent as RequestInit['body'],
      });
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
