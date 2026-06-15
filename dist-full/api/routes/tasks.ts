import { Router, type Request, type Response } from 'express';
import { db, type SubTask } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { splitTaskIntoSubs, branchNameFromTask, mergeCommitSha } from '../lib/utils.js';
import { broadcast } from '../websocket/manager.js';

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
    repo_url: task.repo_url,
    branch: task.branch,
  };
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
  const repo_url = (body.repo_url || '').trim() || '';
  const branch = (body.branch || 'main').trim() || 'main';

  const onlineDevices = db.devices.findAllByUserId(userId).filter((d) => d.status !== 'offline');
  const allDevices = db.devices.findAllByUserId(userId);

  if (allDevices.length === 0) {
    res.status(400).json({ error: '请先添加至少一台设备' });
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

  const subs = splitTaskIntoSubs(description, Math.min(3, Math.max(2, onlineDevices.length || 2)));
  const usedDevices = onlineDevices.length > 0 ? onlineDevices : allDevices;
  const createdSubs = subs.map((sub, idx) => {
    const device = usedDevices[idx % usedDevices.length];
    return db.subTasks.create({
      task_id: task.id,
      device_id: device.id,
      tool_name: sub.preferredTool,
      status: 'running',
      branch_name: branchNameFromTask(task.id, idx, sub.preferredTool),
      progress: 0,
    });
  });

  createdSubs.forEach((sub) => {
    db.logs.create({
      sub_task_id: sub.id,
      content: `子任务已派发至 ${db.devices.findById(sub.device_id)?.name || '设备'}，工具: ${sub.tool_name}，分支: ${sub.branch_name}`,
      level: 'info',
    });
    db.tools.upsert(sub.device_id, sub.tool_name, { status: 'running', current_task: task.id });
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
  res.status(200).json({ success: true, subTask: serializeSubTask(updated!) });

  const remaining = db.subTasks.findAllByTaskId(id).filter((s) => s.status !== 'completed' && s.status !== 'failed');
  if (remaining.length === 0) {
    db.tasks.update(id, { status: 'completed', completed_at: new Date().toISOString() });
  }
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
  const log = db.logs.create({
    sub_task_id: subtaskId,
    content,
    level: body.level || 'info',
  });
  broadcast(userId, { type: 'task_log', task_id: id, subtask_id: subtaskId, log });
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
  db.tasks.update(task.id, { status: 'merged', completed_at: new Date().toISOString() });
  const sha = mergeCommitSha(task.id);
  broadcast(userId, { type: 'task_merged', task_id: task.id, commit_sha: sha });
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
