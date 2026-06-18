import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

function nextJsonMessage(ws: WebSocket, predicate: (message: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

test('主设备可以向工作设备下发受控远程命令并接收结果', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-remote-command-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'remote-command.db');
  process.env.JWT_SECRET = 'remote-command-test-secret';

  const { default: app } = await import('../api/app.js');
  const { closeDatabase } = await import('../api/db/sqlite.js');
  const { attachWebSocket, resetWebSocketStateForTest } = await import('../api/websocket/manager.js');
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  attachWebSocket(wss);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let token = '';
  let deviceSocket: WebSocket | null = null;
  const request = async <T>(url: string, options: RequestInit = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const body = await response.json() as T & { error?: string };
    assert.equal(response.ok, true, body.error || `${response.status} ${url}`);
    return body;
  };

  try {
    const auth = await request<{ token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'remote-command@example.com', password: 'secret123' }),
    });
    token = auth.token;

    const binding = await request<{ bindCode: string }>('/api/devices/bind', {
      method: 'POST',
      body: JSON.stringify({ name: 'Remote Command Device' }),
    });
    const activation = await request<{ device: { id: string }; deviceToken: string }>('/api/devices/activate', {
      method: 'POST',
      body: JSON.stringify({ bindCode: binding.bindCode, deviceName: 'Remote Command Device' }),
    });

    deviceSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${activation.deviceToken}`);
    const identityMessage = nextJsonMessage(deviceSocket, (message) => message.type === 'binding_identity');
    await new Promise<void>((resolve, reject) => {
      deviceSocket!.once('open', resolve);
      deviceSocket!.once('error', reject);
    });
    await identityMessage;

    const rejected = await fetch(`${baseUrl}/api/devices/${activation.device.id}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ shell: 'sh', script: 'echo should-not-run' }),
    });
    assert.equal(rejected.status, 400);

    const executeMessage = nextJsonMessage(deviceSocket, (message) => message.type === 'execute_command');
    const created = await request<{ command: { id: string; status: string; shell: string } }>(
      `/api/devices/${activation.device.id}/commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'remote command smoke',
          shell: 'sh',
          script: 'echo hello-from-device',
          timeout_seconds: 30,
          dangerous: true,
        }),
      },
    );
    assert.equal(created.command.status, 'running');
    assert.equal(created.command.shell, 'sh');

    const execute = await executeMessage;
    assert.equal(execute.command_id, created.command.id);
    assert.equal(execute.shell, 'sh');
    assert.equal(execute.script, 'echo hello-from-device');
    assert.equal(execute.timeout_seconds, 30);

    deviceSocket.send(JSON.stringify({
      type: 'command_log',
      command_id: created.command.id,
      level: 'info',
      content: 'script reached device',
    }));
    deviceSocket.send(JSON.stringify({
      type: 'command_result',
      command_id: created.command.id,
      status: 'completed',
      exit_code: 0,
      stdout: 'hello-from-device\n',
      stderr: '',
    }));

    const started = Date.now();
    let command:
      | { status: string; stdout?: string; logs: Array<{ content: string }> }
      | undefined;
    while (Date.now() - started < 2_000) {
      const response = await request<{ command: { status: string; stdout?: string; logs: Array<{ content: string }> } }>(
        `/api/devices/${activation.device.id}/commands/${created.command.id}`,
      );
      command = response.command;
      if (command.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(command?.status, 'completed');
    assert.equal(command?.stdout, 'hello-from-device\n');
    assert.ok(command?.logs.some((log) => log.content.includes('script reached device')));

    const list = await request<{ commands: Array<{ id: string; status: string }> }>(
      `/api/devices/${activation.device.id}/commands`,
    );
    assert.ok(list.commands.some((item) => item.id === created.command.id && item.status === 'completed'));
  } finally {
    deviceSocket?.close();
    resetWebSocketStateForTest();
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
