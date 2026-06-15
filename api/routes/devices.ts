import { Router, type Request, type Response } from 'express';
import { db } from '../db/store.js';
import { authMiddleware } from '../middleware/auth.js';
import { genBindCode, genDeviceToken, normalizeDevTool, type DevTool } from '../lib/utils.js';
import { broadcast, disconnectDeviceSocket, hasDevice, sendBindingIdentity, sendBindingIdentityToUser } from '../websocket/manager.js';
import { createHash } from 'node:crypto';

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
    status: hasDevice(dev.id) ? 'online' : dev.status === 'connecting' ? 'connecting' : 'offline',
    devTool: normalizeDevTool(dev.dev_tool),
    tools: finalTools,
    lastSeen: dev.last_seen,
    bindCode: dev.bind_code,
    activated: dev.activated !== false,
    isPrimary: Boolean(dev.is_primary),
  };
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
    bind_code_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    status: 'offline',
    activated: false,
    dev_tool: 'trae',
  });
  res.status(200).json({ bindCode: device.bind_code, deviceId: device.id, expiresAt: device.bind_code_expires_at });
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
