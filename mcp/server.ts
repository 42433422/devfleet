#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createApiClient } from './api-client.js';
import { startTraeTaskWithComputerUse, openTraeWorkspace, submitTraeNewTask } from './computer-use.js';

const execFileAsync = promisify(execFile);
const apiBaseUrl = (process.env.DEVFLEET_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.DEVFLEET_TOKEN || '';

interface SubTask {
  id: string;
  device_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  branch_name: string;
  progress: number;
}

interface DeviceTool {
  toolName: 'codex' | 'trae' | 'cursor' | 'claude_code';
  status: 'running' | 'idle' | 'not_installed';
  currentTask?: string;
}

interface Device {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'connecting';
  devTool: 'codex' | 'trae' | 'cursor' | 'claude_code';
  tools: DeviceTool[];
}

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'merged';
  repo_url: string;
  branch: string;
  subTasks: SubTask[];
}

const server = new McpServer({ name: 'devfleet', version: '1.0.0' });

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const apiClient = createApiClient({ apiBaseUrl, token });
const api = <T>(
  path: string,
  options: RequestInit & { allowGuestRefresh?: boolean } = {},
): Promise<T> => apiClient.request<T>(path, options);

server.registerTool('devfleet_list_devices', {
  title: '列出排比 Para 设备',
  description: '列出已绑定设备、在线状态、默认设备以及 Trae / Codex / Cursor 等编程工具的当前状态。',
}, async () => result(await api('/api/devices')));

server.registerTool('devfleet_next_task', {
  title: '获取当前设备的待执行任务',
  description: 'Trae Agent 调用此工具获取排比 Para 派发给本设备的任务。返回任务标题、描述、工作分支等信息；无任务时返回 null。',
}, async () => {
  const body = await api<{ task?: Record<string, unknown> | null }>(
    '/api/devices/me/pending-task',
    { allowGuestRefresh: false },
  );
  return result(body.task);
});

server.registerTool('devfleet_report_task_progress', {
  title: '回写当前设备任务进度',
  description: 'Trae Agent 完成阶段性代码修改后调用：向排比 Para 回写日志和进度。最终完成仍由本机代理检测 Git 变更、提交并推送后确认。',
  inputSchema: {
    task_id: z.string().min(1).describe('devfleet_next_task 返回的任务 ID'),
    subtask_id: z.string().min(1).describe('devfleet_next_task 返回的子任务 ID'),
    progress: z.number().int().min(0).max(85).default(80).describe('阶段进度；Trae 阶段最高 85，最终完成由本机代理确认'),
    status: z.enum(['running', 'failed']).default('running').describe('Trae 阶段状态；代码已改好时仍使用 running'),
    content: z.string().min(1).describe('写给主控端看的简短进展、失败原因或验证结果'),
    level: z.enum(['info', 'warn', 'error', 'debug']).default('info').describe('日志级别'),
  },
}, async (input) => {
  const body = await api<Record<string, unknown>>('/api/devices/me/task-report', {
    method: 'POST',
    body: JSON.stringify(input),
    allowGuestRefresh: false,
  });
  return result(body);
});

server.registerTool('devfleet_computer_use_open_trae_workspace', {
  title: '本机 Computer Use 打开 Trae 工作区',
  description: '仅打开指定 Trae 工作区（trae-cn -r 复用已有实例），不提交 prompt。可与 devfleet_computer_use_submit_trae_task 分步调用。',
  inputSchema: {
    workspace_path: z.string().min(1).describe('Trae 要打开的本机工作区绝对路径'),
  },
}, async ({ workspace_path }) => {
  await openTraeWorkspace(workspace_path);
  return result({ success: true, workspace_path, phase: 'open' });
});

server.registerTool('devfleet_computer_use_submit_trae_task', {
  title: '本机 Computer Use 向已打开 Trae 工作区提交新任务',
  description: '等待工作区窗口就绪后，在对应 Trae 窗口点击新任务并粘贴 prompt。需工作区已通过 open 或 start 打开。',
  inputSchema: {
    workspace_path: z.string().min(1).describe('已打开的 Trae 工作区绝对路径'),
    prompt: z.string().min(1).describe('写入 Trae 新任务输入框的任务内容'),
  },
}, async ({ workspace_path, prompt }) => {
  await submitTraeNewTask(workspace_path, prompt);
  return result({ success: true, workspace_path, phase: 'submit' });
});

