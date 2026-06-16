import { getDatabase } from '../db/sqlite.js';
import { ensureGuestSession } from '../lib/guestBootstrap.js';

/** 全新环境：建库、迁移、预置 guest 会话（server 启动与测试共用） */
export function bootstrapDatabase(): void {
  getDatabase();
  ensureGuestSession();
}
