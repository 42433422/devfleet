import { Router, type Request, type Response } from 'express';
import { db, type SubTask } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { splitTaskIntoSubs, branchNameFromTask, normalizeDevTool } from '../lib/utils.js';
import { broadcast } from '../websocket/manager.js';
import {
  dispatchReadySubs,
  handleSubTaskFailure,
  isSubBlocked,
  reconcileTask,
  executorMissing,
  parseDependsOn,
} from '../lib/dispatch.js';
import { hasDevice } from '../websocket/manager.js';

const router = Router();

function serializeSubTask(sub: SubTask) {
  const subs = db.subTasks.findAllByTaskId(sub.task_id);
  const blocked = isSubBlocked(sub, subs);
  const deviceName = db.devices.findById(sub.device_id)?.name;
  return {
    id: sub.id,
    task_id: sub.task_id,
    device_id: sub.device_id,
    device_name: deviceName,
    tool_name: sub.tool_name,
    status: sub.status,
    branch_name: sub.branch_name,
    progress: sub.progress,
    title: sub.title,
    description: sub.description,
    depends_on: sub.depends_on ?? [],
    sort_order: sub.sort_order ?? 0,
    attempt_count: sub.attempt_count ?? 0,
    max_attempts: sub.max_attempts ?? 2,
    last_error: sub.last_error,
    blocked,
    logs: db.logs.findAllBySubTaskId(sub.id).slice(-50),
    created_at: sub.created_at,
    completed_at: sub.completed_at,
  };
}

function serializeTask(taskId: string) {
  const task = db.tasks.findById(taskId);
  if (!task) return null;
  const subs = db.subTasks
    .findAllByTaskId(taskId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(serializeSubTask);
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    subTasks: subs,
    created_at: task.created_at,
    completed_at: task.completed_at,
    merge_commit_sha: task.merge_commit_sha,
    repo_url: task.repo_url,
    branch: task.branch,
  };
}

function appendLog(
  userId: string,
  taskId: string,
  subtaskId: string,
  content: string,
  level: 'info' | 'warn' | 'error' | 'debug' = 'info',
  deviceId?: string,
) {
  const sub = db.subTasks.findById(subtaskId);
  const resolvedDeviceId = deviceId || sub?.device_id;
  const deviceName = resolvedDeviceId ? db.devices.findById(resolvedDeviceId)?.name : undefined;
  const log = db.logs.create({
    sub_task_id: subtaskId,
    content,
    level,
    device_id: resolvedDeviceId,
    task_id: taskId,
  });
  broadcast(userId, {
    type: 'task_log',
    task_id: taskId,
    subtask_id: subtaskId,
    device_id: resolvedDeviceId,
    device_name: deviceName,
    log,
  });
  return log;
}

router.use(authMiddleware);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const tasks = db.tasks.findAllByUserId(userId);
  const list = tasks.map((t) => serializeTask(t.id));
  res.status(200).json({ tasks: list });
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const task = db.tasks.findById(req.params.id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.status(200).json({ task: serializeTask(task.id) });
});

router.get('/:id/logs', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const task = db.tasks.findById(req.params.id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const subs = db.subTasks.findAllByTaskId(task.id);
  const logs = subs
    .flatMap((sub) =>
      db.logs.findAllBySubTaskId(sub.id).map((log) => ({
        ...log,
        subtask_id: sub.id,
        subtask_title: sub.title,
        device_id: log.device_id || sub.device_id,
        device_name: db.devices.findById(log.device_id || sub.device_id)?.name,
      })),
    )
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  res.status(200).json({ logs });
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const body = (req.body || {}) as Record<string, unknown>;

  if (typeof body.device_id === 'string' && body.device_id.trim()) {
    await handleAiSubtaskDispatch(userId, body, res);
    return;
  }

  await handleUiAutoSplitTask(userId, body, res);
});

