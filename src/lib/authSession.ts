export interface AuthUser {
  id: string;
  email: string;
}

type AuthStoreSync = (token: string | null, user: AuthUser | null) => void;

const TOKEN_KEY = 'devfleet_token';
const USER_KEY = 'devfleet_user';

let storeSync: AuthStoreSync | null = null;
let guestLoginInFlight: Promise<string | null> | null = null;

export function registerAuthStoreSync(sync: AuthStoreSync): void {
  storeSync = sync;
}

export function applyAuthSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  storeSync?.(token, user);
}

export function clearAuthSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  storeSync?.(null, null);
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) return JSON.parse(stored) as AuthUser;
  } catch {
    return null;
  }
  return null;
}

export function parseUserFromToken(token: string): AuthUser | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return { id: decoded.id || decoded.sub || '1', email: decoded.email || '' };
  } catch {
    return { id: '1', email: 'user@devfleet.local' };
  }
}

export function setGuestLoginInFlight(promise: Promise<string | null> | null): void {
  guestLoginInFlight = promise;
}

export function getGuestLoginInFlight(): Promise<string | null> | null {
  return guestLoginInFlight;
}