server.registerTool('devfleet_computer_use_start_trae_task', {
  title: '本机 Computer Use 控制 Trae 新任务',
  description: '一次调用完成：在已有 Trae 实例中打开工作区 → 等待窗口 → 新任务 → 粘贴 prompt。不要与 open/submit 混用。',
  inputSchema: {
    workspace_path: z.string().min(1).describe('Trae 要打开的本机工作区绝对路径'),
    prompt: z.string().min(1).describe('写入 Trae 新任务输入框的任务内容'),
  },
}, async ({ workspace_path, prompt }) => {
  await startTraeTaskWithComputerUse(workspace_path, prompt);
  return result({ success: true, workspace_path });
});

server.registerTool('devfleet_dispatch_task', {
  title: '向指定设备派发一个子任务',
  description: '每次调用只创建一个子任务：AI 自行决定内容、目标设备和依赖。首次调用创建任务并派发；后续调用传 task_id 向同一任务追加子任务。后端不拆分任务。',
  inputSchema: {
    title: z.string().min(1).describe('子任务标题（首次调用时亦作为任务标题）'),
    prompt: z.string().min(1).describe('该子任务的具体实现要求，写入工作设备 Agent'),
    device_id: z.string().min(1).describe('目标工作设备 ID（devfleet_list_devices 返回）'),
    task_id: z.string().optional().describe('已有任务 ID；省略则创建新任务'),
    repo_url: z.string().optional().describe('Git 仓库地址（首次创建任务时必填或留空用本地目录）'),
    branch: z.string().default('main').describe('基础分支（首次创建任务时使用）'),
    subtask_title: z.string().optional().describe('子任务标题；默认与 title 相同'),
    depends_on: z.array(z.string()).optional().describe('前置子任务 ID 列表，由 AI 指定依赖顺序'),
  },
}, async (input) => result(await api('/api/tasks', {
  method: 'POST',
  body: JSON.stringify(input),
})));

server.registerTool('devfleet_call_remote_codex', {
  title: '调用远端设备 Codex CLI 完成任务',
  description: '主设备 AI 的一键远端 Codex 入口：确认目标设备在线，将目标设备开发工具切到 codex，派发 prompt 到该设备本地 Codex CLI，等待完成，并可选在主设备合并分支。',
  inputSchema: {
    device_id: z.string().min(1).describe('目标工作设备 ID（通常是 Win32，来自 devfleet_list_devices）'),
    prompt: z.string().min(1).describe('要交给远端 Codex CLI 执行的任务要求'),
    title: z.string().default('远端 Codex 任务').describe('任务标题'),
    repo_url: z.string().optional().describe('Git 仓库地址；留空则使用工作设备本地目录'),
    branch: z.string().default('main').describe('基础分支'),
    wait: z.boolean().default(true).describe('是否等待远端 Codex 子任务完成'),
    timeout_seconds: z.number().int().min(5).max(3600).default(900).describe('等待远端任务完成的超时时间'),
    merge: z.boolean().default(false).describe('完成后是否在主设备本地仓库合并远端分支'),
    workspace_path: z.string().optional().describe('merge=true 时主设备本地仓库绝对路径'),
    push: z.boolean().default(true).describe('merge=true 时是否推送基础分支'),
  },
}, async (input) => {
  const device = await ensureRemoteCodexDevice(input.device_id);
  const dispatch = await api<{ task: Task; subtask?: SubTask }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title || '远端 Codex 任务',
      prompt: input.prompt,
      device_id: input.device_id,
      repo_url: input.repo_url,
      branch: input.branch || 'main',
    }),
  });

  let finalTask = dispatch.task;
  if (input.wait) {
    finalTask = await waitForTask(dispatch.task.id, input.timeout_seconds || 900);
  }

  const mergeResult = input.merge
    ? await mergeTaskBranches(dispatch.task.id, input.workspace_path || '', input.push ?? true)
    : null;

  return result({
    success: input.wait ? ['completed', 'merged'].includes(finalTask.status) : true,
    device: {
      id: device.id,
      name: device.name,
      devTool: 'codex',
    },
    task: finalTask,
    subtask: dispatch.subtask,
    merge: mergeResult,
  });
});

server.registerTool('devfleet_get_task', {
  title: '查询排比 Para 任务',
  description: '查询任务、各设备子任务、进度、分支和日志。',
  inputSchema: { task_id: z.string().min(1) },
}, async ({ task_id }) => result(await api(`/api/tasks/${encodeURIComponent(task_id)}`)));

