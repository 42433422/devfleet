import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import devicesRoutes from './routes/devices.js';
import tasksRoutes from './routes/tasks.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/tasks', tasksRoutes);

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
