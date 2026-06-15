import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/store.js';
import { signToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: '邮箱和密码不能为空' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: '邮箱格式不正确' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: '密码至少 6 位' });
    return;
  }
  const exist = db.users.findByEmail(email);
  if (exist) {
    res.status(400).json({ error: '该邮箱已注册' });
    return;
  }
  const password_hash = bcrypt.hashSync(password, 8);
  const user = db.users.create({ email, password_hash });
  const token = signToken(user);
  res.status(200).json({ token, user: { id: user.id, email: user.email } });
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: '邮箱和密码不能为空' });
    return;
  }
  const user = db.users.findByEmail(email);
  if (!user) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }
  const token = signToken(user);
  res.status(200).json({ token, user: { id: user.id, email: user.email } });
});

router.post('/logout', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true });
});

export default router;
