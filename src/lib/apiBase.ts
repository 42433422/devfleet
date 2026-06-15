const STORAGE_KEY = 'devfleet_api_url';
const DEFAULT_API_BASE = 'http://localhost:3001';

/** 桌面端 / 生产包默认连本机 3001，与登录页一致 */
export function getApiBaseUrl(): string {
  const fromStorage = localStorage.getItem(STORAGE_KEY)?.trim();
  if (fromStorage) return fromStorage.replace(/\/$/, '');
  const fromEnv = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return DEFAULT_API_BASE;
}

export function ensureApiBaseConfigured(): void {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, getApiBaseUrl());
  }
}

export function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

export { DEFAULT_API_BASE, STORAGE_KEY as API_BASE_STORAGE_KEY };
