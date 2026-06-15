import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { access, chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
let cloudflaredDownloadPromise: Promise<string> | null = null;

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

function getDataDir(): string {
  const dbFile = process.env.DEVFLEET_DB_FILE
    ? path.resolve(process.env.DEVFLEET_DB_FILE)
    : path.resolve(process.cwd(), 'api', 'data', 'db.json');
  return path.dirname(dbFile);
}

async function resolveCloudflaredBinary(): Promise<string> {
  const candidates = ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const candidate of candidates) {
    const ok = await commandExists(candidate);
    if (ok) return candidate;
  }
  return downloadCloudflaredBinary();
}

async function downloadCloudflaredBinary(): Promise<string> {
  if (cloudflaredDownloadPromise) return cloudflaredDownloadPromise;

  cloudflaredDownloadPromise = (async () => {
    const dataDir = getDataDir();
    const binDir = path.join(dataDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binPath = path.join(binDir, binName);

    if (await fileExists(binPath)) return binPath;

    const asset = getCloudflaredAsset();
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.fileName}`;
    console.log(`[DevFleet] 正在下载 cloudflared (${asset.fileName})...`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`cloudflared 下载失败 (HTTP ${res.status})`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (asset.extractTgz) {
      const tgzPath = path.join(binDir, asset.fileName);
      await writeFile(tgzPath, buffer);
      await extractTgz(tgzPath, binDir, binName);
      await unlink(tgzPath).catch(() => {});
    } else {
      await writeFile(binPath, buffer);
    }

    if (process.platform !== 'win32') {
      await chmod(binPath, 0o755);
    }

    console.log(`[DevFleet] cloudflared 已就绪: ${binPath}`);
    return binPath;
  })();

  try {
    return await cloudflaredDownloadPromise;
  } catch (error) {
    cloudflaredDownloadPromise = null;
    throw new Error(
      error instanceof Error
        ? `未找到 cloudflared 且自动下载失败：${error.message}`
        : '未找到 cloudflared',
    );
  }
}

function getCloudflaredAsset(): { fileName: string; extractTgz: boolean } {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return {
      fileName: arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
      extractTgz: true,
    };
  }
  if (platform === 'linux') {
    return {
      fileName: arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64',
      extractTgz: false,
    };
  }
  if (platform === 'win32') {
    return { fileName: 'cloudflared-windows-amd64.exe', extractTgz: false };
  }
  throw new Error(`暂不支持自动下载 cloudflared（${platform}/${arch}）`);
}

function extractTgz(tgzPath: string, destDir: string, binName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tgzPath, '-C', destDir]);
    proc.on('error', (error) => reject(new Error(`tar 不可用：${error.message}`)));
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`tar 解压失败 (${code ?? 'unknown'})`));
        return;
      }
      const extracted = path.join(destDir, 'cloudflared');
      const target = path.join(destDir, binName);
      if (extracted !== target && fs.existsSync(extracted)) {
        fs.renameSync(extracted, target);
      }
      resolve();
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
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
