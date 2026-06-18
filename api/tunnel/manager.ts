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
  desired: boolean;
  restarting: boolean;
  restartCount: number;
  failureCount: number;
  lastStartedAt: string | null;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  lastStoppedAt: string | null;
  nextRetryAt: string | null;
};

type ActiveTunnel = {
  id: number;
  url: string;
  provider: TunnelProvider;
  failureCount: number;
  close: () => Promise<void>;
};

type DesiredTunnel = {
  port: number;
  preferred: TunnelProvider | 'auto';
};

const TUNNEL_HEALTH_INTERVAL_MS = readPositiveInt('DEVFLEET_TUNNEL_HEALTH_INTERVAL_MS', 15_000);
const TUNNEL_HEALTH_TIMEOUT_MS = readPositiveInt('DEVFLEET_TUNNEL_HEALTH_TIMEOUT_MS', 8_000);
const TUNNEL_MAX_FAILURES = readPositiveInt('DEVFLEET_TUNNEL_MAX_FAILURES', 2);
const TUNNEL_RESTART_BASE_MS = readPositiveInt('DEVFLEET_TUNNEL_RESTART_BASE_MS', 2_000);
const TUNNEL_RESTART_MAX_MS = readPositiveInt('DEVFLEET_TUNNEL_RESTART_MAX_MS', 60_000);

let activeTunnel: ActiveTunnel | null = null;
let starting: Promise<ActiveTunnel> | null = null;
let lastError: string | null = null;
let desiredTunnel: DesiredTunnel | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let nextRetryAt: string | null = null;
let restarting = false;
let restartCount = 0;
let restartBackoffAttempt = 0;
let lastStartedAt: string | null = null;
let lastCheckedAt: string | null = null;
let lastHealthyAt: string | null = null;
let lastStoppedAt: string | null = null;
let tunnelSequence = 0;
const intentionalCloseIds = new Set<number>();
let cloudflaredDownloadPromise: Promise<string> | null = null;

export function getTunnelStatus(): TunnelStatus {
  return {
    active: Boolean(activeTunnel),
    url: activeTunnel?.url ?? null,
    provider: activeTunnel?.provider ?? null,
    error: lastError,
    desired: Boolean(desiredTunnel),
    restarting: restarting || Boolean(restartTimer),
    restartCount,
    failureCount: activeTunnel?.failureCount ?? 0,
    lastStartedAt,
    lastCheckedAt,
    lastHealthyAt,
    lastStoppedAt,
    nextRetryAt,
  };
}

export async function startBuiltinTunnel(
  port: number,
  preferred: TunnelProvider | 'auto' = 'auto',
): Promise<TunnelStatus> {
  desiredTunnel = { port, preferred };
  clearRestartTimer();

  if (activeTunnel) return getTunnelStatus();
  if (starting) {
    try {
      await starting;
    } catch (error) {
      scheduleTunnelRestart(formatError(error));
      throw error;
    }
    return getTunnelStatus();
  }

  try {
    await openBuiltinTunnel(port, preferred);
    restartBackoffAttempt = 0;
  } catch (error) {
    scheduleTunnelRestart(formatError(error));
    throw error;
  }
  return getTunnelStatus();
}

export async function stopBuiltinTunnel(): Promise<TunnelStatus> {
  desiredTunnel = null;
  restarting = false;
  clearRestartTimer();

  if (starting) {
    try {
      await starting;
    } catch {
      // ignore start failure while stopping
    }
  }
  const wasActive = Boolean(activeTunnel);
  await closeActiveTunnel();
  if (wasActive) {
    console.log('[DevFleet] 内置穿透已关闭');
  }
  return getTunnelStatus();
}

