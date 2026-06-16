const STORAGE_KEY = 'devfleet_api_url';
const DEFAULT_API_BASE = 'http://localhost:3001';
const LOCAL_API_CANDIDATES = ['http://localhost:3001', 'http://127.0.0.1:3001'] as const;

export function isLocalApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim().replace(/\/$/, ''));
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** 桌面端 / 生产包默认连本机 3001，与登录页一致 */
export function getApiBaseUrl(): string {
  const fromStorage = localStorage.getItem(STORAGE_KEY)?.trim();
  if (fromStorage) return fromStorage.replace(/\/$/, '');
  const fromEnv = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return DEFAULT_API_BASE;
}

/** MCP 始终连本机服务端，不受穿透/远程 API 地址影响 */
export function getMcpApiBaseUrl(): string {
  return DEFAULT_API_BASE;
}

/** 清除无效或不可达的 localStorage 地址，桌面端回退到 localhost:3001 */
export function sanitizeStoredApiUrl(options?: { forceLocal?: boolean }): string {
  const current = getApiBaseUrl();
  if (options?.forceLocal && !isLocalApiUrl(current)) {
    localStorage.setItem(STORAGE_KEY, DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
  try {
    const url = new URL(current);
    if (!url.protocol.startsWith('http')) {
      localStorage.setItem(STORAGE_KEY, DEFAULT_API_BASE);
      return DEFAULT_API_BASE;
    }
  } catch {
    localStorage.setItem(STORAGE_KEY, DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
  return current;
}

export function ensureApiBaseConfigured(): void {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, getApiBaseUrl());
  }
}

export function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

export {
  DEFAULT_API_BASE,
  LOCAL_API_CANDIDATES,
  STORAGE_KEY as API_BASE_STORAGE_KEY,
};
