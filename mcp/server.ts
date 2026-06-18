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
  linkHealth?: { healthy: boolean; reason: string; lastReason?: string };
  devTool: 'codex' | 'trae' | 'cursor' | 'claude_code';
  tools: DeviceTool[];
}

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'merge_conflict' | 'merged';
  repo_url: string;
  branch: string;
  subTasks: SubTask[];
}

interface CollabMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  sub_task_id?: string;
}

interface CollabSession {
  id: string;
  title: string;
  status: 'open' | 'paused' | 'closed';
  device_id: string;
  device_name?: string;
  device_status: 'online' | 'offline' | 'connecting';
  task_id: string;
  task_status?: Task['status'];
  repo_url: string;
  branch: string;
  turn_count?: number;
  queued_count?: number;
  running_count?: number;
  active_message_id?: string;
  context_summary?: string;
  messages: CollabMessage[];
}

interface RemoteCommand {
  id: string;
  device_id: string;
  title: string;
  shell: 'powershell' | 'cmd' | 'sh' | 'bash';
  status: 'pending' | 'running' | 'completed' | 'failed';
  timeout_seconds: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  logs?: Array<{ timestamp: string; level: string; content: string }>;
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

server.registerTool('devfleet_run_remote_command', {
  title: '在远端设备执行受控命令',
  description: '高级控制入口：主设备 AI 直接让在线工作设备的本机 Agent 执行 PowerShell/cmd/sh/bash 脚本，并返回日志、退出码、stdout/stderr。适合安装新版软件、检查端口、读取日志、启动 CLI；不经过 Codex 改码任务队列。',
  inputSchema: {
    device_id: z.string().min(1).describe('目标工作设备 ID（来自 devfleet_list_devices）'),
    script: z.string().min(1).describe('要在目标设备执行的脚本内容'),
    title: z.string().default('远程命令').describe('命令标题，显示在排比 Para 日志中'),
    shell: z.enum(['powershell', 'cmd', 'sh', 'bash']).optional().describe('执行 shell；Windows 默认 powershell，Unix 默认 sh'),
    cwd: z.string().optional().describe('目标设备上的工作目录绝对路径；省略则使用 Agent 默认工作目录'),
    timeout_seconds: z.number().int().min(5).max(1800).default(300).describe('设备本地执行超时；Agent 会软/硬超时杀进程'),
    wait: z.boolean().default(true).describe('是否等待命令完成并返回最终 stdout/stderr'),
    wait_timeout_seconds: z.number().int().min(5).max(3600).default(900).describe('wait=true 时 MCP 侧等待结果的最长时间'),
  },
}, async (input) => {
  const command = (await api<{ command: RemoteCommand }>(
    `/api/devices/${encodeURIComponent(input.device_id)}/commands`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title || '远程命令',
        shell: input.shell,
        script: input.script,
        cwd: input.cwd,
        timeout_seconds: input.timeout_seconds || 300,
        dangerous: true,
      }),
    },
  )).command;

  if (!input.wait) {
    return result({ success: true, command });
  }

  const finalCommand = await waitForRemoteCommand(
    input.device_id,
    command.id,
    input.wait_timeout_seconds || Math.max((input.timeout_seconds || 300) + 30, 60),
  );
  return result({
    success: finalCommand.status === 'completed',
    command: finalCommand,
  });
});

server.registerTool('devfleet_start_collab_session', {
  title: '创建远端 Codex 持续协作会话',
  description: '在指定工作设备上创建一个持续协作会话。后续 devfleet_send_collab_message 会带会话历史派发给同一台设备 Codex。',
  inputSchema: {
    device_id: z.string().min(1).describe('目标工作设备 ID（通常是 Win32，来自 devfleet_list_devices）'),
    title: z.string().default('远端 Codex 协作').describe('会话标题'),
    repo_url: z.string().optional().describe('Git 仓库地址；留空则使用工作设备本地目录'),
    branch: z.string().default('main').describe('基础分支'),
  },
}, async (input) => result(await api('/api/collab/sessions', {
  method: 'POST',
  body: JSON.stringify(input),
})));

server.registerTool('devfleet_list_collab_sessions', {
  title: '列出远端 Codex 协作会话',
  description: '列出当前用户的远端 Codex 协作会话，包含目标设备在线状态、任务状态、排队/运行轮次和最近上下文摘要。',
}, async () => result(await api('/api/collab/sessions')));

