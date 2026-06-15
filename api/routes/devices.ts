import { Router, type Request, type Response } from 'express';
import { db } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { genBindCode } from '../lib/utils.js';
import { broadcast } from '../websocket/manager.js';

const router = Router();

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
  return {
    id: dev.id,
    name: dev.name,
    status: dev.status,
    tools: finalTools,
    lastSeen: dev.last_seen,
    bindCode: dev.bind_code,
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
  const device = db.devices.create({
    user_id: userId,
    name: deviceName,
    bind_code: genBindCode(),
    status: 'offline',
    activated: false,
  });
  res.status(200).json({ bindCode: device.bind_code });
});

router.post('/:id/connect', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  db.devices.update(id, { status: 'connecting' });
  broadcast(userId, { type: 'device_status', device_id: id, status: 'connecting' });
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
  db.devices.update(id, { status: 'offline' });
  broadcast(userId, { type: 'device_status', device_id: id, status: 'offline' });
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

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;
  const dev = db.devices.findById(id);
  if (!dev || dev.user_id !== userId) {
    res.status(404).json({ error: '设备不存在' });
    return;
  }
  db.devices.remove(id);
  res.status(200).json({ success: true });
});

router.post('/activate', async (req: Request, res: Response): Promise<void> => {
  const { bindCode, deviceName } = (req.body || {}) as { bindCode?: string; deviceName?: string };
  if (!bindCode) {
    res.status(400).json({ error: '绑定码不能为空' });
    return;
  }
  const device = db.devices.findByBindCode(bindCode);
  if (!device) {
    res.status(404).json({ error: '无效的绑定码' });
    return;
  }
  db.devices.update(device.id, { status: 'online', activated: true });
  if (deviceName && deviceName.trim()) {
    db.devices.update(device.id, { name: deviceName.trim() });
  }
  broadcast(device.user_id, { type: 'device_status', device_id: device.id, status: 'online' });
  res.status(200).json({ success: true, device: serializeDevice(device.id) });
});

export default router;
