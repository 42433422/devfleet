import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { attachWebSocket } from './websocket/manager.js';

const PORT = Number(process.env.PORT) || 3001;

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });
attachWebSocket(wss);

server.listen(PORT, () => {
  console.log(`[DevFleet] API server ready on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

export default server;
