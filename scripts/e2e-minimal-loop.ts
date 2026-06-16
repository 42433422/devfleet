#!/usr/bin/env tsx
/**
 * DevFleet 最小闭环 E2E：模拟 Cursor MCP 派发 → Trae 工作设备执行 → Git push → 主设备 merge。
 * 各阶段计时输出，便于本机验证 Cursor → Trae 全流程。
 */
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));

const apiBaseUrl = (process.env.DEVFLEET_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.DEVFLEET_TOKEN || '';
const repoUrl = process.env.DEVFLEET_REPO_URL || '';
const mergeWorkspace = process.env.DEVFLEET_MERGE_WORKSPACE || '';
const workspaceRoot = process.env.DEVFLEET_WORKSPACE_ROOT || '';
const autoTouch = process.argv.includes('--auto-touch');
const skipMerge = process.argv.includes('--skip-merge');
const timeoutSeconds = Number.parseInt(
  process.argv.find((arg) => arg.startsWith('--timeout='))?.split('=')[1]
    || process.env.DEVFLEET_E2E_TIMEOUT
    || '900',
  10,
);

interface PhaseTiming {
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

interface Task {
  id: string;
  title: string;
  status: string;
  repo_url: string;
  branch: string;
  subTasks: Array<{
    id: string;
    branch_name: string;
    status: string;
    progress: number;
    logs?: Array<{ content: string }>;
  }>;
}

const timings: PhaseTiming[] = [];
let flowStartedAt = Date.now();

const startPhase = (name: string) => {
  const phase: PhaseTiming = { name, startedAt: Date.now() };
  timings.push(phase);
  console.log(`\n▶ ${name}`);
  return phase;
};

const endPhase = (phase: PhaseTiming) => {
  phase.endedAt = Date.now();
  phase.durationMs = phase.endedAt - phase.startedAt;
  console.log(`✓ ${phase.name}: ${formatMs(phase.durationMs)}`);
};

const formatMs = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const api = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  if (!token) throw new Error('缺少 DEVFLEET_TOKEN（从 DevFleet Integration 页复制用户 JWT）');
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `API 失败 (${response.status}) ${path}`);
  return body;
};

const git = async (cwd: string, args: string[]) => {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return (stdout || stderr).trim();
};

const normalizeRepo = (value: string) =>
  value.trim()
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^file:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();

const sameRepo = (left: string, right: string) => {
  const a = normalizeRepo(left);
  const b = normalizeRepo(right);
  if (a === b) return true;
  const e2eBare = 'devfleet-e2e/bare';
  return (a.includes(e2eBare) && b.includes('8765/bare'))
    || (b.includes(e2eBare) && a.includes('8765/bare'));
};

const printSummary = () => {
  const totalMs = Date.now() - flowStartedAt;
  console.log('\n========== E2E 计时汇总 ==========');
  for (const phase of timings) {
    console.log(`  ${phase.name.padEnd(28)} ${formatMs(phase.durationMs || 0)}`);
  }
  console.log(`  ${'总耗时'.padEnd(28)} ${formatMs(totalMs)}`);
  console.log('==================================\n');
};

const resolveTaskWorkspace = (taskId: string) => {
  if (!workspaceRoot) return null;
  if (repoUrl.trim()) return `${workspaceRoot}/${taskId}`;
  return workspaceRoot;
};

