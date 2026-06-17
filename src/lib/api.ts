import { PRODUCT_NAME } from './brand';
import {
  getApiBaseUrl,
  ensureApiBaseConfigured,
  sanitizeStoredApiUrl,
  DEFAULT_API_BASE,
  LOCAL_API_CANDIDATES,
  API_BASE_STORAGE_KEY,
  shouldUseViteDevProxy,
} from './apiBase';
import { probeApiHealth } from './serverAddress';
import { isDesktopApp } from './agent';
import {
  applyAuthSession,
  clearAuthSession,
  getStoredToken,
  getGuestLoginInFlight,
  setGuestLoginInFlight,
  parseUserFromToken,
  type AuthUser,
} from './authSession';

ensureApiBaseConfigured();
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  sanitizeStoredApiUrl({ forceLocal: true });
} else {
  sanitizeStoredApiUrl();
}

const FETCH_TIMEOUT_MS = 15_000;

export { getApiBaseUrl, ensureApiBaseConfigured, apiUrl, DEFAULT_API_BASE } from './apiBase';

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: Record<string, unknown>;
}

function formatNetworkError(error: unknown, baseUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) {
    return new Error(
      `无法连接 ${PRODUCT_NAME} 服务端（${baseUrl}）。请确认本机服务已启动（默认 ${DEFAULT_API_BASE}）`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function fetchWithBase(
  base: string,
  path: string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const url = base ? `${base.replace(/\/$/, '')}${path}` : path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const label = base || (typeof window !== 'undefined' ? window.location.origin : '开发代理');
      return Promise.reject(new Error(`请求超时（${timeoutMs / 1000}s）：${label}`));
    }
    throw formatNetworkError(error, base || DEFAULT_API_BASE);
  } finally {
    clearTimeout(timeout);
  }
}

let devApiBasePicked: string | null | undefined;

/** 开发态探测最快可达的本机 API（Vite 代理 or 直连 3001） */
async function pickDevApiBase(): Promise<string> {
  if (devApiBasePicked !== undefined) return devApiBasePicked;
  if (await probeApiHealth('', 3000)) {
    devApiBasePicked = '';
    return '';
  }
  for (const fallback of LOCAL_API_CANDIDATES) {
    if (await probeApiHealth(fallback, 2000)) {
      devApiBasePicked = fallback;
      return fallback;
    }
  }
  devApiBasePicked = '';
  return '';
}

export function resetDevApiBasePick(): void {
  devApiBasePicked = undefined;
}

async function pickDesktopApiBase(): Promise<string | null> {
  if (!isDesktopApp()) return null;
  const primary = getApiBaseUrl();
  if (await probeApiHealth(primary, 2000)) return primary;
  for (const fallback of LOCAL_API_CANDIDATES) {
    if (fallback === primary) continue;
    if (await probeApiHealth(fallback, 2000)) {
      localStorage.setItem(API_BASE_STORAGE_KEY, fallback);
      return fallback;
    }
  }
  return null;
}

export async function resolveFetch(path: string, init: RequestInit): Promise<Response> {
  const primary = getApiBaseUrl();

  // 开发态：先探测 Vite 代理 / 直连 3001，Trae 预览等环境代理不可达时自动回退
  if (shouldUseViteDevProxy() && !primary) {
    const base = await pickDevApiBase();
    if (base) {
      return fetchWithBase(base, path, init);
    }
    try {
      return await fetchWithBase('', path, init, 4000);
    } catch (proxyError) {
      for (const fallback of LOCAL_API_CANDIDATES) {
        try {
          return await fetchWithBase(fallback, path, init);
        } catch {
          // try next
        }
      }
      throw proxyError;
    }
  }

  if (isDesktopApp() && !import.meta.env.DEV) {
    const localBase = await pickDesktopApiBase();
    if (localBase) {
      try {
        return await fetchWithBase(localBase, path, init);
      } catch (localError) {
        if (localBase !== primary) {
          throw localError;
        }
      }
    }
  }

  try {
    return await fetchWithBase(primary, path, init);
  } catch (primaryError) {
    if (isDesktopApp()) {
      for (const fallback of LOCAL_API_CANDIDATES) {
        if (fallback === primary) continue;
        try {
          if (!(await probeApiHealth(fallback, 2000))) continue;
          const res = await fetchWithBase(fallback, path, init);
          localStorage.setItem(API_BASE_STORAGE_KEY, fallback);
          return res;
        } catch {
          // try next candidate
        }
      }
    }
    throw primaryError;
  }
}

async function guestLoginRequest(): Promise<string | null> {
  const inFlight = getGuestLoginInFlight();
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const res = await Promise.race([
        resolveFetch('/api/auth/guest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error('访客登录超时，请确认本机服务已启动')), FETCH_TIMEOUT_MS);
        }),
      ]);
      if (!res.ok) return null;
      const data = await res.json() as { token?: string; access_token?: string; user?: AuthUser };
      const token = data.token || data.access_token;
      if (!token) return null;
      const user = data.user || parseUserFromToken(token) || { id: '1', email: 'guest@devfleet.local' };
      applyAuthSession(token, user);
      return token;
    } catch {
      return null;
    } finally {
      setGuestLoginInFlight(null);
    }
  })();

  setGuestLoginInFlight(promise);
  return promise;
}

export const api = async <T = Record<string, unknown>>(
  url: string,
  options: RequestOptions = {}
): Promise<T> => {
  const token = getStoredToken();
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
    const newToken = await guestLoginRequest();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await resolveFetch(url, { ...fetchInit, headers });
    } else {
      clearAuthSession();
      throw new Error('未授权，请刷新页面重试');
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
