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

export type DevTool = 'codex' | 'trae' | 'cursor' | 'claude_code';

export const DEV_TOOLS: DevTool[] = ['trae', 'codex', 'cursor', 'claude_code'];
export const DEFAULT_DEV_TOOL: DevTool = 'trae';

export function normalizeDevTool(value: unknown): DevTool {
  return typeof value === 'string' && (DEV_TOOLS as string[]).includes(value)
    ? (value as DevTool)
    : DEFAULT_DEV_TOOL;
}

export interface SubTaskDesc {
  title: string;
  description: string;
  dependsOnIndices?: number[];
}

export function splitTaskIntoSubs(description: string, count = 3, sequential = false): SubTaskDesc[] {
  const trimmed = description.trim();
  const lines = trimmed.split(/\n+|。|；|;|\./).map((l) => l.trim()).filter(Boolean);

  const subs: SubTaskDesc[] = [];

  if (lines.length >= count) {
    for (let i = 0; i < count; i++) {
      subs.push({
        title: `子任务 ${i + 1}`,
        description: lines[i],
        dependsOnIndices: sequential && i > 0 ? [i - 1] : undefined,
      });
    }
  } else {
    const baseDesc = trimmed || '完成此开发任务的对应部分';
    const subTitles = ['需求分析与脚手架搭建', '核心功能实现', '集成与验证'];
    for (let i = 0; i < count; i++) {
      subs.push({
        title: subTitles[i] || `子任务 ${i + 1}`,
        description: `${baseDesc}（第 ${i + 1} 部分）`,
        dependsOnIndices: sequential && i > 0 ? [i - 1] : undefined,
      });
    }
  }

  return subs;
}

export function branchNameFromTask(taskId: string, subIdx: number, tool: string): string {
  const shortId = taskId.slice(-6);
  return `devfleet/${tool}/sub-${subIdx + 1}-${shortId}`;
}

/** 主设备负责调度/合并；有非主设备在线时只向工作设备派发子任务 */
export function selectExecutionDevices<T extends { is_primary?: boolean }>(online: T[]): T[] {
  const workers = online.filter((device) => !device.is_primary);
  return workers.length > 0 ? workers : online;
}

export function normalizeRepoUrl(value: string): string {
  return value.trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/\/$/, '').toLowerCase();
}
