#!/usr/bin/env node
/**
 * 轻量 E2E 设备代理：WebSocket 连接 DevFleet，接收 execute_task，
 * 克隆工作区并等待 auto-touch / Trae 改码，完成后 commit + push。
 * 用于 npm run e2e:loop -- --auto-touch 在无桌面代理在线时保底闭环。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);

const token = process.env.DEVFLEET_DEVICE_TOKEN || resolveDeviceToken();
const apiBase = (process.env.DEVFLEET_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const workspaceRoot = process.env.DEVFLEET_WORKSPACE_ROOT || '/tmp/devfleet-e2e/agent-workspace';
const bareRepo = process.env.DEVFLEET_BARE_REPO || '/tmp/devfleet-e2e/bare.git';
const wsUrl = `${apiBase.replace(/^http/, 'ws')}/ws/device?token=${encodeURIComponent(token)}`;
const toolCommandTimeoutMs = (() => {
  const raw = process.env.DEVFLEET_AI_AGENT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 900_000;
})();

function resolveAgentConfig() {
  const paths = [
    join(homedir(), 'Library/Application Support/com.devfleet.desktop/agent.json'),
    join(homedir(), 'Library/Application Support/com.devfleet.app/agent.json'),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // ignore
    }
  }
  return null;
}

function resolveCursorAgentBin() {
  if (process.env.DEVFLEET_CURSOR_AGENT?.trim()) {
    return process.env.DEVFLEET_CURSOR_AGENT.trim();
  }
  const local = join(homedir(), '.local/bin/agent');
  if (existsSync(local)) return local;
  return 'agent';
}

function resolveCodexAgentBin() {
  if (process.env.DEVFLEET_CODEX_AGENT?.trim()) {
    return process.env.DEVFLEET_CODEX_AGENT.trim();
  }
  const local = join(homedir(), '.local/bin/codex');
  if (existsSync(local)) return local;
  return 'codex';
}

function cursorAgentAvailable() {
  const bin = resolveCursorAgentBin();
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  return true;
}

function codexAgentAvailable() {
  const bin = resolveCodexAgentBin();
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  return true;
}

async function runCursorAgent(taskDir, prompt) {
  const agentBin = resolveCursorAgentBin();
  const { stdout, stderr } = await execFileAsync(
    agentBin,
    ['-p', '--force', '--trust', '--output-format', 'text', prompt],
    {
      cwd: taskDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: toolCommandTimeoutMs,
      env: process.env,
    },
  );
  return (stdout || stderr || '').trim();
}

async function runCodexAgent(taskDir, prompt) {
  const codexBin = resolveCodexAgentBin();
  const { stdout, stderr } = await execFileAsync(
    codexBin,
    ['exec', '--sandbox', 'workspace-write', '--ephemeral', prompt],
    {
      cwd: taskDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: toolCommandTimeoutMs,
      env: process.env,
    },
  );
  return (stdout || stderr || '').trim();
}

function resolveDeviceToken() {
  const paths = [
    join(homedir(), 'Library/Application Support/com.devfleet.desktop/agent.json'),
    join(homedir(), 'Library/Application Support/com.devfleet.app/agent.json'),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed.deviceToken) return parsed.deviceToken;
    } catch {
      // ignore
    }
  }
  throw new Error('缺少 DEVFLEET_DEVICE_TOKEN，且未找到 agent.json');
}

const git = async (cwd, args) => {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return (stdout || stderr).trim();
};

const send = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

const safeDir = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, '-');

const defaultCapabilities = () => ({
  node_version: process.version,
  docker: false,
  gpu: false,
  e2e_agent: true,
});

async function prepareWorkspace(task) {
  const repoUrl = (task.repo_url || '').trim();
  const taskDir = repoUrl ? join(workspaceRoot, safeDir(task.task_id)) : workspaceRoot;
  mkdirSync(workspaceRoot, { recursive: true });

  if (!repoUrl) {
    mkdirSync(taskDir, { recursive: true });
    if (!existsSync(join(taskDir, '.git'))) await git(taskDir, ['init', '-b', task.base_branch || 'main']);
    try {
      await git(taskDir, ['checkout', task.work_branch]);
    } catch {
      await git(taskDir, ['checkout', '-b', task.work_branch]);
    }
    return taskDir;
  }

  await execFileAsync('rm', ['-rf', taskDir]);
  await git(process.cwd(), ['clone', '--branch', task.base_branch || 'main', '--single-branch', repoUrl, taskDir]);
  await git(taskDir, ['checkout', '-b', task.work_branch]);
  return taskDir;
}

async function waitForMeaningfulChanges(taskDir, timeoutMs = 900_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dirty = await git(taskDir, [
      'status', '--porcelain', '--', '.', ':!.devfleet', ':!.trae',
    ]);
    if (dirty) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function pushBranch(taskDir, branch) {
  try {
    await git(taskDir, ['push', '-u', 'origin', branch]);
    return;
  } catch {
    // origin push may fail for file:// or missing HTTP git daemon
  }
  await git(taskDir, ['push', '-u', bareRepo, `HEAD:${branch}`]);
}

async function finalizeTask(ws, task, taskDir) {
  await git(taskDir, ['config', 'user.name', 'DevFleet E2E Agent']);
  await git(taskDir, ['config', 'user.email', 'e2e@devfleet.local']);
  await git(taskDir, ['add', '-A']);
  await git(taskDir, ['commit', '-m', `devfleet: ${task.title}`]);
  await pushBranch(taskDir, task.work_branch);
  send(ws, {
    type: 'task_progress',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    progress: 100,
    status: 'completed',
  });
  send(ws, {
    type: 'task_log',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    content: 'E2E agent 已完成 commit 与 push',
    level: 'info',
  });
}

async function handleTask(ws, task) {
  send(ws, {
    type: 'task_progress',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    progress: 10,
    status: 'running',
  });
  const taskDir = await prepareWorkspace(task);
  mkdirSync(join(taskDir, '.devfleet'), { recursive: true });
  writeFileSync(
    join(taskDir, '.devfleet', 'TASK.md'),
    `# DevFleet 任务\n\n## 标题\n${task.title}\n\n## 要求\n${task.description}\n\n## 工作分支\n${task.work_branch}\n`,
  );
  send(ws, {
    type: 'task_log',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    content: `[e2e-agent] 工作区就绪: ${taskDir}`,
    level: 'info',
  });
  send(ws, {
    type: 'task_progress',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    progress: 40,
    status: 'running',
  });

  const agentConfig = resolveAgentConfig();
  const devTool = task.tool || agentConfig?.devTool;
  const useCursor =
    process.env.DEVFLEET_E2E_CURSOR !== '0'
    && (devTool === 'cursor' || process.env.DEVFLEET_FORCE_CURSOR === '1')
    && cursorAgentAvailable();
  const useCodex =
    (devTool === 'codex' || process.env.DEVFLEET_FORCE_CODEX === '1')
    && codexAgentAvailable();

  if (useCursor) {
    send(ws, {
      type: 'task_log',
      task_id: task.task_id,
      subtask_id: task.subtask_id,
      content: `[e2e-agent] 调用 Cursor Agent CLI 修改代码`,
      level: 'info',
    });
    try {
      const output = await runCursorAgent(taskDir, task.description);
      if (output) {
        send(ws, {
          type: 'task_log',
          task_id: task.task_id,
          subtask_id: task.subtask_id,
          content: output.slice(0, 4000),
          level: 'info',
        });
      }
    } catch (err) {
      send(ws, {
        type: 'task_log',
        task_id: task.task_id,
        subtask_id: task.subtask_id,
        content: `[e2e-agent] Cursor Agent 失败: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
  }

  if (useCodex) {
    send(ws, {
      type: 'task_log',
      task_id: task.task_id,
      subtask_id: task.subtask_id,
      content: '[e2e-agent] 调用 Codex CLI 修改代码',
      level: 'info',
    });
    try {
      const output = await runCodexAgent(taskDir, task.description);
      if (output) {
        send(ws, {
          type: 'task_log',
          task_id: task.task_id,
          subtask_id: task.subtask_id,
          content: output.slice(0, 4000),
          level: 'info',
        });
      }
    } catch (err) {
      send(ws, {
        type: 'task_log',
        task_id: task.task_id,
        subtask_id: task.subtask_id,
        content: `[e2e-agent] Codex CLI 失败: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
  }

  const waitMs = useCursor || useCodex ? 120_000 : 900_000;
  if (!(await waitForMeaningfulChanges(taskDir, waitMs))) {
    send(ws, {
      type: 'task_progress',
      task_id: task.task_id,
      subtask_id: task.subtask_id,
      progress: 0,
      status: 'failed',
    });
    return;
  }

  send(ws, {
    type: 'task_progress',
    task_id: task.task_id,
    subtask_id: task.subtask_id,
    progress: 80,
    status: 'running',
  });
  await finalizeTask(ws, task, taskDir);
}

function publishToolStatus(ws) {
  const cursorStatus = cursorAgentAvailable() ? 'idle' : 'not_installed';
  const codexStatus = codexAgentAvailable() ? 'idle' : 'not_installed';
  send(ws, {
    type: 'tool_status',
    tools: [
      { tool_name: 'trae', status: 'not_installed' },
      { tool_name: 'codex', status: codexStatus },
      { tool_name: 'cursor', status: cursorStatus },
      { tool_name: 'claude_code', status: 'not_installed' },
    ],
    capabilities: {
      ...defaultCapabilities(),
      e2e_agent: true,
      cursor_agent_cli: cursorAgentAvailable(),
      codex_cli: codexAgentAvailable(),
    },
  });
}

function connect() {
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    console.log('[e2e-agent] online');
    publishToolStatus(ws);
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'execute_task') {
        handleTask(ws, msg).catch((err) => {
          console.error('[e2e-agent] task error', err);
          send(ws, {
            type: 'task_progress',
            task_id: msg.task_id,
            subtask_id: msg.subtask_id,
            progress: 0,
            status: 'failed',
          });
        });
      }
    } catch (err) {
      console.error('[e2e-agent] bad message', err);
    }
  });
  ws.on('close', () => {
    console.log('[e2e-agent] disconnected, retry in 3s');
    setTimeout(connect, 3000);
  });
  ws.on('error', (err) => console.error('[e2e-agent] ws error', err.message));
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    publishToolStatus(ws);
  }, 30_000);
}

if (process.argv.includes('--spawn')) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  console.log(`[e2e-agent] spawned pid ${child.pid}`);
} else {
  connect();
}
