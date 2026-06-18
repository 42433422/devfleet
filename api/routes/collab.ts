import { Router, type Request, type Response } from 'express';
import { db, type CollabMessage, type CollabSession } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { branchNameFromTask, normalizeDevTool } from '../lib/utils.js';
import { buildCollabPrompt } from '../lib/collab.js';
import { dispatchReadySubs, executorMissing, reconcileTask } from '../lib/dispatch.js';
import { broadcast, hasDevice, sendBindingIdentity } from '../websocket/manager.js';

const router = Router();

function serializeMessage(message: CollabMessage) {
  return {
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    task_id: message.task_id,
    sub_task_id: message.sub_task_id,
    status: message.status,
    created_at: message.created_at,
    updated_at: message.updated_at,
  };
}

function serializeSession(session: CollabSession, includeMessages = true) {
  const device = db.devices.findById(session.device_id);
  const task = db.tasks.findById(session.task_id);
  const allMessages = db.collabMessages.findAllBySessionId(session.id);
  const messages = includeMessages ? allMessages.map(serializeMessage) : undefined;
  const userMessages = allMessages.filter((message) => message.role === 'user');
  const queuedMessages = userMessages.filter((message) => message.status === 'queued');
  const runningMessages = userMessages.filter((message) => message.status === 'running');
  const contextSummary = allMessages
    .filter((message) => message.role !== 'system')
    .slice(-6)
    .map((message) => `${message.role === 'assistant' ? '远端' : '主控'}: ${message.content.trim()}`)
    .join('\n')
    .slice(0, 600);
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    device_id: session.device_id,
    device_name: device?.name,
    device_status: device && hasDevice(device.id) ? 'online' : device?.status || 'offline',
    task_id: session.task_id,
    task_status: task?.status,
    repo_url: session.repo_url,
    branch: session.branch,
    turn_count: userMessages.length,
    queued_count: queuedMessages.length,
    running_count: runningMessages.length,
    active_message_id: runningMessages[0]?.id || queuedMessages[0]?.id,
    context_summary: contextSummary,
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at,
    ...(messages ? { messages } : {}),
  };
}

function validateRepoUrl(repoUrl: string): boolean {
  return !repoUrl
    || repoUrl.startsWith('https://')
    || repoUrl.startsWith('http://')
    || repoUrl.startsWith('git@')
    || repoUrl.startsWith('git://')
    || repoUrl.startsWith('file://');
}

router.use(authMiddleware);

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  const sessions = db.collabSessions
    .findAllByUserId(req.user!.id)
    .map((session) => serializeSession(session, false));
  res.status(200).json({ sessions });
});

router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const body = (req.body || {}) as {
    device_id?: string;
    title?: string;
    repo_url?: string;
    branch?: string;
  };
  const deviceId = String(body.device_id || '').trim();
  const device = db.devices.findById(deviceId);
  if (!device || device.user_id !== userId) {
    res.status(404).json({ error: '设备不存在或不属于当前用户' });
    return;
  }

  const repoUrl = String(body.repo_url || '').trim();
  if (!validateRepoUrl(repoUrl)) {
    res.status(400).json({ error: '仓库地址必须是 HTTP(S)、SSH、git://、file://，或留空使用工作设备本地目录' });
    return;
  }

  if (normalizeDevTool(device.dev_tool) !== 'codex') {
    db.devices.update(device.id, { dev_tool: 'codex' });
    sendBindingIdentity(device.id);
  }
  if (hasDevice(device.id) && executorMissing(device.id)) {
    res.status(400).json({ error: `工作设备 ${device.name} 缺少 Codex CLI（请先安装并 codex login）` });
    return;
  }

  const title = String(body.title || '').trim() || `与 ${device.name} 的 Codex 协作`;
  const branch = String(body.branch || 'main').trim() || 'main';
  const task = db.tasks.create({
    user_id: userId,
    title,
    description: `持续协作会话：${title}`,
    status: 'running',
    repo_url: repoUrl,
    branch,
  });
  const session = db.collabSessions.create({
    user_id: userId,
    device_id: device.id,
    task_id: task.id,
    title,
    status: hasDevice(device.id) ? 'open' : 'paused',
    repo_url: repoUrl,
    branch,
  });
  db.collabMessages.create({
    session_id: session.id,
    role: 'system',
    content: hasDevice(device.id)
      ? `会话已建立，目标设备 ${device.name} 在线。`
      : `会话已建立，目标设备 ${device.name} 当前离线；消息会先排队，设备重连后派发。`,
    task_id: task.id,
    status: 'completed',
  });

  const serialized = serializeSession(session);
  broadcast(userId, { type: 'collab_session', session: serialized });
  res.status(200).json({ session: serialized });
});

