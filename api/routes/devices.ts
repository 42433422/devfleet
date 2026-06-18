import { Router, type Request, type Response } from 'express';
import { db, type RemoteCommand, type SubTask } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { genBindCode, genDeviceToken, normalizeDevTool, type DevTool } from '../lib/utils.js';
import {
  broadcast,
  disconnectDeviceSocket,
  getDeviceLinkHealth,
  hasDevice,
  reconcileRemoteCommandTimeout,
  reconcileRemoteCommandTimeoutsForDevice,
  sendBindingIdentity,
  sendBindingIdentityToUser,
  sendRemoteCommandToDevice,
} from '../websocket/manager.js';
import { parseCapabilities } from '../lib/capabilities.js';
import { reconcileTask, dispatchReadySubs, handleSubTaskFailure } from '../lib/dispatch.js';
import { syncCollabMessageForSubtask } from '../lib/collab.js';
import { createHash } from 'node:crypto';

const router = Router();
const REMOTE_COMMAND_SHELLS: RemoteCommand['shell'][] = ['powershell', 'cmd', 'sh', 'bash'];
const MAX_REMOTE_SCRIPT_CHARS = 20_000;
const MIN_REMOTE_TIMEOUT_SECONDS = 5;
const MAX_REMOTE_TIMEOUT_SECONDS = 1_800;

interface ToolItem {
  tool_name: 'codex' | 'trae' | 'cursor' | 'claude_code';
  status: 'running' | 'idle' | 'not_installed';
  current_task?: string;
}

function serializeDevice(deviceId: string) {
  const dev = db.devices.findById(deviceId);
  if (!dev) return null;
  const tools = db.tools.findAllByDeviceId(deviceId).map((t) => ({
    toolName: t.tool_name,
    status: t.status,
    currentTask: t.current_task,
  }));
  const all: ToolItem['tool_name'][] = ['codex', 'trae', 'cursor', 'claude_code'];
  const toolMap = new Map(tools.map((t) => [t.toolName, t]));
  const finalTools = all.map((name) => toolMap.get(name) || { toolName: name, status: 'not_installed' });
  const capabilities = parseCapabilities(dev.capabilities);
  const linkHealth = getDeviceLinkHealth(dev.id);
  return {
    id: dev.id,
    name: dev.name,
    status: hasDevice(dev.id) ? 'online' : dev.status === 'connecting' ? 'connecting' : 'offline',
    linkHealth,
    devTool: normalizeDevTool(dev.dev_tool),
    tools: finalTools,
    capabilities,
    lastSeen: dev.last_seen,
    bindCode: dev.bind_code,
    activated: dev.activated !== false,
    isPrimary: Boolean(dev.is_primary),
  };
}

function serializeRemoteCommand(command: RemoteCommand) {
  return {
    id: command.id,
    user_id: command.user_id,
    device_id: command.device_id,
    title: command.title,
    shell: command.shell,
    script: command.script,
    cwd: command.cwd,
    status: command.status,
    timeout_seconds: command.timeout_seconds,
    exit_code: command.exit_code,
    stdout: command.stdout,
    stderr: command.stderr,
    error: command.error,
    logs: command.logs,
    created_at: command.created_at,
    started_at: command.started_at,
    completed_at: command.completed_at,
    updated_at: command.updated_at,
  };
}

function defaultRemoteShell(deviceId: string): RemoteCommand['shell'] {
  const device = db.devices.findById(deviceId);
  const caps = parseCapabilities(device?.capabilities);
  return caps?.platform === 'windows' ? 'powershell' : 'sh';
}

function clampRemoteTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300;
  return Math.max(MIN_REMOTE_TIMEOUT_SECONDS, Math.min(MAX_REMOTE_TIMEOUT_SECONDS, Math.floor(parsed)));
}

