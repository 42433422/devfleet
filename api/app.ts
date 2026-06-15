import express, { type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import devicesRoutes from './routes/devices.js';
import tasksRoutes from './routes/tasks.js';
import tunnelRoutes from './routes/tunnel.js';

const app = express();

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '登录请求过于频繁，请稍后重试' },
});

const activationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '绑定尝试过于频繁，请重新生成绑定码后再试' },
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/devices/activate', activationLimiter);
app.use('/api/devices', devicesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/tunnel', tunnelRoutes);

app.get('/api/health', (req: Request, res: Response): void => {
  res.status(200).json({ success: true, message: 'ok' });
});

app.use((error: Error, req: Request, res: Response): void => {
  console.error('[API ERROR]', error);
  res.status(500).json({ success: false, error: 'Server internal error' });
});

app.use((req: Request, res: Response): void => {
  res.status(404).json({ success: false, error: 'API not found' });
});

export default app;
