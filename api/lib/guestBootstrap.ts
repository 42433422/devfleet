import { db } from '../db/store.js';
import { genBindCode } from './utils.js';
import type { User } from '../db/store.js';

function isLegacyGuestEmail(email: string): boolean {
  return email.startsWith('guest_') && email.endsWith('@devfleet.local');
}

export function isGuestSessionEmail(email: string): boolean {
  return email === 'guest@devfleet.local' || isLegacyGuestEmail(email);
}

function mergeLegacyGuests(guest: User): void {
  const legacyGuests = db.users.findAll().filter(
    (user) => user.id !== guest.id && isGuestSessionEmail(user.email),
  );
  for (const legacy of legacyGuests) {
    db.users.reassignData(legacy.id, guest.id);
  }
}

function ensureDefaultDevice(guest: User): void {
  if (db.devices.countByUserId(guest.id) === 0) {
    db.devices.create({
      user_id: guest.id,
      name: '我的开发设备',
      bind_code: genBindCode(),
      bind_code_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      status: 'offline',
      activated: true,
      dev_tool: 'trae',
      is_primary: true,
    });
  }
}

/** 服务启动时调用：创建 guest 账号并合并历史访客数据 */
export function ensureGuestSession(): User {
  let guest = db.users.findGuest();
  if (!guest) {
    guest = db.users.create({
      email: 'guest@devfleet.local',
      password_hash: '',
      is_guest: true,
    });
  }

  mergeLegacyGuests(guest);
  ensureDefaultDevice(guest);
  return guest;
}

/** 运行时访客登录：只读已有 guest，避免每次请求触发 SQLite 重锁 */
export function getGuestUser(): User {
  const guest = db.users.findGuest();
  if (!guest) {
    return ensureGuestSession();
  }
  return guest;
}