router.post('/activate', async (req: Request, res: Response): Promise<void> => {
  const { bindCode, deviceName } = (req.body || {}) as {
    bindCode?: string;
    deviceName?: string;
  };
  if (!bindCode) {
    res.status(400).json({ error: '绑定码不能为空' });
    return;
  }
  const device = db.devices.findByBindCode(bindCode.trim().toUpperCase());
  if (!device) {
    res.status(404).json({ error: '无效或已失效的绑定码' });
    return;
  }
  if (!device.bind_code_expires_at || new Date(device.bind_code_expires_at).getTime() < Date.now()) {
    db.devices.update(device.id, { bind_code: undefined, bind_code_expires_at: undefined });
    res.status(410).json({ error: '绑定码已过期，请在主设备重新生成' });
    return;
  }
  const deviceToken = genDeviceToken();
  const updated = db.devices.update(device.id, {
    status: 'offline',
    activated: true,
    connection_allowed: true,
    device_token_hash: createHash('sha256').update(deviceToken).digest('hex'),
    bind_code: undefined,
    bind_code_expires_at: undefined,
    ...(deviceName?.trim() ? { name: deviceName.trim() } : {}),
  });
  if (db.devices.findAllByUserId(device.user_id).every((item) => !item.is_primary)) {
    db.devices.setPrimary(device.user_id, device.id);
  }
  broadcast(device.user_id, { type: 'device_status', device_id: device.id, status: 'offline' });
  const owner = db.users.findById(device.user_id);
  const primaryDevice = db.devices.findAllByUserId(device.user_id).find((item) => item.is_primary);
  res.status(200).json({
    success: true,
    device: serializeDevice(updated!.id),
    deviceToken,
    controller: {
      id: device.user_id,
      email: owner?.email || '未知账号',
      primaryDevice: primaryDevice ? { id: primaryDevice.id, name: primaryDevice.name } : null,
    },
  });
});

router.post('/deactivate', async (req: Request, res: Response): Promise<void> => {
  const { deviceToken } = (req.body || {}) as { deviceToken?: string };
  if (!deviceToken) {
    res.status(400).json({ error: '设备令牌不能为空' });
    return;
  }
  const device = db.devices.findByDeviceToken(deviceToken);
  if (!device) {
    res.status(404).json({ error: '设备不存在或已解除绑定' });
    return;
  }
  disconnectDeviceSocket(device.id, '设备已解除绑定');
  db.devices.update(device.id, { status: 'offline', activated: false, is_primary: false, device_token_hash: undefined });
  broadcast(device.user_id, { type: 'device_status', device_id: device.id, status: 'offline' });
  sendBindingIdentityToUser(device.user_id);
  res.status(200).json({ success: true });
});

router.get('/me/pending-task', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: '缺少设备令牌' });
    return;
  }
  const device = db.devices.findByDeviceToken(token);
  if (!device) {
    res.status(404).json({ error: '设备不存在或已解除绑定' });
    return;
  }
  const runningSubs = db.subTasks.findAllByDeviceId(device.id).filter((sub) => sub.status === 'running');
  if (runningSubs.length === 0) {
    res.status(200).json({ task: null });
    return;
  }
  const sub = runningSubs[0];
  const task = db.tasks.findById(sub.task_id);
  if (!task) {
    res.status(200).json({ task: null });
    return;
  }
  res.status(200).json({
    task: {
      id: task.id,
      subtask_id: sub.id,
      title: task.title,
      description: task.description,
      repo_url: task.repo_url,
      base_branch: task.branch,
      work_branch: sub.branch_name,
      tool: sub.tool_name,
    },
  });
});

