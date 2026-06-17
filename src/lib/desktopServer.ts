import { isDesktopApp } from '@/lib/agent';
import { probeApiHealth, waitForServerReady } from '@/lib/serverAddress';
import { DEFAULT_API_BASE } from '@/lib/apiBase';
import { getStoredToken } from '@/lib/authSession';
import { wsClient } from '@/lib/websocket';

const invokeRestart = async () => {
  if (!isDesktopApp()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('restart_embedded_server');
};

/** 桌面端：探测本机 API，不可达时触发 Rust 侧重启 embedded server */
export async function recoverDesktopBackend(): Promise<boolean> {
  if (!isDesktopApp()) return false;
  if (await probeApiHealth(DEFAULT_API_BASE, 2500)) return true;
  try {
    await invokeRestart();
  } catch (error) {
    console.warn('[DevFleet] restart_embedded_server failed', error);
  }
  const ready = await waitForServerReady({ maxWaitMs: 20_000, intervalMs: 500 });
  if (ready) {
    const token = getStoredToken();
    if (token) wsClient.connect(token);
  }
  return Boolean(ready);
}

/** 桌面端后台健康探测（运行期间 API 掉线时自动恢复） */
export function startDesktopBackendMonitor(intervalMs = 8000): () => void {
  if (!isDesktopApp()) return () => {};
  let busy = false;
  const timer = window.setInterval(async () => {
    if (busy) return;
    if (await probeApiHealth(DEFAULT_API_BASE, 2000)) return;
    busy = true;
    try {
      await recoverDesktopBackend();
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}