async function handleAiSubtaskDispatch(
  userId: string,
  body: Record<string, unknown>,
  res: Response,
): Promise<void> {
  const deviceId = String(body.device_id || '').trim();
  const title = String(body.title || '').trim();
  const prompt = String(body.prompt || body.description || '').trim();
  const taskId = String(body.task_id || '').trim();
  const repo_url = String(body.repo_url || '').trim();
  const branch = String(body.branch || body.base_branch || 'main').trim() || 'main';
  const subtaskTitle = String(body.subtask_title || title).trim();
  const dependsOn = parseDependsOn(body.depends_on);

  if (!title) {
    res.status(400).json({ error: 'title 不能为空' });
    return;
  }
  if (!prompt) {
    res.status(400).json({ error: 'prompt（或 description）不能为空' });
    return;
  }

  const device = db.devices.findById(deviceId);
  if (!device || device.user_id !== userId) {
    res.status(400).json({ error: '设备不存在或不属于当前用户' });
    return;
  }
  if (!hasDevice(deviceId)) {
    res.status(400).json({ error: `设备 ${device.name} 未在线，请启动 DevFleet 本机代理` });
    return;
  }
  if (executorMissing(deviceId)) {
    const devTool = normalizeDevTool(device.dev_tool);
    const need = devTool === 'cursor'
      ? 'Cursor Agent CLI（agent login）'
      : devTool === 'trae'
        ? 'Trae IDE（混合模式）'
        : 'Codex CLI（codex login）';
    res.status(400).json({ error: `工作设备 ${device.name} 缺少自动改码执行器：${need}` });
    return;
  }

  let task = taskId ? db.tasks.findById(taskId) : null;
  if (taskId) {
    if (!task || task.user_id !== userId) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    if (task.status === 'merged') {
      res.status(400).json({ error: '任务已合并，无法继续派发子任务' });
      return;
    }
  } else {
    if (repo_url && !(repo_url.startsWith('https://') || repo_url.startsWith('http://') || repo_url.startsWith('git@') || repo_url.startsWith('file://'))) {
      res.status(400).json({ error: '仓库地址必须是 HTTP(S) 或 SSH Git 地址，或留空使用工作设备本地目录' });
      return;
    }
    task = db.tasks.create({
      user_id: userId,
      title,
      description: prompt,
      status: 'running',
      repo_url,
      branch,
    });
  }

  const existingSubs = db.subTasks.findAllByTaskId(task!.id);
  const subIdx = existingSubs.length;
  if (dependsOn.length > 0) {
    const validIds = new Set(existingSubs.map((sub) => sub.id));
    const invalid = dependsOn.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      res.status(400).json({ error: `depends_on 包含无效子任务 ID: ${invalid.join(', ')}` });
      return;
    }
  }

  const toolName = normalizeDevTool(device.dev_tool);
  const sub = db.subTasks.create({
    task_id: task!.id,
    device_id: device.id,
    tool_name: toolName,
    status: 'pending',
    branch_name: branchNameFromTask(task!.id, subIdx, toolName),
    progress: 0,
    title: subtaskTitle,
    description: prompt,
    depends_on: dependsOn,
    sort_order: subIdx,
    attempt_count: 0,
    max_attempts: 2,
  });

  const repoHint = task!.repo_url
    ? `仓库：${task!.repo_url}`
    : '未提供远程仓库，将使用工作设备本地目录';
  const deps = dependsOn.length;
  appendLog(
    userId,
    task!.id,
    sub.id,
    `子任务「${sub.title}」已派发至 ${device.name}（${sub.tool_name}），分支 ${sub.branch_name}。${deps > 0 ? `等待 ${deps} 个前置子任务完成。` : '依赖已满足，等待派发。'} ${repoHint}`,
    'info',
    sub.device_id,
  );

  dispatchReadySubs(userId, task!.id);
  reconcileTask(userId, task!.id);

  const serialized = serializeTask(task!.id);
  broadcast(userId, {
    type: taskId ? 'task_updated' : 'task_created',
    task_id: task!.id,
    ...serialized,
  });
  res.status(200).json({ task: serialized, subtask: serializeSubTask(sub) });
}