router.post('/me/task-report', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: '缺少设备令牌' });
    return;
  }
  const device = db.devices.findByDeviceToken(token);
  if (!device) {
    res.status(404).json({ error: '设备不存在或已解除绑定' });
    return;
  }

  const body = (req.body || {}) as {
    task_id?: string;
    subtask_id?: string;
    progress?: number;
    status?: SubTask['status'];
    content?: string;
    level?: 'info' | 'warn' | 'error' | 'debug';
  };
  const taskId = (body.task_id || '').trim();
  const subtaskId = (body.subtask_id || '').trim();
  const content = (body.content || '').trim();
  if (!taskId || !subtaskId || !content) {
    res.status(400).json({ error: 'task_id、subtask_id、content 不能为空' });
    return;
  }

  const task = db.tasks.findById(taskId);
  if (!task || task.user_id !== device.user_id) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const sub = db.subTasks.findById(subtaskId);
  if (!sub || sub.task_id !== taskId || sub.device_id !== device.id) {
    res.status(404).json({ error: '子任务不存在或不属于当前设备' });
    return;
  }

  const validStatuses: SubTask['status'][] = ['pending', 'running', 'completed', 'failed'];
  const patch: Partial<SubTask> = {};
  if (typeof body.progress === 'number') {
    patch.progress = Math.max(0, Math.min(100, body.progress));
  }
  if (body.status && validStatuses.includes(body.status)) {
    patch.status = body.status;
    if (body.status === 'completed') {
      patch.completed_at = new Date().toISOString();
    }
  }
  const updated = db.subTasks.update(subtaskId, patch);
  if (!updated) {
    res.status(500).json({ error: '更新子任务失败' });
    return;
  }

  const log = db.logs.create({
    sub_task_id: subtaskId,
    content,
    level: body.level || 'info',
    device_id: device.id,
    task_id: taskId,
  });
  broadcast(device.user_id, {
    type: 'task_log',
    task_id: taskId,
    subtask_id: subtaskId,
    device_id: device.id,
    device_name: device.name,
    log,
  });
  broadcast(device.user_id, {
    type: 'task_progress',
    task_id: taskId,
    subtask_id: subtaskId,
    progress: updated.progress,
    status: updated.status,
  });

  let finalSubTask = updated;
  if (body.status === 'completed' || body.status === 'failed') {
    db.tools.upsert(device.id, updated.tool_name, { status: 'idle', current_task: undefined });
  }
  if (body.status === 'failed') {
    finalSubTask = handleSubTaskFailure(device.user_id, taskId, subtaskId, content) || updated;
  } else if (body.status === 'completed') {
    dispatchReadySubs(device.user_id, taskId);
  }
  const collab = syncCollabMessageForSubtask(subtaskId, finalSubTask.status, content);
  if (collab) {
    broadcast(device.user_id, {
      type: 'collab_message',
      session_id: collab.session.id,
      message: collab.assistantMessage || collab.userMessage,
    });
  }

  reconcileTask(device.user_id, taskId);
  const updatedTask = db.tasks.findById(taskId);
  res.status(200).json({
    success: true,
    subTask: serializeSubTask(updated),
    task: updatedTask ? {
      id: updatedTask.id,
      title: updatedTask.title,
      status: updatedTask.status,
      subTasks: db.subTasks.findAllByTaskId(taskId).map(serializeSubTask),
    } : null,
  });
});

function serializeSubTask(sub: SubTask) {
  return {
    id: sub.id,
    task_id: sub.task_id,
    device_id: sub.device_id,
    tool_name: sub.tool_name,
    status: sub.status,
    branch_name: sub.branch_name,
    progress: sub.progress,
    title: sub.title,
    depends_on: sub.depends_on ?? [],
    attempt_count: sub.attempt_count ?? 0,
    last_error: sub.last_error,
    created_at: sub.created_at,
    completed_at: sub.completed_at,
  };
}

router.use(authMiddleware);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const devices = db.devices.findAllByUserId(userId);
  const list = devices.map((d) => serializeDevice(d.id)).filter(Boolean);
  res.status(200).json({ devices: list });
});

router.post('/bind', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { name } = (req.body || {}) as { name?: string };
  const deviceName = (name || '新设备').toString().trim() || '新设备';
  try {
    const device = db.devices.create({
      user_id: userId,
      name: deviceName,
      bind_code: genBindCode(),
      bind_code_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      status: 'offline',
      activated: false,
      dev_tool: 'trae',
    });
    res.status(200).json({ bindCode: device.bind_code, deviceId: device.id, expiresAt: device.bind_code_expires_at });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建设备失败';
    res.status(500).json({ error: message });
  }
});

router.post('/:id/connect', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  const nextStatus = hasDevice(id) ? 'online' : 'connecting';
  db.devices.update(id, { status: nextStatus, connection_allowed: true });
  broadcast(userId, { type: 'device_status', device_id: id, status: nextStatus });
  res.status(200).json({ success: true, device: serializeDevice(id) });
});

router.post('/:id/disconnect', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  disconnectDeviceSocket(id, '主设备已断开连接');
  db.devices.update(id, { status: 'offline', connection_allowed: false });
  broadcast(userId, { type: 'device_status', device_id: id, status: 'offline' });
  res.status(200).json({ success: true, device: serializeDevice(id) });
});

