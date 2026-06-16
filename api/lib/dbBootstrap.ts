import { getDatabase } from '../db/sqlite.js';
import { ensureGuestSession } from '../lib/guestBootstrap.js';

/** 全新环境：建库、迁移、预置 guest 会话（server 启动与测试共用） */
export function bootstrapDatabase(): void {
  try {
    getDatabase();
    ensureGuestSession();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/readonly|unable to open|EACCES|EPERM|只读|系统保护/i.test(message)) {
      throw new Error(
        `数据库无法写入（${message}）。桌面版应写入用户数据目录，请勿从 DMG/安装包内直接运行；Windows 请用 .exe/.msi 安装到当前用户目录。`,
      );
    }
    throw error;
  }
}
