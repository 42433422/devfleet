import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export function genId(): string {
  return randomUUID();
}

export function genBindCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[randomInt(chars.length)];
  }
  return code;
}

export function genDeviceToken(): string {
  return randomBytes(32).toString('hex');
}

export interface SubTaskDesc {
  title: string;
  description: string;
  preferredTool: 'codex' | 'trae' | 'cursor' | 'claude_code';
}

const TOOL_POOL: Array<'codex' | 'trae' | 'cursor' | 'claude_code'> = ['cursor', 'trae', 'claude_code', 'codex'];

export function splitTaskIntoSubs(description: string, count = 3): SubTaskDesc[] {
  const trimmed = description.trim();
  const lines = trimmed.split(/\n+|。|；|;|\./).map((l) => l.trim()).filter(Boolean);

  const subs: SubTaskDesc[] = [];

  if (lines.length >= count) {
    for (let i = 0; i < count; i++) {
      subs.push({
        title: `子任务 ${i + 1}`,
        description: lines[i],
        preferredTool: TOOL_POOL[i % TOOL_POOL.length],
      });
    }
  } else {
    const baseDesc = trimmed || '完成此开发任务的对应部分';
    const subTitles = ['需求分析与脚手架搭建', '核心功能实现', '集成与验证'];
    for (let i = 0; i < count; i++) {
      subs.push({
        title: subTitles[i] || `子任务 ${i + 1}`,
        description: `${baseDesc}（第 ${i + 1} 部分）`,
        preferredTool: TOOL_POOL[i % TOOL_POOL.length],
      });
    }
  }

  return subs;
}

export function branchNameFromTask(taskId: string, subIdx: number, tool: string): string {
  const shortId = taskId.slice(-6);
  return `devfleet/${tool}/sub-${subIdx + 1}-${shortId}`;
}
