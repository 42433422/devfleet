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
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(parsed)) return;
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('message timeout'));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

test('远端 Codex 协作会话保留上下文并回填设备回复', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-collab-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'devfleet.db');
  process.env.JWT_SECRET = 'collab-session-test';

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
  let deviceToken = '';
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
      body: JSON.stringify({ email: 'collab@example.com', password: 'secret123' }),
    });
    token = auth.token;

    const binding = await request<{ bindCode: string }>('/api/devices/bind', {
      method: 'POST',
      body: JSON.stringify({ name: 'Win32 Codex' }),
    });
    const activation = await request<{ device: { id: string }; deviceToken: string }>('/api/devices/activate', {
      method: 'POST',
      body: JSON.stringify({ bindCode: binding.bindCode, deviceName: 'Win32 Codex' }),
    });
    deviceToken = activation.deviceToken;

    deviceSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/device?token=${deviceToken}`);
    const identityMessage = nextJsonMessage(deviceSocket, (message) => message.type === 'binding_identity');
    await new Promise<void>((resolve, reject) => {
      deviceSocket!.once('open', resolve);
      deviceSocket!.once('error', reject);
    });
    await identityMessage;

    await request(`/api/devices/${activation.device.id}/tools`, {
      method: 'PUT',
      body: JSON.stringify({
        tools: [
          { tool_name: 'codex', status: 'idle' },
          { tool_name: 'trae', status: 'not_installed' },
          { tool_name: 'cursor', status: 'not_installed' },
          { tool_name: 'claude_code', status: 'not_installed' },
        ],
      }),
    });

    const created = await request<{ session: { id: string; task_id: string; status: string } }>('/api/collab/sessions', {
      method: 'POST',
      body: JSON.stringify({
        device_id: activation.device.id,
        title: '双端 Codex 协作',
        repo_url: 'https://example.com/repo.git',
        branch: 'main',
      }),
    });
    assert.equal(created.session.status, 'open');

    const dispatchedMessage = nextJsonMessage(deviceSocket, (message) => message.type === 'execute_task');
    const sent = await request<{ message: { id: string; status: string }; subtask_id: string }>(
      `/api/collab/sessions/${created.session.id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: '请基于上一轮上下文修复 README 并说明验证方式' }),
      },
    );
    assert.ok(sent.subtask_id);
    const dispatched = await dispatchedMessage;
    assert.equal(dispatched.type, 'execute_task');
    assert.equal(dispatched.tool, 'codex');
    assert.equal(dispatched.task_id, created.session.task_id);
    assert.equal(dispatched.subtask_id, sent.subtask_id);
    assert.match(String(dispatched.description), /持续协作/);
    assert.match(String(dispatched.description), /请基于上一轮上下文修复 README/);

    const secondDispatchedMessage = nextJsonMessage(deviceSocket, (message) =>
      message.type === 'execute_task' && message.subtask_id !== sent.subtask_id,
    );
    const second = await request<{
      message: { id: string; status: string };
      subtask_id: string;
      session: { turn_count: number; queued_count: number; running_count: number; context_summary: string };
    }>(
      `/api/collab/sessions/${created.session.id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: '继续补充：如果 README 已改好，请再补一个验证说明' }),
      },
    );
    assert.equal(second.message.status, 'queued');
    assert.equal(second.session.turn_count, 2);
    assert.equal(second.session.queued_count, 1);
    assert.equal(second.session.running_count, 1);
    assert.match(second.session.context_summary, /继续补充/);

    const taskWithQueue = await request<{ task: { subTasks: Array<{ id: string; status: string; depends_on: string[] }> } }>(
      `/api/tasks/${created.session.task_id}`,
    );
    const queuedSub = taskWithQueue.task.subTasks.find((sub) => sub.id === second.subtask_id);
    assert.equal(queuedSub?.status, 'pending');
    assert.deepEqual(queuedSub?.depends_on, [sent.subtask_id]);

    const reportResponse = await fetch(`${baseUrl}/api/devices/me/task-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        task_id: created.session.task_id,
        subtask_id: sent.subtask_id,
        progress: 100,
        status: 'completed',
        content: '远端 Codex 已完成 README 修改并通过检查',
      }),
    });
    assert.equal(reportResponse.ok, true);
    const secondDispatched = await secondDispatchedMessage;
    assert.equal(secondDispatched.type, 'execute_task');
    assert.equal(secondDispatched.tool, 'codex');
    assert.equal(secondDispatched.subtask_id, second.subtask_id);
    assert.match(String(secondDispatched.description), /继续补充/);

    const secondReportResponse = await fetch(`${baseUrl}/api/devices/me/task-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        task_id: created.session.task_id,
        subtask_id: second.subtask_id,
        progress: 100,
        status: 'completed',
        content: '远端 Codex 已补充验证说明',
      }),
    });
    assert.equal(secondReportResponse.ok, true);

    const loaded = await request<{ session: {
      turn_count: number;
      queued_count: number;
      running_count: number;
      messages: Array<{ role: string; content: string; status: string; sub_task_id?: string }>;
    } }>(
      `/api/collab/sessions/${created.session.id}`,
    );
    assert.equal(loaded.session.turn_count, 2);
    assert.equal(loaded.session.queued_count, 0);
    assert.equal(loaded.session.running_count, 0);
    const userMessage = loaded.session.messages.find((message) => message.sub_task_id === sent.subtask_id && message.role === 'user');
    assert.equal(userMessage?.status, 'completed');
    assert.ok(loaded.session.messages.some((message) =>
      message.role === 'assistant'
      && message.sub_task_id === sent.subtask_id
      && message.content.includes('远端 Codex 已完成 README 修改'),
    ));
    assert.ok(loaded.session.messages.some((message) =>
      message.role === 'assistant'
      && message.sub_task_id === second.subtask_id
      && message.content.includes('远端 Codex 已补充验证说明'),
    ));
  } finally {
    deviceSocket?.close();
    resetWebSocketStateForTest();
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
