import 'dotenv/config';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const configuredSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && !configuredSecret) {
  throw new Error('生产环境必须配置 JWT_SECRET');
}
export const JWT_SECRET = configuredSecret || 'devfleet-dev-secret-change-me';

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string; email: string };
  }
}

export function signToken(user: { id: string; email: string }): string {
  return jwt.sign({ id: user.id, email: user.email, sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): { id: string; email: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id?: string; email?: string; sub?: string };
    return { id: decoded.id || decoded.sub || '', email: decoded.email || '' };
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未授权' });
    return;
  }
  const token = authHeader.slice(7);
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'token 无效或已过期' });
    return;
  }
  req.user = user;
  next();
}

export function getTokenFromReq(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

export function getUserFromReq(req: Request): { id: string; email: string } | null {
  const token = getTokenFromReq(req);
  if (!token) return null;
  return verifyToken(token);
}

export function getUserFromQuery(req: Request): { id: string; email: string } | null {
  const token = (req.query.token as string) || '';
  if (!token) return null;
  return verifyToken(token);
}