async function handleUiAutoSplitTask(
  userId: string,
  body: Record<string, unknown>,
  res: Response,
): Promise<void> {
  const title = String(body.title || '').trim() || '开发任务';
  const description = String(body.description || '').trim() || '完成开发';
  const repo_url = String(body.repo_url || '').trim();
  const branch = String(body.branch || 'main').trim() || 'main';
  const sequential = Boolean(body.sequential);
  const assignments = Array.isArray(body.assignments)
    ? (body.assignments as Array<{ device_id: string; sub_index?: number }>)
    : [];

  if (repo_url && !(repo_url.startsWith('https://') || repo_url.startsWith('http://') || repo_url.startsWith('git@') || repo_url.startsWith('file://'))) {
    res.status(400).json({ error: '仓库地址必须是 HTTP(S) 或 SSH Git 地址，或留空使用工作设备本地目录' });
    return;
  }

  const allDevices = db.devices.findAllByUserId(userId);
  const onlineDevices = allDevices.filter((device) => hasDevice(device.id));

  if (onlineDevices.length === 0) {
    res.status(400).json({ error: '没有在线设备。请先在目标设备启动 DevFleet 本机代理' });
    return;
  }

  const missingExecutor = onlineDevices.filter((device) => executorMissing(device.id));
  if (missingExecutor.length > 0) {
    const detail = missingExecutor
      .map((device) => {
        const devTool = normalizeDevTool(device.dev_tool);
        const need = devTool === 'cursor'
          ? 'Cursor Agent CLI（agent login）'
          : devTool === 'trae'
            ? 'Trae IDE（混合模式）'
            : 'Codex CLI（codex login）';
        return `${device.name}：${need}`;
      })
      .join('；');
    res.status(400).json({
      error: `以下工作设备缺少自动改码执行器：${detail}`,
    });
    return;
  }

  const subCount = Math.max(1, Math.min(3, assignments.length || onlineDevices.length));
  const subsDesc = splitTaskIntoSubs(description, subCount, sequential);

  const task = db.tasks.create({
    user_id: userId,
    title,
    description,
    status: 'running',
    repo_url,
    branch,
  });

  const createdSubs: SubTask[] = [];
  const assignmentMap = new Map<number, string>();
  assignments.forEach((a, idx) => {
    const index = typeof a.sub_index === 'number' ? a.sub_index : idx;
    if (a.device_id && onlineDevices.some((d) => d.id === a.device_id)) {
      assignmentMap.set(index, a.device_id);
    }
  });

  const defaultDevices = onlineDevices.filter((d) => !d.is_primary);
  const pool = defaultDevices.length > 0 ? defaultDevices : onlineDevices;

  for (let idx = 0; idx < subsDesc.length; idx++) {
    const desc = subsDesc[idx];
    const assignedId = assignmentMap.get(idx) || pool[idx % pool.length].id;
    const device = onlineDevices.find((d) => d.id === assignedId) || pool[idx % pool.length];
    const toolName = normalizeDevTool(device.dev_tool);
    const sub = db.subTasks.create({
      task_id: task.id,
      device_id: device.id,
      tool_name: toolName,
      status: 'pending',
      branch_name: branchNameFromTask(task.id, idx, toolName),
      progress: 0,
      title: desc.title,
      description: desc.description,
      depends_on: [],
      sort_order: idx,
      attempt_count: 0,
      max_attempts: 2,
    });
    createdSubs.push(sub);
  }

  const idByIndex = new Map(createdSubs.map((s, i) => [i, s.id]));
  for (let idx = 0; idx < subsDesc.length; idx++) {
    const depIndices = subsDesc[idx].dependsOnIndices || [];
    const depIds = depIndices.map((i) => idByIndex.get(i)).filter(Boolean) as string[];
    if (depIds.length > 0) {
      db.subTasks.update(createdSubs[idx].id, { depends_on: depIds });
      createdSubs[idx] = { ...createdSubs[idx], depends_on: depIds };
    }
  }

  createdSubs.forEach((sub) => {
    const deviceName = db.devices.findById(sub.device_id)?.name || '设备';
    const deps = (sub.depends_on ?? []).length;
    const repoHint = repo_url
      ? `仓库：${repo_url}`
      : '未提供远程仓库，将使用工作设备本地目录';
    appendLog(
      userId,
      task.id,
      sub.id,
      `子任务「${sub.title}」已创建，目标设备 ${deviceName}，工具 ${sub.tool_name}，分支 ${sub.branch_name}。${deps > 0 ? `等待 ${deps} 个前置子任务完成。` : '依赖已满足，等待派发。'} ${repoHint}`,
      'info',
      sub.device_id,
    );
  });

  dispatchReadySubs(userId, task.id);
  reconcileTask(userId, task.id);

  const serialized = serializeTask(task.id);
  broadcast(userId, { type: 'task_created', task_id: task.id, ...serialized });
  res.status(200).json({ task: serialized });
}

