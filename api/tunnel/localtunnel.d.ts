declare module 'localtunnel' {
  import type { EventEmitter } from 'node:events';

  export interface TunnelOptions {
    port: number;
    subdomain?: string;
    host?: string;
    local_host?: string;
    local_https?: boolean;
    local_cert?: string;
    local_key?: string;
    local_ca?: string;
    allow_invalid_cert?: boolean;
  }

  export interface Tunnel extends EventEmitter {
    url?: string;
    close(): void;
  }

  export default function localtunnel(options: TunnelOptions): Promise<Tunnel>;
}
