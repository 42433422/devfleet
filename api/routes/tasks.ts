import { Router, type Request, type Response } from 'express';
import { db, type SubTask } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { splitTaskIntoSubs, branchNameFromTask, normalizeDevTool, selectExecutionDevices } from '../lib/utils.js';
import { broadcast, hasDevice, sendToDevice } from '../websocket/manager.js';

const router = Router();

function serializeSubTask(sub: SubTask) {
  return {
    id: sub.id,
    task_id: sub.task_id,
    device_id: sub.device_id,
    tool_name: sub.tool_name,
    status: sub.status,
    branch_name: sub.branch_name,
    progress: sub.progress,
    logs: db.logs.findAllBySubTaskId(sub.id).slice(-50),
    created_at: sub.created_at,
    completed_at: sub.completed_at,
  };
}

function serializeTask(taskId: string) {
  const task = db.tasks.findById(taskId);
  if (!task) return null;
  const subs = db.subTasks.findAllByTaskId(taskId).map(serializeSubTask);
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

function appendLog(userId: string, taskId: string, subtaskId: string, content: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
  const log = db.logs.create({ sub_task_id: subtaskId, content, level });
  broadcast(userId, { type: 'task_log', task_id: taskId, subtask_id: subtaskId, log });
  return log;
}

function reconcileTask(userId: string, taskId: string) {
  const task = db.tasks.findById(taskId);
  if (!task) return null;
  const subs = db.subTasks.findAllByTaskId(taskId);
  const hasFailed = subs.some((sub) => sub.status === 'failed');
  const allCompleted = subs.length > 0 && subs.every((sub) => sub.status === 'completed');
  const nextStatus = hasFailed ? 'failed' : allCompleted ? 'completed' : 'running';

  if (task.status !== nextStatus) {
    db.tasks.update(taskId, {
      status: nextStatus,
      ...((nextStatus === 'completed' || nextStatus === 'failed') ? { completed_at: new Date().toISOString() } : {}),
    });
    broadcast(userId, { type: 'task_status', task_id: taskId, status: nextStatus });
  }

  subs.filter((sub) => sub.status === 'completed' || sub.status === 'failed').forEach((sub) => {
    db.tools.upsert(sub.device_id, sub.tool_name, { status: 'idle', current_task: undefined });
  });
  return serializeTask(taskId);
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

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const body = (req.body || {}) as {
    title?: string;
    description?: string;
    repo_url?: string;
    branch?: string;
  };
  const title = (body.title || '').trim() || '开发任务';
  const description = (body.description || '').trim() || '完成开发';
  const repo_url = (body.repo_url || '').trim();

  const branch = (body.branch || 'main').trim() || 'main';

  if (repo_url && !(repo_url.startsWith('https://') || repo_url.startsWith('http://') || repo_url.startsWith('git@'))) {
    res.status(400).json({ error: '仓库地址必须是 HTTP(S) 或 SSH Git 地址，或留空使用工作设备本地目录' });
    return;
  }

  const allDevices = db.devices.findAllByUserId(userId);
  const onlineDevices = allDevices.filter((device) => hasDevice(device.id));

  if (onlineDevices.length === 0) {
    res.status(400).json({ error: '没有在线设备。请先在目标设备启动 DevFleet 本机代理' });
    return;
  }

  const executionDevices = selectExecutionDevices(onlineDevices);
  const missingExecutor = executionDevices.filter((device) => {
    const tools = db.tools.findAllByDeviceId(device.id);
    if (tools.length === 0) return false;
    const devTool = normalizeDevTool(device.dev_tool) as DevTool;
    if (devTool === 'cursor') {
      const cursor = tools.find((tool) => tool.tool_name === 'cursor');
      return !cursor || cursor.status === 'not_installed';
    }
    if (devTool === 'trae') {
      const trae = tools.find((tool) => tool.tool_name === 'trae');
      return !trae || trae.status === 'not_installed';
    }
    const codex = tools.find((tool) => tool.tool_name === 'codex');
    return !codex || codex.status === 'not_installed';
  });
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

  const task = db.tasks.create({
    user_id: userId,
    title,
    description,
    status: 'running',
    repo_url,
    branch,
  });

  const subs = splitTaskIntoSubs(description, Math.min(3, executionDevices.length));
  const usedDevices = executionDevices;
  const createdSubs = subs.map((sub, idx) => {
    const device = usedDevices[idx % usedDevices.length];
    const toolName = normalizeDevTool(device.dev_tool);
    return db.subTasks.create({
      task_id: task.id,
      device_id: device.id,
      tool_name: toolName,
      status: 'running',
      branch_name: branchNameFromTask(task.id, idx, toolName),
      progress: 0,
    });
  });

  createdSubs.forEach((sub) => {
    const deviceName = db.devices.findById(sub.device_id)?.name || '设备';
    const repoHint = repo_url
      ? `仓库：${repo_url}`
      : '未提供远程仓库，将使用工作设备本地目录';
    db.logs.create({
      sub_task_id: sub.id,
      content: `子任务已派发至 ${deviceName}，工具: ${sub.tool_name}，分支: ${sub.branch_name}。${repoHint}。任务开始时会自动尝试启动开发工具。`,
      level: 'info',
    });
    db.tools.upsert(sub.device_id, sub.tool_name, { status: 'running', current_task: task.id });
  });

  createdSubs.forEach((sub, idx) => {
    if (!hasDevice(sub.device_id)) return;
    sendToDevice(sub.device_id, {
      type: 'execute_task',
      task_id: task.id,
      subtask_id: sub.id,
      title: subs[idx].title,
      description: subs[idx].description,
      repo_url,
      base_branch: branch,
      work_branch: sub.branch_name,
      tool: sub.tool_name,
    });
  });

  const serialized = serializeTask(task.id);
  broadcast(userId, { type: 'task_created', task_id: task.id, ...serialized });
  res.status(200).json({ task: serialized });

});

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
  }
  const serializedTask = reconcileTask(userId, id);
  res.status(200).json({ success: true, subTask: serializeSubTask(updated!), task: serializedTask });
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
  const log = appendLog(userId, id, subtaskId, content, body.level || 'info');
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
