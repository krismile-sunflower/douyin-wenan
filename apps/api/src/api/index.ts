import { Router } from 'express';
import videoRoutes from './routes/video';
import transcribeRoutes from './routes/transcribe';
import imageRoutes from './routes/image';

const router: Router = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

router.use('/', videoRoutes);
router.use('/', transcribeRoutes);
router.use('/', imageRoutes);

export default router;