server.registerTool('devfleet_wait_for_task', {
  title: '等待多设备任务完成',
  description: '轮询等待任务完成或失败，适合 Trae Agent 派发后继续自动整合。',
  inputSchema: {
    task_id: z.string().min(1),
    timeout_seconds: z.number().int().min(5).max(3600).default(900),
  },
}, async ({ task_id, timeout_seconds }) => {
  return result(await waitForTask(task_id, timeout_seconds));
});

server.registerTool('devfleet_merge_task', {
  title: '在主设备真实合并多设备分支',
  description: '在主设备本地仓库 fetch 并合并所有已完成子任务分支，然后推送基础分支；成功后才把排比 Para 任务标记为已合并。',
  inputSchema: {
    task_id: z.string().min(1),
    workspace_path: z.string().min(1).describe('主设备上该 Git 仓库的绝对路径'),
    push: z.boolean().default(true).describe('是否把合并后的基础分支推送到 origin'),
  },
}, async ({ task_id, workspace_path, push }) => {
  return result(await mergeTaskBranches(task_id, workspace_path, push));
});

async function waitForTask(taskId: string, timeoutSeconds: number): Promise<Task> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let task: Task | null = null;
  while (Date.now() < deadline) {
    task = (await api<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
    if (['completed', 'failed', 'merged'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`等待任务超时。最后状态: ${task?.status || 'unknown'}`);
}

async function ensureRemoteCodexDevice(deviceId: string): Promise<Device> {
  const body = await api<{ devices: Device[] }>('/api/devices');
  const device = body.devices.find((item) => item.id === deviceId);
  if (!device) throw new Error(`目标设备不存在: ${deviceId}`);
  if (device.status !== 'online') throw new Error(`目标设备未在线: ${device.name}`);
  const codex = device.tools.find((tool) => tool.toolName === 'codex');
  if (!codex || codex.status === 'not_installed') {
    throw new Error(`目标设备 ${device.name} 未安装或未登录 Codex CLI`);
  }
  if (device.devTool !== 'codex') {
    const updated = await api<{ device: Device }>(`/api/devices/${encodeURIComponent(deviceId)}/dev-tool`, {
      method: 'PUT',
      body: JSON.stringify({ devTool: 'codex' }),
    });
    return updated.device;
  }
  return device;
}

async function mergeTaskBranches(task_id: string, workspace_path: string, push: boolean) {
  if (!workspace_path.trim()) throw new Error('merge=true 时必须提供 workspace_path');
  const task = (await api<{ task: Task }>(`/api/tasks/${encodeURIComponent(task_id)}`)).task;
  if (task.status !== 'completed') throw new Error(`任务尚未全部完成，当前状态: ${task.status}`);
  if (task.subTasks.some((subTask) => subTask.status !== 'completed')) throw new Error('仍有子任务未完成');

  await git(workspace_path, ['rev-parse', '--is-inside-work-tree']);
  const dirty = await git(workspace_path, ['status', '--porcelain']);
  if (dirty.trim()) throw new Error('主设备工作区存在未提交修改，请先提交或暂存后再合并');
  const origin = (await git(workspace_path, ['remote', 'get-url', 'origin'])).trim();
  if (normalizeRepo(origin) !== normalizeRepo(task.repo_url)) {
    throw new Error(`工作区 origin 与任务仓库不一致。origin=${origin}, task=${task.repo_url}`);
  }
  await git(workspace_path, ['fetch', '--all', '--prune']);
  await git(workspace_path, ['checkout', task.branch]);
  await git(workspace_path, ['pull', '--ff-only', 'origin', task.branch]);
  for (const subTask of task.subTasks) {
    try {
      await git(workspace_path, ['merge', '--no-edit', `origin/${subTask.branch_name}`]);
    } catch (error) {
      await git(workspace_path, ['merge', '--abort']).catch(() => '');
      throw error;
    }
  }
  if (push) await git(workspace_path, ['push', 'origin', task.branch]);
  const commit = (await git(workspace_path, ['rev-parse', 'HEAD'])).trim();
  await api(`/api/tasks/${encodeURIComponent(task_id)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ merge_commit_sha: commit }),
  });
  return { success: true, task_id, branch: task.branch, commit, merged_branches: task.subTasks.map((item) => item.branch_name), pushed: push };
}

const git = async (cwd: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout || stderr;
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} 失败: ${detail.stderr || detail.message || '未知错误'}`);
  }
};

const normalizeRepo = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutFileScheme = trimmed.startsWith('file://')
    ? trimmed.replace(/^file:\/\//i, '')
    : trimmed;
  return withoutFileScheme
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\/$/, '')
    .toLowerCase();
};

const transport = new StdioServerTransport();
await server.connect(transport);
