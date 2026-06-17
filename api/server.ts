import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { flushDB } from './db/store.js';
import { bootstrapDatabase } from './lib/dbBootstrap.js';
import { attachWebSocket } from './websocket/manager.js';
import { reapStaleRunningSubtasks } from './lib/dispatch.js';
import { shutdownBuiltinTunnel, startBuiltinTunnel } from './tunnel/manager.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.DEVFLEET_HOST || '0.0.0.0';
const SUBTASK_REAPER_MS = Number(process.env.DEVFLEET_SUBTASK_REAPER_MS) || 30_000;

try {
  bootstrapDatabase();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error('[DevFleet] 数据库启动失败:', detail);
  console.error('[DevFleet] DB path:', process.env.DEVFLEET_DB_FILE || '(auto)');
  process.exit(1);
}

const server = http.createServer(app);

const wss = new WebSocketServer({ server });
attachWebSocket(wss);

let reapInterval: NodeJS.Timeout | null = null;

function startSubtaskReaper() {
  if (reapInterval) return;
  reapInterval = setInterval(() => {
    try {
      const reclaimed = reapStaleRunningSubtasks();
      if (reclaimed > 0) {
        console.log(`[DevFleet] 已回收超时运行子任务: ${reclaimed}`);
      }
    } catch (error) {
      console.error('[DevFleet] 回收超时子任务失败:', error instanceof Error ? error.message : error);
    }
  }, SUBTASK_REAPER_MS);
  reapInterval.unref();
}

function stopSubtaskReaper() {
  if (!reapInterval) return;
  clearInterval(reapInterval);
  reapInterval = null;
}

server.listen(PORT, HOST, () => {
  console.log(`[DevFleet] API server ready on http://${HOST}:${PORT}`);
  startSubtaskReaper();
  if (HOST === '0.0.0.0') {
    console.log(`[DevFleet] 局域网设备可连 http://<本机IP>:${PORT}`);
  }
  if (process.env.DEVFLEET_DB_FILE) {
    console.log(`[DevFleet] database: ${process.env.DEVFLEET_DB_FILE}`);
  }
  if (process.env.DEVFLEET_TUNNEL === '1' || process.env.DEVFLEET_TUNNEL === 'auto') {
    void startBuiltinTunnel(PORT, 'auto').then((status) => {
      if (status.url) console.log(`[DevFleet] 内置穿透: ${status.url}`);
    }).catch((error) => {
      console.warn('[DevFleet] 内置穿透自动启动失败:', error instanceof Error ? error.message : error);
    });
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('[DevFleet] API server listen failed:', error.message);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[DevFleet] uncaughtException:', error instanceof Error ? error.stack || error.message : error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[DevFleet] unhandledRejection:', reason);
});

const shutdown = () => {
  stopSubtaskReaper();
  void shutdownBuiltinTunnel().finally(() => {
    server.close(() => {
      flushDB();
      process.exit(0);
    });
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default server;
