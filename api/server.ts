import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { flushDB } from './db/store.js';
import { bootstrapDatabase } from './lib/dbBootstrap.js';
import { attachWebSocket } from './websocket/manager.js';
import { shutdownBuiltinTunnel, startBuiltinTunnel } from './tunnel/manager.js';

const PORT = Number(process.env.PORT) || 3001;

try {
  bootstrapDatabase();
} catch (error) {
  console.error('[DevFleet] 数据库启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const server = http.createServer(app);

const wss = new WebSocketServer({ server });
attachWebSocket(wss);

server.listen(PORT, () => {
  console.log(`[DevFleet] API server ready on http://localhost:${PORT}`);
  if (process.env.DEVFLEET_TUNNEL === '1' || process.env.DEVFLEET_TUNNEL === 'auto') {
    void startBuiltinTunnel(PORT, 'auto').then((status) => {
      if (status.url) console.log(`[DevFleet] 内置穿透: ${status.url}`);
    }).catch((error) => {
      console.warn('[DevFleet] 内置穿透自动启动失败:', error instanceof Error ? error.message : error);
    });
  }
});

const shutdown = () => {
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
