import { api } from '@/lib/api';

export type BuiltinTunnelStatus = {
  active: boolean;
  url: string | null;
  provider: 'localtunnel' | 'cloudflared' | null;
  error: string | null;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export const tunnelApi = {
  status: () => api<BuiltinTunnelStatus>('/api/tunnel/status'),
  start: (provider: 'auto' | 'localtunnel' | 'cloudflared' = 'auto') =>
    withTimeout(
      api<BuiltinTunnelStatus>('/api/tunnel/start', {
        method: 'POST',
        body: { provider },
      }),
      120_000,
      '开启穿透超时（约需 10–60 秒），请检查网络后重试',
    ),
  stop: () => api<BuiltinTunnelStatus>('/api/tunnel/stop', { method: 'POST' }),
};