async function openBuiltinTunnel(
  port: number,
  preferred: TunnelProvider | 'auto',
): Promise<ActiveTunnel> {
  if (starting) return starting;

  starting = (async () => {
    lastError = null;
    const providers: TunnelProvider[] = preferred === 'auto'
      ? ['cloudflared', 'localtunnel']
      : [preferred];

    let lastFailure = '无法启动内置穿透';
    for (const provider of providers) {
      const id = ++tunnelSequence;
      try {
        const tunnel = provider === 'cloudflared'
          ? await startCloudflared(port, (reason) => handleUnexpectedClose(id, reason))
          : await startLocaltunnel(port, (reason) => handleUnexpectedClose(id, reason));
        activeTunnel = {
          ...tunnel,
          id,
          failureCount: 0,
        };
        lastStartedAt = new Date().toISOString();
        lastStoppedAt = null;
        console.log(`[DevFleet] 内置穿透已开启 (${tunnel.provider}): ${tunnel.url}`);
        startHealthWatch();
        return activeTunnel;
      } catch (error) {
        lastFailure = formatError(error);
        console.warn(`[DevFleet] ${provider} 穿透失败:`, lastFailure);
      }
    }
    lastError = lastFailure;
    throw new Error(lastFailure);
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function closeActiveTunnel(): Promise<void> {
  const current = activeTunnel;
  if (!current) {
    stopHealthWatch();
    return;
  }

  activeTunnel = null;
  stopHealthWatch();
  markIntentionalClose(current.id);
  try {
    await current.close();
  } catch (error) {
    console.warn('[DevFleet] 关闭内置穿透失败:', error);
  } finally {
    lastStoppedAt = new Date().toISOString();
  }
}

function handleUnexpectedClose(id: number, reason: string): void {
  if (intentionalCloseIds.delete(id)) return;
  if (!activeTunnel || activeTunnel.id !== id) return;

  lastError = reason;
  activeTunnel = null;
  stopHealthWatch();
  lastStoppedAt = new Date().toISOString();
  console.warn('[DevFleet] 内置穿透异常中断:', reason);
  scheduleTunnelRestart(reason);
}

function markIntentionalClose(id: number): void {
  intentionalCloseIds.add(id);
  const timer = setTimeout(() => {
    intentionalCloseIds.delete(id);
  }, 10_000);
  unrefTimer(timer);
}

function scheduleTunnelRestart(reason: string): void {
  if (!desiredTunnel || restartTimer) return;

  lastError = reason;
  restarting = true;
  const delay = Math.min(
    TUNNEL_RESTART_MAX_MS,
    TUNNEL_RESTART_BASE_MS * (2 ** Math.min(restartBackoffAttempt, 5)),
  );
  restartBackoffAttempt += 1;
  nextRetryAt = new Date(Date.now() + delay).toISOString();

  restartTimer = setTimeout(() => {
    restartTimer = null;
    nextRetryAt = null;
    void restartDesiredTunnel(reason);
  }, delay);
  unrefTimer(restartTimer);
}

async function restartDesiredTunnel(reason: string): Promise<void> {
  if (!desiredTunnel) {
    restarting = false;
    return;
  }

  restartCount += 1;
  const desired = desiredTunnel;
  console.warn(`[DevFleet] 正在重启内置穿透：${reason}`);

  await closeActiveTunnel();
  try {
    await openBuiltinTunnel(desired.port, desired.preferred);
    restartBackoffAttempt = 0;
    restarting = false;
  } catch (error) {
    restarting = false;
    scheduleTunnelRestart(formatError(error));
  }
}

function clearRestartTimer(): void {
  if (!restartTimer) return;
  clearTimeout(restartTimer);
  restartTimer = null;
  nextRetryAt = null;
}

function startHealthWatch(): void {
  stopHealthWatch();
  const timer = setInterval(() => {
    void checkTunnelHealth();
  }, TUNNEL_HEALTH_INTERVAL_MS);
  unrefTimer(timer);
  healthTimer = timer;
  void checkTunnelHealth();
}

function stopHealthWatch(): void {
  if (!healthTimer) return;
  clearInterval(healthTimer);
  healthTimer = null;
}

async function checkTunnelHealth(): Promise<void> {
  const current = activeTunnel;
  if (!current || !desiredTunnel || restarting) return;

  lastCheckedAt = new Date().toISOString();
  try {
    await fetchTunnelHealth(current.url);
    if (!activeTunnel || activeTunnel.id !== current.id) return;
    current.failureCount = 0;
    lastHealthyAt = new Date().toISOString();
    if (lastError?.startsWith('公网通道健康检查失败')) {
      lastError = null;
    }
  } catch (error) {
    if (!activeTunnel || activeTunnel.id !== current.id) return;
    current.failureCount += 1;
    lastError = `公网通道健康检查失败 (${current.failureCount}/${TUNNEL_MAX_FAILURES})：${formatError(error)}`;
    console.warn('[DevFleet]', lastError);
    if (current.failureCount >= TUNNEL_MAX_FAILURES) {
      await closeActiveTunnel();
      scheduleTunnelRestart(lastError);
    }
  }
}

async function fetchTunnelHealth(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/health`, {
      signal: controller.signal,
      headers: {
        'Bypass-Tunnel-Reminder': 'true',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => null) as { success?: boolean } | null;
    if (body && body.success === false) throw new Error('服务端健康检查返回失败');
  } finally {
    clearTimeout(timer);
  }
}

async function startLocaltunnel(port: number, onClose: (reason: string) => void): Promise<Omit<ActiveTunnel, 'id' | 'failureCount'>> {
  const tunnel: Tunnel = await localtunnel({ port });

  if (!tunnel.url) throw new Error('localtunnel 未返回公网地址');

  tunnel.once('close', () => onClose('localtunnel 连接已关闭'));
  tunnel.once('error', (error: Error) => onClose(`localtunnel 错误：${error.message}`));

  return {
    url: tunnel.url,
    provider: 'localtunnel',
    close: async () => {
      tunnel.close();
    },
  };
}

async function startCloudflared(port: number, onClose: (reason: string) => void): Promise<Omit<ActiveTunnel, 'id' | 'failureCount'>> {
  const binary = await resolveCloudflaredBinary();
  const proc = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await waitForCloudflaredUrl(proc);
  proc.once('exit', (code, signal) => {
    onClose(`cloudflared 退出 (${signal || code || 'unknown'})`);
  });
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

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
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
