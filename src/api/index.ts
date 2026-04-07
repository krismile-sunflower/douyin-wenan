import { Router } from 'express';
import videoRoutes from './routes/video';
import transcribeRoutes from './routes/transcribe';

const router = Router();

// 健康检查
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 挂载路由
router.use('/', videoRoutes);
router.use('/', transcribeRoutes);

export default router;
