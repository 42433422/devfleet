import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

async function bootServer() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-dispatch-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'devfleet.db');
  process.env.JWT_SECRET = 'dispatch-route-test';

  const { default: app } = await import('../api/app.js');
  const { attachWebSocket } = await import('../api/websocket/manager.js');
  const server = http.createServer(app);
  attachWebSocket(new WebSocketServer({ server }));
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let token = '';
  let deviceId = '';
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
    if (!response.ok) throw new Error(body.error || `${response.status} ${url}`);
    return body;
  };

  const auth = await request<{ token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'dispatch@test.local', password: 'secret123' }),
  });
  token = auth.token;

  const binding = await request<{ bindCode: string }>('/api/devices/bind', {
    method: 'POST',
    body: JSON.stringify({ name: 'Worker' }),
  });
  const activation = await request<{ device: { id: string }; deviceToken: string }>('/api/devices/activate', {
    method: 'POST',
    body: JSON.stringify({ bindCode: binding.bindCode, deviceName: 'Worker' }),
  });
  deviceId = activation.device.id;

  deviceSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${activation.deviceToken}`);
  const identityReady = new Promise<void>((resolve) => {
    deviceSocket!.once('message', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    deviceSocket!.once('open', resolve);
    deviceSocket!.once('error', reject);
  });
  await identityReady;

  await request(`/api/devices/${deviceId}/tools`, {
    method: 'PUT',
    body: JSON.stringify({
      tools: [
        { tool_name: 'trae', status: 'idle' },
        { tool_name: 'codex', status: 'idle' },
        { tool_name: 'cursor', status: 'not_installed' },
        { tool_name: 'claude_code', status: 'not_installed' },
      ],
    }),
  });

  return {
    tempDir,
    server,
    request,
    deviceId,
    close: async () => {
      deviceSocket?.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test('MCP 派发路径：device_id 每次只创建一个子任务', async () => {
  const ctx = await bootServer();
  try {
    const first = await ctx.request<{ task: { id: string; subTasks: Array<{ id: string; description: string }> }; subtask: { id: string } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '子任务 A',
        prompt: '修改 README 第一段',
        device_id: ctx.deviceId,
        repo_url: 'https://example.com/repo.git',
        branch: 'main',
      }),
    });
    assert.equal(first.task.subTasks.length, 1);
    assert.equal(first.task.subTasks[0].description, '修改 README 第一段');
    assert.equal(first.subtask.id, first.task.subTasks[0].id);

    const second = await ctx.request<{ task: { id: string; subTasks: Array<{ description: string; sort_order?: number }> } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        task_id: first.task.id,
        title: '子任务 B',
        prompt: '修改 README 第二段',
        device_id: ctx.deviceId,
      }),
    });
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.task.subTasks.length, 2);
    assert.equal(second.task.subTasks[1].description, '修改 README 第二段');
  } finally {
    await ctx.close();
  }
});

test('UI 派发路径：无 device_id 时仍使用 splitTaskIntoSubs', async () => {
  const ctx = await bootServer();
  try {
    const created = await ctx.request<{ task: { subTasks: Array<{ title: string; description: string }> } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'UI 任务',
        description: '完成某功能',
        repo_url: 'https://example.com/repo.git',
        branch: 'main',
      }),
    });
    assert.equal(created.task.subTasks.length, 1);
    assert.equal(created.task.subTasks[0].title, '子任务 1');
    assert.equal(created.task.subTasks[0].description, '完成某功能');
  } finally {
    await ctx.close();
  }
});
