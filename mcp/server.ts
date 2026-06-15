#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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

const api = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  if (!token) throw new Error('缺少 DEVFLEET_TOKEN，请在 MCP 环境变量中配置登录令牌');
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `DevFleet API 请求失败 (${response.status})`);
  return body;
};

server.registerTool('devfleet_list_devices', {
  title: '列出 DevFleet 设备',
  description: '列出已绑定设备、在线状态、默认设备以及 Trae / Codex / Cursor 等编程工具的当前状态。',
}, async () => result(await api('/api/devices')));

server.registerTool('devfleet_dispatch_task', {
  title: '向多台设备派发代码任务',
  description: '把真实代码任务派发到在线工作设备。Cursor 设备由 Cursor Agent CLI 改码；Trae/Codex/Claude 由 Codex CLI 改码；各设备 push 独立 Git 分支。',
  inputSchema: {
    title: z.string().min(1).describe('任务标题'),
    description: z.string().min(1).describe('详细实现要求，建议按句子列出可并行的子任务'),
    repo_url: z.string().min(1).describe('设备可访问且有推送权限的 Git 仓库地址'),
    branch: z.string().default('main').describe('基础分支'),
  },
}, async (input) => result(await api('/api/tasks', {
  method: 'POST',
  body: JSON.stringify(input),
})));

server.registerTool('devfleet_get_task', {
  title: '查询 DevFleet 任务',
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
  const deadline = Date.now() + timeout_seconds * 1000;
  let task: Task | null = null;
  while (Date.now() < deadline) {
    task = (await api<{ task: Task }>(`/api/tasks/${encodeURIComponent(task_id)}`)).task;
    if (['completed', 'failed', 'merged'].includes(task.status)) return result(task);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`等待任务超时。最后状态: ${task?.status || 'unknown'}`);
});

server.registerTool('devfleet_merge_task', {
  title: '在主设备真实合并多设备分支',
  description: '在主设备本地仓库 fetch 并合并所有已完成子任务分支，然后推送基础分支；成功后才把 DevFleet 任务标记为已合并。',
  inputSchema: {
    task_id: z.string().min(1),
    workspace_path: z.string().min(1).describe('主设备上该 Git 仓库的绝对路径'),
    push: z.boolean().default(true).describe('是否把合并后的基础分支推送到 origin'),
  },
}, async ({ task_id, workspace_path, push }) => {
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
  return result({ success: true, task_id, branch: task.branch, commit, merged_branches: task.subTasks.map((item) => item.branch_name), pushed: push });
});

const git = async (cwd: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout || stderr;
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} 失败: ${detail.stderr || detail.message || '未知错误'}`);
  }
};

const normalizeRepo = (value: string) => value.trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/\/$/, '').toLowerCase();

const transport = new StdioServerTransport();
await server.connect(transport);
