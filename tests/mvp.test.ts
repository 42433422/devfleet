import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

test('账号、设备和任务的 MVP 主流程', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'db.json');
  process.env.JWT_SECRET = 'mvp-test-secret';

  const { default: app } = await import('../api/app.js');
  const { attachWebSocket } = await import('../api/websocket/manager.js');
  const server = http.createServer(app);
  attachWebSocket(new WebSocketServer({ server }));
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
      body: JSON.stringify({ email: 'mvp@example.com', password: 'secret123' }),
    });
    token = auth.token;

    const binding = await request<{ bindCode: string }>('/api/devices/bind', {
      method: 'POST',
      body: JSON.stringify({ name: 'MVP Device' }),
    });
    const activation = await request<{ device: { id: string; isPrimary: boolean }; deviceToken: string; controller: { email: string; primaryDevice: null | { name: string } } }>('/api/devices/activate', {
      method: 'POST',
      body: JSON.stringify({ bindCode: binding.bindCode, deviceName: 'MVP Device' }),
    });
    assert.equal(activation.device.isPrimary, true);
    assert.ok(activation.deviceToken.length >= 32);
    assert.equal(activation.controller.email, 'mvp@example.com');
    assert.equal(activation.controller.primaryDevice?.name, 'MVP Device');

    deviceSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${activation.deviceToken}`);
    const identityMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      deviceSocket!.once('message', (raw) => {
        try {
          resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      deviceSocket!.once('open', resolve);
      deviceSocket!.once('error', reject);
    });
    const identity = await identityMessage;
    assert.equal(identity.type, 'binding_identity');
    assert.equal((identity.controller as { email: string }).email, 'mvp@example.com');

    const devices = await request<{ devices: Array<{ id: string; status: string }> }>('/api/devices');
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].status, 'online');

    await request(`/api/devices/${activation.device.id}/tools`, {
      method: 'PUT',
      body: JSON.stringify({
        tools: [
          { tool_name: 'codex', status: 'idle' },
          { tool_name: 'trae', status: 'idle' },
          { tool_name: 'cursor', status: 'not_installed' },
          { tool_name: 'claude_code', status: 'not_installed' },
        ],
      }),
    });

    const dispatchedMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      deviceSocket!.once('message', (raw) => {
        try {
          resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const created = await request<{ task: { id: string; subTasks: Array<{ id: string }> } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'MVP smoke task',
        description: '实现功能。运行测试。整理结果。',
        repo_url: 'https://example.com/repo.git',
        branch: 'main',
      }),
    });
    assert.ok(created.task.subTasks.length >= 1);
    const dispatched = await dispatchedMessage;
    assert.equal(dispatched.type, 'execute_task');
    assert.equal(dispatched.repo_url, 'https://example.com/repo.git');
    assert.equal(dispatched.tool, 'trae');

    for (const subTask of created.task.subTasks) {
      await request(`/api/tasks/${created.task.id}/subtasks/${subTask.id}/progress`, {
        method: 'POST',
        body: JSON.stringify({ progress: 100, status: 'completed' }),
      });
    }

    const completed = await request<{ task: { status: string } }>(`/api/tasks/${created.task.id}`);
    assert.equal(completed.task.status, 'completed');

    await request(`/api/tasks/${created.task.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ merge_commit_sha: '0123456789abcdef0123456789abcdef01234567' }),
    });
    const merged = await request<{ task: { status: string } }>(`/api/tasks/${created.task.id}`);
    assert.equal(merged.task.status, 'merged');

    await request(`/api/tasks/${created.task.id}`, { method: 'DELETE' });
    const tasks = await request<{ tasks: unknown[] }>('/api/tasks');
    assert.equal(tasks.tasks.length, 0);
  } finally {
    deviceSocket?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(tempDir, { recursive: true, force: true });
  }
});
