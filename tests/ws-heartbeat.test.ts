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
  const { attachWebSocket, resetWebSocketStateForTest } = await import('../api/websocket/manager.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  attachWebSocket(wss);
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
    resetWebSocketStateForTest();
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('设备 WebSocket 不会在首次服务端 ping 前被 pong 超时误杀', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-ws-device-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'ws-device.db');
  process.env.JWT_SECRET = 'ws-device-heartbeat-test';

  const { default: app } = await import('../api/app.js');
  const { attachWebSocket, resetWebSocketStateForTest } = await import('../api/websocket/manager.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  attachWebSocket(wss);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let deviceSocket: WebSocket | null = null;

  try {
    const auth = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ws-device@example.com', password: 'secret123' }),
    });
    const { token } = await auth.json() as { token: string };

    const binding = await fetch(`${baseUrl}/api/devices/bind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: 'Heartbeat Device' }),
    });
    const { bindCode } = await binding.json() as { bindCode: string };

    const activation = await fetch(`${baseUrl}/api/devices/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindCode, deviceName: 'Heartbeat Device' }),
    });
    const { deviceToken } = await activation.json() as { deviceToken: string };

    deviceSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${deviceToken}`);
    await new Promise<void>((resolve, reject) => {
      deviceSocket!.once('open', resolve);
      deviceSocket!.once('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 12_000);
      deviceSocket!.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('device websocket closed before first server heartbeat'));
      });
      deviceSocket!.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    deviceSocket?.close();
    resetWebSocketStateForTest();
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
