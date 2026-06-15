import { api } from '@/lib/api';

export type BuiltinTunnelStatus = {
  active: boolean;
  url: string | null;
  provider: 'localtunnel' | 'cloudflared' | null;
  error: string | null;
};

export const tunnelApi = {
  status: () => api<BuiltinTunnelStatus>('/api/tunnel/status'),
  start: (provider: 'auto' | 'localtunnel' | 'cloudflared' = 'auto') =>
    api<BuiltinTunnelStatus>('/api/tunnel/start', {
      method: 'POST',
      body: { provider },
    }),
  stop: () => api<BuiltinTunnelStatus>('/api/tunnel/stop', { method: 'POST' }),
};
