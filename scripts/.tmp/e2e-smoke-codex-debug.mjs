#!/usr/bin/env node
/**
 * Codex MCP 闭环冒烟（多设备）：
 * 1) 启动临时 API
 * 2) 注册并绑定一台设备
 * 3) 启动 e2e-agent（Codex stub）
 * 4) 通过 MCP 工具派发任务到目标设备
 * 5) MCP wait_for_task + MCP merge_task 完整闭环
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = process.cwd();
const baseDir = mkdtempSync(path.join(tmpdir(), 'devfleet-codex-e2e-'));
const repoBare = path.join(baseDir, 'bare.git');
const mergeWorkspace = path.join(baseDir, 'merge-workspace');
const agentWorkspace = path.join(baseDir, 'agent-workspace');
const codexStub = path.join(baseDir, 'codex-stub.sh');
const dbFile = path.join(baseDir, 'devfleet.db');
const apiBase = 'http://127.0.0.1:3001';

const log = (...args) => console.log('[codex-e2e-mcp]', ...args);

function run(cmd, args, cwd) {
  const out = execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (out || '').toString().trim();
}

async function api(pathname, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = body && typeof body === 'object' && body.error ? body.error : text;
    throw new Error(`HTTP ${response.status} ${pathname}: ${error}`);
  }
  return body;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function decodeTokenId(token) {
  const payload = token.split('.')[1] || '';
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  const raw = Buffer.from(padded, 'base64').toString('utf8');
  const json = JSON.parse(raw);
  return json;
}

const parseToolResult = (result) => {
  if (result?.isError) {
    const message = (result.content || []).map((item) => item.text).filter(Boolean).join('\n') || 'MCP tool error';
    throw new Error(`MCP tool error: ${message}`);
  }
  const text = result.content?.find((item) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
};

const startMcpClient = async (token) => {
  const mcpBundle = path.join(root, 'scripts/.tmp/mcp-wrap.mjs');
  if (!existsSync(mcpBundle)) {
    throw new Error('缺少 dist-mcp/devfleet-mcp.mjs，请先执行 npm run mcp:build');
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBundle],
    env: {
      ...process.env,
      DEVFLEET_API_URL: apiBase,
      DEVFLEET_TOKEN: token,
    },
  });
  const client = new Client({ name: 'devfleet-codex-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
};

const shutdown = [];

try {
  log('prepare repo at', baseDir);
  execFileSync('bash', ['scripts/e2e-setup-git-repo.sh'], {
    cwd: root,
    env: {
      ...process.env,
      DEVFLEET_E2E_ROOT: baseDir,
    },
    stdio: 'ignore',
  });

  const stub = [
    '#!/usr/bin/env bash',
    'set -e',
    'prompt="${@: -1}"',
    "printf '%s\\n' '# codex stub update' >> \"$PWD/README.md\"",
    'printf "%s\\n" "$prompt" >> "$PWD/README.md"',
    "echo '[codex-stub] done'",
    '',
  ].join('\n');
  writeFileSync(codexStub, stub, 'utf8');
  run('chmod', ['+x', codexStub]);

  log('start api server');
  const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['api/server.ts'], {
    cwd: root,
    env: {
      ...process.env,
      DEVFLEET_DB_FILE: dbFile,
      DEVFLEET_HOST: '127.0.0.1',
      PORT: '3001',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shutdown.push(() => {
    server.kill('SIGINT');
  });
  server.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('API server ready')) {
      log(text.trim());
    }
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${apiBase}/api/health`);
      if (health.ok) break;
    } catch {
      // keep retrying
    }
    await wait(300);
  }

  const register = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `e2e-codex-${Date.now()}@example.com`,
      password: 'Pass1234',
    }),
  });
  const token = register.token;
  log('token length', token.length);
  const claims = decodeTokenId(token);
  log('token claims', `${claims.id} ${claims.email}`);
  const db = new Database(dbFile);
  const row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(claims.id);
  log('db user in local file', JSON.stringify(row));
  db.close();

  const bind = await api('/api/devices/bind', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Win32-codex' }),
  });

  const activation = await api('/api/devices/activate', {
    method: 'POST',
    body: JSON.stringify({
      bindCode: bind.bindCode,
      deviceName: 'Win32-codex',
    }),
  });

  const deviceId = activation.device.id;
  const deviceToken = activation.deviceToken;

  const switchTool = await api(`/api/devices/${encodeURIComponent(deviceId)}/dev-tool`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ devTool: 'codex' }),
  });
  assert(switchTool.device.devTool === 'codex', 'device dev_tool not set to codex');

  log('start e2e agent with stub codex');
  const agent = spawn(process.execPath, [path.join(root, 'scripts', 'e2e-agent.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      DEVFLEET_API_URL: apiBase,
      DEVFLEET_DEVICE_TOKEN: deviceToken,
      DEVFLEET_WORKSPACE_ROOT: agentWorkspace,
      DEVFLEET_BARE_REPO: repoBare,
      DEVFLEET_FORCE_CODEX: '1',
      DEVFLEET_CODEX_AGENT: codexStub,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shutdown.push(() => agent.kill('SIGINT'));
  agent.stdout.on('data', (chunk) => process.stdout.write(`[e2e-agent] ${chunk.toString()}`));
  agent.stderr.on('data', (chunk) => process.stderr.write(`[e2e-agent] ${chunk.toString()}`));

  const waitForDeviceReady = async () => {
    for (let i = 0; i < 60; i += 1) {
      const list = await api('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const item = list.devices?.find((d) => d.id === deviceId);
      const codexTool = item?.tools?.find((t) => t.toolName === 'codex');
      if (item?.status === 'online' && codexTool?.status !== 'not_installed') return item;
      await wait(500);
    }
    throw new Error('device never became online with codex tool');
  };
  await waitForDeviceReady();

  log('start mcp client');
  const preProbe = await api('/api/devices', {
    headers: { Authorization: `Bearer ${token}` },
  });
  log('direct probe status', preProbe.devices?.length);
  const mcp = await startMcpClient(token);
  shutdown.push(async () => {
    await mcp.client.close();
  });

  const listDevicesResult = await mcp.client.callTool({
    name: 'devfleet_list_devices',
    arguments: {},
  });
  console.log('[debug] listDevicesResult=', JSON.stringify(listDevicesResult));
  const listDevices = parseToolResult(listDevicesResult);
  assert(Array.isArray(listDevices.devices), 'MCP 设备列表结构异常');
  const target = listDevices.devices.find((d) => d.id === deviceId);
  assert(target && target.status === 'online', 'MCP 未读到可用 Codex 设备');

  log('dispatch codex task via MCP');
  const marker = `E2E-CODEX-MCP-${Date.now()}`;
  const dispatchResult = parseToolResult(await mcp.client.callTool({
    name: 'devfleet_dispatch_task',
    arguments: {
      title: 'Codex MCP 闭环任务',
      prompt: `请在 README.md 末尾追加一行：${marker}`,
      device_id: deviceId,
      repo_url: `file://${repoBare}`,
      branch: 'main',
    },
  }));
  const task = dispatchResult.task;
  assert(task?.id, 'dispatch_task 未返回 task');
  const taskId = task.id;
  const branchName = task.subTasks?.[0]?.branch_name;
  assert(branchName, 'dispatch 后 task.subTasks 缺少 branch_name');

  log('wait task via MCP');
  const final = parseToolResult(await mcp.client.callTool({
    name: 'devfleet_wait_for_task',
    arguments: {
      task_id: taskId,
      timeout_seconds: 180,
    },
  }));
  assert(final.status === 'completed', `任务最终状态不是 completed: ${final.status}`);

  log('merge via MCP tool');
  const merged = parseToolResult(await mcp.client.callTool({
    name: 'devfleet_merge_task',
    arguments: {
      task_id: taskId,
      workspace_path: mergeWorkspace,
      push: false,
    },
  }));
  assert(merged.success, 'MCP merge_task 未返回 success');

  const apiTask = await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const readme = run('cat', ['README.md'], mergeWorkspace);
  assert(apiTask.task.status === 'merged', '任务状态未标记 merged');
  assert(readme.includes(marker), 'merge-workspace README 缺少 Codex marker');

  log('codex mcp closed-loop PASS', { taskId, branchName, mergeSha: merged.commit });
} catch (error) {
  console.error('[codex-e2e-mcp] FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  while (shutdown.length) {
    const fn = shutdown.shift();
    try {
      if (typeof fn === 'function') {
        fn();
      } else if (fn && typeof fn.then === 'function') {
        fn.then(() => {});
      }
    } catch {
      // ignore
    }
  }
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
