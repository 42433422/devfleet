import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import localtunnel, { type Tunnel } from 'localtunnel';

export type TunnelProvider = 'localtunnel' | 'cloudflared';
export type TunnelStatus = {
  active: boolean;
  url: string | null;
  provider: TunnelProvider | null;
  error: string | null;
};

type ActiveTunnel = {
  url: string;
  provider: TunnelProvider;
  close: () => Promise<void>;
};

let activeTunnel: ActiveTunnel | null = null;
let starting: Promise<ActiveTunnel> | null = null;
let lastError: string | null = null;

export function getTunnelStatus(): TunnelStatus {
  return {
    active: Boolean(activeTunnel),
    url: activeTunnel?.url ?? null,
    provider: activeTunnel?.provider ?? null,
    error: lastError,
  };
}

export async function startBuiltinTunnel(
  port: number,
  preferred: TunnelProvider | 'auto' = 'auto',
): Promise<TunnelStatus> {
  if (activeTunnel) return getTunnelStatus();
  if (starting) {
    await starting;
    return getTunnelStatus();
  }

  starting = (async () => {
    lastError = null;
    const providers: TunnelProvider[] = preferred === 'auto'
      ? ['cloudflared', 'localtunnel']
      : [preferred];

    let lastFailure = '无法启动内置穿透';
    for (const provider of providers) {
      try {
        const tunnel = provider === 'cloudflared'
          ? await startCloudflared(port)
          : await startLocaltunnel(port);
        activeTunnel = tunnel;
        console.log(`[DevFleet] 内置穿透已开启 (${tunnel.provider}): ${tunnel.url}`);
        return tunnel;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        console.warn(`[DevFleet] ${provider} 穿透失败:`, lastFailure);
      }
    }
    lastError = lastFailure;
    throw new Error(lastFailure);
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
  return getTunnelStatus();
}

export async function stopBuiltinTunnel(): Promise<TunnelStatus> {
  if (starting) {
    try {
      await starting;
    } catch {
      // ignore start failure while stopping
    }
  }
  if (activeTunnel) {
    try {
      await activeTunnel.close();
    } catch (error) {
      console.warn('[DevFleet] 关闭内置穿透失败:', error);
    }
    activeTunnel = null;
    console.log('[DevFleet] 内置穿透已关闭');
  }
  return getTunnelStatus();
}

async function startLocaltunnel(port: number): Promise<ActiveTunnel> {
  const tunnel: Tunnel = await localtunnel({ port });

  if (!tunnel.url) throw new Error('localtunnel 未返回公网地址');

  return {
    url: tunnel.url,
    provider: 'localtunnel',
    close: async () => {
      tunnel.close();
    },
  };
}

async function startCloudflared(port: number): Promise<ActiveTunnel> {
  const binary = await resolveCloudflaredBinary();
  const proc = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await waitForCloudflaredUrl(proc);
  return {
    url,
    provider: 'cloudflared',
    close: async () => {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function resolveCloudflaredBinary(): Promise<string> {
  const candidates = ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const candidate of candidates) {
    const ok = await commandExists(candidate);
    if (ok) return candidate;
  }
  throw new Error('未找到 cloudflared，可安装：brew install cloudflared');
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(command, ['--version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function waitForCloudflaredUrl(proc: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url!);
    };

    const timer = setTimeout(() => finish(new Error('cloudflared 启动超时')), 45000);
    const handleChunk = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
      if (match?.[0]) finish(null, match[0]);
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);
    proc.on('error', (error) => finish(error));
    proc.on('exit', (code) => {
      if (!settled) finish(new Error(`cloudflared 退出 (${code ?? 'unknown'})`));
    });
  });
}

export async function shutdownBuiltinTunnel(): Promise<void> {
  await stopBuiltinTunnel();
}
