import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

test('WebSocket 应用层 ping/pong 心跳', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-ws-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'ws.db');
  process.env.JWT_SECRET = 'ws-heartbeat-test';

  const { default: app } = await import('../api/app.js');
  const { attachWebSocket } = await import('../api/websocket/manager.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');

  const server = http.createServer(app);
  attachWebSocket(new WebSocketServer({ server }));
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const auth = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
    const { token } = await auth.json() as { token: string };

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/client?token=${token}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'ping' }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'pong') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('pong timeout')), 5000);
    });
  } finally {
    server.close();
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
});