router.post('/:id/subtasks/:subtaskId/progress', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id, subtaskId } = req.params;
  const { progress, status } = (req.body || {}) as { progress?: number; status?: SubTask['status'] };
  const task = db.tasks.findById(id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const sub = db.subTasks.findById(subtaskId);
  if (!sub || sub.task_id !== id) {
    res.status(404).json({ error: '子任务不存在' });
    return;
  }
  const validStatuses: SubTask['status'][] = ['pending', 'running', 'completed', 'failed'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: '无效的子任务状态' });
    return;
  }

  if (status === 'failed') {
    const updated = handleSubTaskFailure(userId, id, subtaskId, '手动标记失败');
    const serializedTask = reconcileTask(userId, id);
    res.status(200).json({ success: true, subTask: updated ? serializeSubTask(updated) : null, task: serializeTask(id) ?? serializedTask });
    return;
  }

  const patch: Partial<SubTask> = {};
  if (typeof progress === 'number') patch.progress = Math.max(0, Math.min(100, progress));
  if (status) patch.status = status;
  if (patch.progress === 100 && !patch.status) patch.status = 'completed';
  if (patch.status === 'completed') patch.completed_at = new Date().toISOString();
  const updated = db.subTasks.update(subtaskId, patch);
  if (updated) {
    broadcast(userId, {
      type: 'task_progress',
      task_id: id,
      subtask_id: subtaskId,
      progress: updated.progress,
      status: updated.status,
    });
    if (updated.status === 'completed') {
      dispatchReadySubs(userId, id);
    }
  }
  reconcileTask(userId, id);
  res.status(200).json({ success: true, subTask: serializeSubTask(updated!), task: serializeTask(id) });
});

router.post('/:id/subtasks/:subtaskId/retry', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id, subtaskId } = req.params;
  const task = db.tasks.findById(id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const sub = db.subTasks.findById(subtaskId);
  if (!sub || sub.task_id !== id) {
    res.status(404).json({ error: '子任务不存在' });
    return;
  }
  if (sub.status !== 'failed') {
    res.status(400).json({ error: '仅失败子任务可重试' });
    return;
  }
  const updated = db.subTasks.update(subtaskId, {
    status: 'pending',
    progress: 0,
    completed_at: undefined,
    last_error: undefined,
  });
  if (updated) {
    appendLog(userId, id, subtaskId, '手动重试子任务', 'info', sub.device_id);
    dispatchReadySubs(userId, id);
    reconcileTask(userId, id);
  }
  res.status(200).json({ success: true, subTask: updated ? serializeSubTask(updated) : null, task: serializeTask(id) });
});

router.post('/:id/subtasks/:subtaskId/logs', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id, subtaskId } = req.params;
  const body = (req.body || {}) as { content?: string; level?: 'info' | 'warn' | 'error' | 'debug' };
  const content = (body.content || '').trim();
  if (!content) {
    res.status(400).json({ error: '日志内容不能为空' });
    return;
  }
  const task = db.tasks.findById(id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const sub = db.subTasks.findById(subtaskId);
  if (!sub || sub.task_id !== id) {
    res.status(404).json({ error: '子任务不存在' });
    return;
  }
  const log = appendLog(userId, id, subtaskId, content, body.level || 'info', sub.device_id);
  res.status(200).json({ log });
});

router.post('/:id/merge', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const task = db.tasks.findById(req.params.id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const subs = db.subTasks.findAllByTaskId(task.id);
  if (subs.some((s) => s.status !== 'completed')) {
    res.status(400).json({ error: '仍有子任务未完成' });
    return;
  }
  const { merge_commit_sha } = (req.body || {}) as { merge_commit_sha?: string };
  const sha = (merge_commit_sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    res.status(400).json({ error: '请提供主设备真实合并后的 Git commit SHA' });
    return;
  }
  db.tasks.update(task.id, { status: 'merged', completed_at: new Date().toISOString(), merge_commit_sha: sha });
  broadcast(userId, { type: 'task_merged', task_id: task.id, commit_sha: sha });
  broadcast(userId, { type: 'task_status', task_id: task.id, status: 'merged' });
  res.status(200).json({ success: true, mergeCommitSha: sha, task: serializeTask(task.id) });
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const task = db.tasks.findById(req.params.id);
  if (!task || task.user_id !== userId) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  db.tasks.remove(task.id);
  res.status(200).json({ success: true });
});

export default router;