server.registerTool('devfleet_get_collab_session', {
  title: '读取远端 Codex 协作会话',
  description: '读取一个远端 Codex 协作会话的完整消息历史。主设备 AI 重启或断线后应先调用它恢复上下文，再继续发送消息。',
  inputSchema: {
    session_id: z.string().min(1).describe('devfleet_start_collab_session 返回的会话 ID'),
  },
}, async ({ session_id }) => result(await api(
  `/api/collab/sessions/${encodeURIComponent(session_id)}`,
)));

server.registerTool('devfleet_send_collab_message', {
  title: '向远端 Codex 协作会话发送消息',
  description: '把一条带上下文的消息发送到远端 Codex 会话。设备离线时消息会排队；设备在线时会作为顺序子任务派发。',
  inputSchema: {
    session_id: z.string().min(1).describe('devfleet_start_collab_session 返回的会话 ID'),
    content: z.string().min(1).describe('要交给远端 Codex 的本轮消息/任务'),
    wait: z.boolean().default(true).describe('是否等待本轮远端消息完成或失败'),
    timeout_seconds: z.number().int().min(5).max(3600).default(900).describe('等待本轮消息完成的超时时间'),
  },
}, async (input) => {
  const body = await api<{ session: CollabSession; message: CollabMessage }>('/api/collab/sessions/'
    + encodeURIComponent(input.session_id)
    + '/messages', {
    method: 'POST',
    body: JSON.stringify({ content: input.content }),
  });
  if (!input.wait) return result(body);
  const session = await waitForCollabMessage(input.session_id, body.message.id, input.timeout_seconds || 900);
  return result({ session, message_id: body.message.id });
});

server.registerTool('devfleet_wait_collab_message', {
  title: '等待远端 Codex 协作消息完成',
  description: '等待指定会话中的某一轮消息完成或失败。用于 send wait=false 后异步恢复，也用于主设备 AI 断线重连后继续等待远端 Codex。',
  inputSchema: {
    session_id: z.string().min(1).describe('协作会话 ID'),
    message_id: z.string().min(1).describe('devfleet_send_collab_message 返回的消息 ID'),
    timeout_seconds: z.number().int().min(5).max(3600).default(900).describe('等待本轮消息完成的超时时间'),
  },
}, async ({ session_id, message_id, timeout_seconds }) => {
  const session = await waitForCollabMessage(session_id, message_id, timeout_seconds || 900);
  return result({ session, message_id });
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

async function waitForRemoteCommand(
  deviceId: string,
  commandId: string,
  timeoutSeconds: number,
): Promise<RemoteCommand> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let command: RemoteCommand | null = null;
  while (Date.now() < deadline) {
    command = (await api<{ command: RemoteCommand }>(
      `/api/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}`,
    )).command;
    if (['completed', 'failed'].includes(command.status)) return command;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待远程命令超时。最后状态: ${command?.status || 'unknown'}`);
}

async function waitForCollabMessage(sessionId: string, messageId: string, timeoutSeconds: number): Promise<CollabSession> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let session: CollabSession | null = null;
  while (Date.now() < deadline) {
    session = (await api<{ session: CollabSession }>(
      `/api/collab/sessions/${encodeURIComponent(sessionId)}`,
    )).session;
    const message = session.messages.find((item) => item.id === messageId);
    if (message && ['completed', 'failed'].includes(message.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`等待远端协作消息超时。最后状态: ${session?.messages.find((item) => item.id === messageId)?.status || 'unknown'}`);
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
      const status = await git(workspace_path, ['status', '--porcelain']).catch((statusError) =>
        `无法读取冲突状态: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
      const conflicts = parseConflictFiles(status);
      await git(workspace_path, ['merge', '--abort']).catch(() => '');
      const detail = error instanceof Error ? error.message : String(error);
      const conflictText = conflicts.length > 0 ? conflicts.join(', ') : '未能解析冲突文件';
      await api(`/api/tasks/${encodeURIComponent(task_id)}/merge-conflict`, {
        method: 'POST',
        body: JSON.stringify({
          subtask_id: subTask.id,
          branch_name: subTask.branch_name,
          conflict_files: conflicts,
          detail,
          source: 'mcp',
          workspace_path,
        }),
      }).catch(() => undefined);
      throw new Error(`合并 ${subTask.branch_name} 失败，已 abort。冲突文件: ${conflictText}\n${detail}`);
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

function parseConflictFiles(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim())
    .filter((line) => {
      const code = line.slice(0, 2);
      return code.includes('U') || code === 'AA' || code === 'DD';
    })
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

const transport = new StdioServerTransport();
await server.connect(transport);