const autoTouchWorkspace = async (taskId: string) => {
  const dir = resolveTaskWorkspace(taskId);
  if (!dir) {
    console.log('未设置 DEVFLEET_WORKSPACE_ROOT，跳过 --auto-touch');
    return;
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (existsSync(dir)) break;
    await sleep(1000);
  }
  if (!existsSync(dir)) {
    throw new Error(`等待任务工作区超时: ${dir}`);
  }
  mkdirSync(`${dir}/.devfleet`, { recursive: true });
  const marker = `${dir}/.devfleet/E2E_MARKER.txt`;
  const line = `[${new Date().toISOString()}] auto-touch by e2e-minimal-loop\n`;
  writeFileSync(marker, line, 'utf8');
  appendFileSync(`${dir}/README.md`, `\n${line}`, 'utf8');
  console.log(`已写入测试变更: ${marker}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const listOnlineTraeDevices = async () => {
  const { devices } = await api<{ devices: Array<{
    id: string;
    name: string;
    status: string;
    devTool: string;
    tools: Array<{ toolName: string; status: string }>;
  }> }>('/api/devices');
  return devices.filter((device) => device.status === 'online' && device.devTool === 'trae');
};

const ensureE2eAgent = async () => {
  const online = await listOnlineTraeDevices();
  if (online.length > 0) {
    console.log(`已有在线 Trae 设备: ${online.map((d) => d.name).join(', ')}`);
    return;
  }

  const phase = startPhase('启动 E2E 设备代理 (e2e-agent.mjs)');
  const agentScript = join(scriptDir, 'e2e-agent.mjs');
  if (!existsSync(agentScript)) {
    throw new Error(`未找到 ${agentScript}`);
  }

  spawn(process.execPath, [agentScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DEVFLEET_API_URL: apiBaseUrl,
      DEVFLEET_WORKSPACE_ROOT: workspaceRoot || '/tmp/devfleet-e2e/agent-workspace',
      DEVFLEET_BARE_REPO: process.env.DEVFLEET_BARE_REPO || '/tmp/devfleet-e2e/bare.git',
    },
  }).unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const ready = await listOnlineTraeDevices();
    if (ready.length > 0) {
      console.log(`E2E 代理已上线: ${ready.map((d) => d.name).join(', ')}`);
      endPhase(phase);
      return;
    }
  }
  endPhase(phase);
  throw new Error('E2E 设备代理 30s 内未上线。请确认 DevFleet API 运行且 agent.json 存在，或手动 export DEVFLEET_DEVICE_TOKEN');
};

const preflight = async () => {
  const phase = startPhase('预检 (health + 设备 + Trae)');
  const health = await fetch(`${apiBaseUrl}/api/health`);
  if (!health.ok) throw new Error(`DevFleet API 未就绪: ${apiBaseUrl}/api/health`);

  const { devices } = await api<{ devices: Array<{
    id: string;
    name: string;
    status: string;
    devTool: string;
    capabilities?: Record<string, unknown>;
    tools: Array<{ toolName: string; status: string }>;
  }> }>('/api/devices');

  const online = devices.filter((device) => device.status === 'online');
  if (online.length === 0) {
    throw new Error('没有在线设备。请启动 DevFleet 桌面端并连接「本机设备代理」。');
  }

  const traeDevices = online.filter((device) => device.devTool === 'trae');
  if (traeDevices.length === 0) {
    throw new Error('没有在线 Trae 工作设备。请在设备管理中将 dev_tool 设为 trae。');
  }

  if (!autoTouch) {
    const headless = traeDevices.filter((device) => {
      const caps = device.capabilities as Record<string, unknown> | undefined;
      return caps?.e2e_agent === true;
    });
    if (headless.length > 0 && headless.length === traeDevices.length) {
      throw new Error(
        '当前只有 E2E 模拟代理在线（e2e-agent.mjs），无法真实打开 Trae。\n'
        + '请先停止 e2e-agent 进程，在 DevFleet 桌面端打开「本机设备代理」并连接，再重试（不要加 --auto-touch）。',
      );
    }
  }

  const targetDevice = autoTouch
    ? traeDevices[0]
    : (traeDevices.find((device) => {
      const caps = device.capabilities as Record<string, unknown> | undefined;
      return caps?.e2e_agent !== true;
    }) ?? traeDevices[0]);

  const broken = traeDevices.filter((device) => {
    const trae = device.tools.find((tool) => tool.toolName === 'trae');
    return trae?.status === 'not_installed';
  });
  if (broken.length > 0) {
    throw new Error(`Trae 未安装: ${broken.map((d) => d.name).join(', ')}`);
  }

  console.log(`在线设备: ${online.map((d) => `${d.name}(${d.devTool})`).join(', ')}`);
  if (!repoUrl.trim()) console.warn('未设置 DEVFLEET_REPO_URL，将使用 agent 本地目录（merge 可能受限）');
  if (!skipMerge && repoUrl.trim() && !mergeWorkspace) {
    throw new Error('设置了 DEVFLEET_REPO_URL 时必须提供 DEVFLEET_MERGE_WORKSPACE');
  }
  endPhase(phase);
  return targetDevice.id;
};

const dispatchTask = async (deviceId: string) => {
  const phase = startPhase('派发任务 (devfleet_dispatch_task)');
  const stamp = new Date().toISOString();
  const { task } = await api<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 最小闭环 ${stamp}`,
      prompt: `在 README.md 末尾追加一行 E2E 测试标记，内容为 timestamp=${stamp}`,
      device_id: deviceId,
      repo_url: repoUrl.trim() || undefined,
      branch: 'main',
    }),
  });
  console.log(`任务 ID: ${task.id}`);
  console.log(`子任务分支: ${task.subTasks.map((sub) => sub.branch_name).join(', ')}`);
  endPhase(phase);
  return task;
};

