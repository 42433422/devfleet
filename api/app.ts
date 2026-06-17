import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import devicesRoutes from './routes/devices.js';
import tasksRoutes from './routes/tasks.js';
import tunnelRoutes from './routes/tunnel.js';

const app = express();
if (process.env.DEVFLEET_AUTH_DEBUG === '1') {
  app.use((req, _res, next): void => {
    const auth = req.headers.authorization || '';
    console.error(
      `[req-debug] pid=${process.pid} ${req.method} ${req.url} authLen=${auth.length}`,
    );
    next();
  });
}

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

const defaultOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'tauri://localhost',
  'https://tauri.localhost',
];

const allowedOrigins = new Set(
  (process.env.DEVFLEET_CORS_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

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

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin not allowed'));
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/devices/activate', activationLimiter);
app.use('/api/devices', devicesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/tunnel', tunnelRoutes);

app.get('/api/health', (req: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    message: 'ok',
    embedded: process.env.DEVFLEET_DESKTOP === '1',
    pid: process.pid,
  });
});

app.use((error: Error, req: Request, res: Response, _next: NextFunction): void => {
  void _next;
  if (error.message === 'CORS origin not allowed') {
    res.status(403).json({ success: false, error: 'CORS origin not allowed' });
    return;
  }
  console.error('[API ERROR]', error);
  res.status(500).json({ success: false, error: 'Server internal error' });
});

app.use((req: Request, res: Response): void => {
  res.status(404).json({ success: false, error: 'API not found' });
});

export default app;
