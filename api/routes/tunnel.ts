import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getTunnelStatus, startBuiltinTunnel, stopBuiltinTunnel } from '../tunnel/manager.js';

const router = Router();

router.use(authMiddleware);

router.get('/status', (_req: Request, res: Response): void => {
  res.status(200).json(getTunnelStatus());
});

router.post('/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const port = Number(process.env.PORT) || 3001;
    const provider = req.body?.provider;
    const preferred = provider === 'localtunnel' || provider === 'cloudflared' ? provider : 'auto';
    const status = await startBuiltinTunnel(port, preferred);
    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({
      ...getTunnelStatus(),
      error: error instanceof Error ? error.message : '启动内置穿透失败',
    });
  }
});

router.post('/stop', async (_req: Request, res: Response): Promise<void> => {
  const status = await stopBuiltinTunnel();
  res.status(200).json(status);
});

export default router;