const waitForTask = async (taskId: string) => {
  const phase = startPhase('等待工作设备完成 (devfleet_wait_for_task)');
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const { task } = await api<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    lastStatus = task.status;
    if (['completed', 'failed', 'merged'].includes(task.status)) {
      if (task.status === 'failed') {
        const logs = task.subTasks.flatMap((sub) => sub.logs || []).map((log) => log.content);
        throw new Error(`任务失败。最近日志:\n${logs.slice(-5).join('\n')}`);
      }
      endPhase(phase);
      return task;
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`等待任务超时 (${timeoutSeconds}s)，最后状态: ${lastStatus}`);
};

const mergeTask = async (task: Task) => {
  const phase = startPhase('主设备合并 (devfleet_merge_task)');
  if (!mergeWorkspace) throw new Error('缺少 DEVFLEET_MERGE_WORKSPACE');
  if (task.status !== 'completed') throw new Error(`任务尚未 completed: ${task.status}`);

  await git(mergeWorkspace, ['rev-parse', '--is-inside-work-tree']);
  const dirty = await git(mergeWorkspace, ['status', '--porcelain']);
  if (dirty) throw new Error('merge 工作区有未提交修改');

  if (task.repo_url.trim()) {
    const origin = await git(mergeWorkspace, ['remote', 'get-url', 'origin']);
    if (!sameRepo(origin, task.repo_url)) {
      throw new Error(`merge 工作区 origin 与任务仓库不一致: ${origin} vs ${task.repo_url}`);
    }
  }

  const barePath = process.env.DEVFLEET_BARE_REPO || '/tmp/devfleet-e2e/bare.git';
  try {
    await git(mergeWorkspace, ['fetch', '--all', '--prune']);
  } catch {
    console.log('origin fetch 失败，尝试从本地 bare 仓库拉取');
  }
  await git(mergeWorkspace, ['checkout', task.branch]);
  try {
    await git(mergeWorkspace, ['pull', '--ff-only', 'origin', task.branch]);
  } catch {
    console.log('main 分支本地领先/无 upstream，继续 merge');
  }

  for (const subTask of task.subTasks) {
    const remoteRef = `origin/${subTask.branch_name}`;
    try {
      await git(mergeWorkspace, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
    } catch {
      await git(mergeWorkspace, [
        'fetch',
        barePath,
        `refs/heads/${subTask.branch_name}:refs/remotes/origin/${subTask.branch_name}`,
      ]);
    }
    try {
      await git(mergeWorkspace, ['merge', '--no-edit', remoteRef]);
    } catch (error) {
      await git(mergeWorkspace, ['merge', '--abort']).catch(() => '');
      throw error;
    }
  }

  try {
    await git(mergeWorkspace, ['push', 'origin', task.branch]);
  } catch {
    await git(mergeWorkspace, ['push', barePath, `${task.branch}:${task.branch}`]);
  }
  const commit = await git(mergeWorkspace, ['rev-parse', 'HEAD']);
  await api(`/api/tasks/${encodeURIComponent(task.id)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ merge_commit_sha: commit }),
  });
  console.log(`合并 commit: ${commit}`);
  endPhase(phase);
  return commit;
};

const main = async () => {
  flowStartedAt = Date.now();
  console.log('DevFleet 最小闭环 E2E');
  console.log(`API: ${apiBaseUrl}`);
  console.log(`模式: ${autoTouch ? 'auto-touch（跳过 Trae 人工改码）' : 'Trae 人工/Agent 改码'}`);

  if (autoTouch) {
    await ensureE2eAgent();
  }

  const deviceId = await preflight();
  const task = await dispatchTask(deviceId);

  if (autoTouch) {
    const touchPhase = startPhase('模拟 Trae 改码 (--auto-touch)');
    await autoTouchWorkspace(task.id);
    endPhase(touchPhase);
  } else {
    const dir = resolveTaskWorkspace(task.id) || '<agent 工作目录>';
    console.log('\n请在 Trae 中完成改码（Computer Use 应已打开工作区并写入任务）:');
    console.log(`  工作区: ${dir}`);
    console.log('  目标: 修改 README.md 或任意文件，以便 agent 检测到 git 变更\n');
  }

  const completedTask = await waitForTask(task.id);
  console.log(`\n任务完成: ${completedTask.status}`);

  if (!skipMerge && repoUrl.trim()) {
    await mergeTask(completedTask);
    console.log('任务已 merged');
  } else if (!skipMerge) {
    console.log('无远程仓库，跳过 merge 阶段（可设置 DEVFLEET_REPO_URL + npm run e2e:setup）');
  }

  printSummary();
};

main().catch((error) => {
  printSummary();
  console.error(`\nE2E 失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
