import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { flushDB } from './db/store.js';
import { attachWebSocket } from './websocket/manager.js';

const PORT = Number(process.env.PORT) || 3001;

const server = http.createServer(app);

const wss = new WebSocketServer({ server });
attachWebSocket(wss);

server.listen(PORT, () => {
  console.log(`[DevFleet] API server ready on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    flushDB();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    flushDB();
    process.exit(0);
  });
});

export default server;