router.get('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  const session = db.collabSessions.findById(req.params.id);
  if (!session || session.user_id !== req.user!.id) {
    res.status(404).json({ error: '协作会话不存在' });
    return;
  }
  res.status(200).json({ session: serializeSession(session) });
});

router.post('/sessions/:id/messages', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const session = db.collabSessions.findById(req.params.id);
  if (!session || session.user_id !== userId) {
    res.status(404).json({ error: '协作会话不存在' });
    return;
  }
  if (session.status === 'closed') {
    res.status(400).json({ error: '协作会话已关闭' });
    return;
  }

  const content = String((req.body || {}).content || '').trim();
  if (!content) {
    res.status(400).json({ error: '消息内容不能为空' });
    return;
  }

  const device = db.devices.findById(session.device_id);
  if (!device || device.user_id !== userId) {
    res.status(404).json({ error: '目标设备不存在' });
    return;
  }
  if (normalizeDevTool(device.dev_tool) !== 'codex') {
    db.devices.update(device.id, { dev_tool: 'codex' });
    sendBindingIdentity(device.id);
  }
  if (hasDevice(device.id) && executorMissing(device.id)) {
    res.status(400).json({ error: `工作设备 ${device.name} 缺少 Codex CLI（请先安装并 codex login）` });
    return;
  }

  const existingMessages = db.collabMessages.findAllBySessionId(session.id);
  const userMessage = db.collabMessages.create({
    session_id: session.id,
    role: 'user',
    content,
    task_id: session.task_id,
    status: 'queued',
  });
  const messagesWithCurrent = [...existingMessages, userMessage];
  const prompt = buildCollabPrompt(session, messagesWithCurrent, content);
  const taskSubs = db.subTasks.findAllByTaskId(session.task_id);
  const previousTurn = [...existingMessages]
    .reverse()
    .find((message) =>
      message.role === 'user'
      && message.sub_task_id
      && ['queued', 'running', 'completed'].includes(message.status),
    );
  const toolName = 'codex';
  const sub = db.subTasks.create({
    task_id: session.task_id,
    device_id: device.id,
    tool_name: toolName,
    status: 'pending',
    branch_name: branchNameFromTask(session.task_id, taskSubs.length, toolName),
    progress: 0,
    title: `协作消息 ${existingMessages.filter((message) => message.role === 'user').length + 1}`,
    description: prompt,
    depends_on: previousTurn?.sub_task_id ? [previousTurn.sub_task_id] : [],
    sort_order: taskSubs.length,
    attempt_count: 0,
    max_attempts: 2,
  });
  const linkedMessage = db.collabMessages.update(userMessage.id, {
    sub_task_id: sub.id,
  }) || userMessage;

  db.logs.create({
    sub_task_id: sub.id,
    task_id: session.task_id,
    device_id: device.id,
    level: hasDevice(device.id) ? 'info' : 'warn',
    content: hasDevice(device.id)
      ? `协作消息已交给 ${device.name} 的 Codex 队列`
      : `目标设备 ${device.name} 离线，协作消息保持排队；设备重连后自动派发`,
  });
  db.collabSessions.update(session.id, { status: hasDevice(device.id) ? 'open' : 'paused' });
  dispatchReadySubs(userId, session.task_id);
  reconcileTask(userId, session.task_id);

  const serialized = serializeSession(db.collabSessions.findById(session.id) || session);
  broadcast(userId, { type: 'collab_message', session_id: session.id, message: serializeMessage(linkedMessage) });
  broadcast(userId, { type: 'collab_session', session: serialized });
  res.status(200).json({ session: serialized, message: serializeMessage(linkedMessage), subtask_id: sub.id });
});

router.post('/sessions/:id/close', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const session = db.collabSessions.findById(req.params.id);
  if (!session || session.user_id !== userId) {
    res.status(404).json({ error: '协作会话不存在' });
    return;
  }
  const closed = db.collabSessions.update(session.id, {
    status: 'closed',
    closed_at: new Date().toISOString(),
  }) || session;
  const serialized = serializeSession(closed);
  broadcast(userId, { type: 'collab_session', session: serialized });
  res.status(200).json({ session: serialized });
});

export default router;
