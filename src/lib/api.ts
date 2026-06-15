const getToken = () => localStorage.getItem('devfleet_token');

export const getApiBaseUrl = () => (localStorage.getItem('devfleet_api_url') || import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export const apiUrl = (url: string) => `${getApiBaseUrl()}${url}`;

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: Record<string, unknown>;
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

  const res = await fetch(apiUrl(url), {
    ...options,
    headers,
    body: bodyContent as RequestInit['body'],
  });

  if (res.status === 401) {
    localStorage.removeItem('devfleet_token');
    if (!location.pathname.startsWith('/login')) {
      location.href = '/login';
    }
    throw new Error('未授权，请重新登录');
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
