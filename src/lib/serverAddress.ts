import { DEFAULT_API_BASE, getApiBaseUrl } from './apiBase';

export const PUBLIC_API_STORAGE_KEY = 'devfleet_public_api_url';

export function normalizeApiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/$/, '');
}

/** HTTP(S) API 根地址 → WS(S) 根地址，供穿透域名使用 */
export function apiBaseToWsBase(apiBase: string): string {
  const normalized = normalizeApiBaseUrl(apiBase);
  if (normalized.startsWith('https://')) return normalized.replace(/^https:\/\//, 'wss://');
  if (normalized.startsWith('http://')) return normalized.replace(/^http:\/\//, 'ws://');
  return normalized;
}

export function isValidApiBaseUrl(raw: string): boolean {
  const value = normalizeApiBaseUrl(raw);
  if (!/^https?:\/\/.+/i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function getLocalApiUrl(): string {
  const current = getApiBaseUrl();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(current)) {
    return normalizeApiBaseUrl(current);
  }
  return DEFAULT_API_BASE;
}

export function getApiPort(apiBase = getApiBaseUrl()): number {
  try {
    const url = new URL(apiBase);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3001;
  }
}

export function buildLanApiUrl(ip: string, apiBase = getApiBaseUrl()): string {
  const port = getApiPort(apiBase);
  const showPort = port !== 80 && port !== 443;
  return `http://${ip}${showPort ? `:${port}` : ''}`;
}

export function getPublicApiUrl(): string {
  const stored = localStorage.getItem(PUBLIC_API_STORAGE_KEY);
  return stored ? normalizeApiBaseUrl(stored) : '';
}

export function setPublicApiUrl(raw: string): void {
  const normalized = normalizeApiBaseUrl(raw);
  if (!normalized) {
    localStorage.removeItem(PUBLIC_API_STORAGE_KEY);
    return;
  }
  localStorage.setItem(PUBLIC_API_STORAGE_KEY, normalized);
}

export type ShareableAddressKind = 'tunnel' | 'lan' | 'localhost' | 'none';

export function resolveShareableApiUrl(lanIp?: string | null): {
  url: string;
  kind: ShareableAddressKind;
} {
  const publicUrl = getPublicApiUrl();
  if (publicUrl && isValidApiBaseUrl(publicUrl)) {
    return { url: publicUrl, kind: 'tunnel' };
  }
  if (lanIp) {
    return { url: buildLanApiUrl(lanIp), kind: 'lan' };
  }
  const local = getLocalApiUrl();
  if (isValidApiBaseUrl(local)) {
    return { url: local, kind: 'localhost' };
  }
  return { url: '', kind: 'none' };
}

export function buildDeviceBindInstructions(options: {
  serverUrl: string;
  bindCode: string;
  expiresAt?: string;
}): string {
  const lines = [
    'DevFleet 工作设备接入说明',
    '',
    `服务器地址：${options.serverUrl}`,
    `绑定码：${options.bindCode}`,
  ];
  if (options.expiresAt) {
    lines.push(`有效期至：${options.expiresAt}`);
  }
  lines.push(
    '',
    '步骤：',
    '1. 在目标设备安装 DevFleet 桌面客户端',
    '2. 打开「本机设备代理」',
    '3. 填入上面的服务器地址与绑定码',
  );
  return lines.join('\n');
}

export type ServerProbeResult = {
  ok: boolean;
  api: { ok: boolean; message: string };
  websocket: { ok: boolean; message: string };
};

/** 探测 API 与 WebSocket 是否可达（用于验证局域网 / 内网穿透） */
export async function probeServerReachability(apiBase: string, timeoutMs = 8000): Promise<ServerProbeResult> {
  const base = normalizeApiBaseUrl(apiBase);
  if (!isValidApiBaseUrl(base)) {
    return {
      ok: false,
      api: { ok: false, message: '地址格式无效' },
      websocket: { ok: false, message: '跳过' },
    };
  }

  let apiResult = { ok: false, message: '连接失败' };
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    window.clearTimeout(timer);
    if (res.ok) {
      apiResult = { ok: true, message: 'HTTP API 正常' };
    } else {
      apiResult = { ok: false, message: `HTTP ${res.status}` };
    }
  } catch (error) {
    apiResult = {
      ok: false,
      message: error instanceof Error ? error.message : 'API 不可达',
    };
  }

  let wsResult = { ok: false, message: '连接失败' };
  if (apiResult.ok) {
    wsResult = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const wsBase = apiBaseToWsBase(base);
      let settled = false;
      const finish = (result: { ok: boolean; message: string }) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      };
      const timer = window.setTimeout(() => finish({ ok: false, message: 'WebSocket 超时' }), timeoutMs);
      try {
        const ws = new WebSocket(`${wsBase}/ws/client?token=probe`);
        ws.onopen = () => {
          ws.close();
          finish({ ok: true, message: 'WebSocket 通道正常' });
        };
        ws.onclose = (event) => {
          // 无 token 时服务端会 4001 关闭，说明 WS 路由已通
          if (event.code === 4001) {
            finish({ ok: true, message: 'WebSocket 通道正常' });
            return;
          }
          if (!settled) {
            finish({ ok: false, message: `WebSocket 关闭 (${event.code})` });
          }
        };
        ws.onerror = () => finish({ ok: false, message: 'WebSocket 连接失败' });
      } catch (error) {
        finish({ ok: false, message: error instanceof Error ? error.message : 'WebSocket 不可用' });
      }
    });
  } else {
    wsResult = { ok: false, message: 'API 未通，跳过 WS' };
  }

  return {
    ok: apiResult.ok && wsResult.ok,
    api: apiResult,
    websocket: wsResult,
  };
}
