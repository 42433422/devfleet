import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root');
}

root.innerHTML = `
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f1115;
      color: #e8eaed;
    }
    .card {
      width: min(560px, calc(100vw - 48px));
      padding: 28px 32px;
      border-radius: 12px;
      background: #171a21;
      border: 1px solid #2a3140;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    }
    h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
    p { margin: 0 0 12px; line-height: 1.6; color: #b8c0cc; }
    pre {
      margin: 16px 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: #0b0d11;
      border: 1px solid #2a3140;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      color: #ffb4b4;
    }
    .log-path { font-size: 13px; color: #8b949e; word-break: break-all; }
    .actions { display: flex; gap: 12px; margin-top: 20px; }
    button {
      appearance: none;
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      font-size: 14px;
      cursor: pointer;
    }
    #retry { background: #3b82f6; color: white; }
    #retry:disabled { opacity: 0.6; cursor: not-allowed; }
    #quit {
      background: transparent;
      color: #b8c0cc;
      border: 1px solid #2a3140;
    }
    .status { margin-top: 12px; min-height: 20px; font-size: 13px; color: #8b949e; }
  </style>
  <div class="card">
    <h1>内嵌后端未能启动</h1>
    <p>DevFleet 无法在本机 3001 端口启动内嵌 API。主界面已阻止打开，避免断连体验。</p>
    <pre id="error">正在读取错误信息…</pre>
    <p class="log-path">日志：<span id="log-path">—</span></p>
    <div class="actions">
      <button id="retry" type="button">重试启动</button>
      <button id="quit" type="button">退出应用</button>
    </div>
    <div class="status" id="status"></div>
  </div>
`;

const errorEl = root.querySelector('#error') as HTMLPreElement;
const logPathEl = root.querySelector('#log-path') as HTMLSpanElement;
const statusEl = root.querySelector('#status') as HTMLDivElement;
const retryBtn = root.querySelector('#retry') as HTMLButtonElement;
const quitBtn = root.querySelector('#quit') as HTMLButtonElement;

async function loadErrorDetails() {
  try {
    const [error, logPath] = await Promise.all([
      invoke<string | null>('get_cold_start_error'),
      invoke<string>('get_embedded_server_log_path'),
    ]);
    errorEl.textContent = error || '未知错误';
    logPathEl.textContent = logPath || '—';
  } catch (loadError) {
    errorEl.textContent = String(loadError);
  }
}

retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true;
  statusEl.textContent = '正在重新启动内嵌后端…';
  try {
    await invoke('retry_cold_start');
    await invoke('start_desktop_services');
    statusEl.textContent = '启动成功，正在进入主界面…';
    window.location.replace('index.html');
  } catch (error) {
    statusEl.textContent = '';
    errorEl.textContent = String(error);
    retryBtn.disabled = false;
  }
});

quitBtn.addEventListener('click', async () => {
  await getCurrentWindow().close();
});

void loadErrorDetails();
