import { db } from '../db/store.js';
import { genBindCode } from './utils.js';
import type { User } from '../db/store.js';

function isLegacyGuestEmail(email: string): boolean {
  return email.startsWith('guest_') && email.endsWith('@devfleet.local');
}

/** 访客登录：复用单一 guest 账号，合并旧 guest_* 会话数据 */
export function ensureGuestSession(): User {
  let guest = db.users.findGuest();
  if (!guest) {
    guest = db.users.create({
      email: 'guest@devfleet.local',
      password_hash: '',
      is_guest: true,
    });
  }

  const legacyGuests = db.users.findAll().filter(
    (user) => user.id !== guest!.id && isLegacyGuestEmail(user.email),
  );
  for (const legacy of legacyGuests) {
    db.users.reassignData(legacy.id, guest.id);
  }

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

  return guest;
}