router.put('/:id/dev-tool', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  const { devTool } = (req.body || {}) as { devTool?: DevTool };
  if (!devTool || !['codex', 'trae', 'cursor', 'claude_code'].includes(devTool)) {
    res.status(400).json({ error: 'devTool 必须是 codex、trae、cursor 或 claude_code' });
    return;
  }
  db.devices.update(id, { dev_tool: devTool });
  sendBindingIdentity(id);
  broadcast(userId, { type: 'device_dev_tool', device_id: id, devTool });
  res.status(200).json({ success: true, device: serializeDevice(id) });
});

router.put('/:id/tools', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  const { tools } = (req.body || {}) as { tools?: ToolItem[] };
  if (!Array.isArray(tools)) {
    res.status(400).json({ error: 'tools 必须是数组' });
    return;
  }
  db.tools.bulkUpsert(id, tools);
  broadcast(userId, {
    type: 'device_status',
    device_id: id,
    status: dev.status,
    tools: tools.map((t) => ({ toolName: t.tool_name, status: t.status, currentTask: t.current_task })),
  });
  res.status(200).json({ success: true, device: serializeDevice(id) });
});

router.get('/:id/commands', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  reconcileRemoteCommandTimeoutsForDevice(id);
  const commands = db.remoteCommands.findAllByDeviceId(id, limit)
    .filter((command) => command.user_id === userId)
    .map(serializeRemoteCommand);
  res.status(200).json({ commands });
});

router.get('/:id/commands/:commandId', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id, commandId } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  const command = db.remoteCommands.findById(commandId);
  if (!command || command.user_id !== userId || command.device_id !== id) {
    res.status(404).json({ error: '远程命令不存在' });
    return;
  }
  res.status(200).json({ command: serializeRemoteCommand(reconcileRemoteCommandTimeout(command)) });
});

router.post('/:id/commands', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  if (!hasDevice(id)) {
    res.status(409).json({ error: '设备未在线，远程命令未下发' });
    return;
  }

  const body = (req.body || {}) as {
    title?: string;
    shell?: RemoteCommand['shell'];
    script?: string;
    cwd?: string;
    timeout_seconds?: number;
    dangerous?: boolean;
  };
  if (body.dangerous !== true) {
    res.status(400).json({ error: '远程命令需要 dangerous=true 显式确认' });
    return;
  }
  const script = typeof body.script === 'string' ? body.script.trim() : '';
  if (!script) {
    res.status(400).json({ error: 'script 不能为空' });
    return;
  }
  if (script.length > MAX_REMOTE_SCRIPT_CHARS) {
    res.status(400).json({ error: `script 不能超过 ${MAX_REMOTE_SCRIPT_CHARS} 字符` });
    return;
  }
  const shell = body.shell && REMOTE_COMMAND_SHELLS.includes(body.shell)
    ? body.shell
    : defaultRemoteShell(id);
  const command = db.remoteCommands.create({
    user_id: userId,
    device_id: id,
    title: (body.title || '远程命令').trim().slice(0, 120) || '远程命令',
    shell,
    script,
    cwd: body.cwd?.trim() || undefined,
    timeout_seconds: clampRemoteTimeout(body.timeout_seconds),
  });
  db.remoteCommands.appendLog(command.id, {
    level: 'info',
    content: `已下发远程命令：${command.title}`,
  });
  const dispatched = sendRemoteCommandToDevice(db.remoteCommands.findById(command.id) || command);
  if (!dispatched) {
    res.status(500).json({ error: '远程命令创建后下发失败' });
    return;
  }
  res.status(202).json({ success: true, command: serializeRemoteCommand(dispatched) });
});

router.post('/:id/primary', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const device = db.devices.setPrimary(userId, id);
  if (!device) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  sendBindingIdentityToUser(userId);
  res.status(200).json({ success: true, device: serializeDevice(id) });
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  disconnectDeviceSocket(id, '设备已被删除');
  db.devices.remove(id);
  sendBindingIdentityToUser(userId);
  res.status(200).json({ success: true });
});

export default router;
