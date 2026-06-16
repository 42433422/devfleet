import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

test('设备 WebSocket 重连后补发 pending execute_task', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-reconnect-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'devfleet.db');
  process.env.JWT_SECRET = 'reconnect-dispatch-test';

  const { db } = await import('../api/db/store.js');
  const { default: app } = await import('../api/app.js');
  const { attachWebSocket } = await import('../api/websocket/manager.js');
  const server = http.createServer(app);
  attachWebSocket(new WebSocketServer({ server }));
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let deviceId = '';
  let deviceToken = '';

  try {
    const user = db.users.create({ email: 'reconnect@test.local', password_hash: 'x', is_guest: false });
    const device = db.devices.create({
      user_id: user.id,
      name: 'Reconnect Worker',
      status: 'offline',
      activated: true,
      dev_tool: 'trae',
    });
    deviceId = device.id;
    deviceToken = 'reconnect-device-token-test';
    db.devices.update(deviceId, {
      device_token_hash: createHash('sha256').update(deviceToken).digest('hex'),
      connection_allowed: true,
    });
    db.tools.bulkUpsert(deviceId, [
      { tool_name: 'trae', status: 'idle' },
      { tool_name: 'codex', status: 'idle' },
    ]);

    const task = db.tasks.create({
      user_id: user.id,
      title: '离线 pending 补发',
      description: '改 README',
      status: 'running',
      repo_url: 'file:///tmp/devfleet-e2e/bare.git',
      branch: 'main',
    });
    const sub = db.subTasks.create({
      task_id: task.id,
      device_id: deviceId,
      tool_name: 'trae',
      status: 'pending',
      branch_name: 'devfleet/trae/sub-1-test',
      progress: 0,
      title: '子任务',
      description: '改 README',
    });

    const dispatchedMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${deviceToken}`);
      const timer = setTimeout(() => reject(new Error('等待 execute_task 超时')), 5000);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'binding_identity') return;
          if (msg.type === 'execute_task') {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'tool_status',
          tools: [{ tool_name: 'trae', status: 'idle' }],
          capabilities: { node_version: 'v22', docker: false, gpu: false },
        }));
      });
      ws.once('error', reject);
    });

    const dispatched = await dispatchedMessage;
    assert.equal(dispatched.type, 'execute_task');
    assert.equal(dispatched.task_id, task.id);
    assert.equal(dispatched.subtask_id, sub.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
