import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import apiRoutes from './api';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler';
import { requestLogger } from './api/middleware/request-logger';
import { loadConfig, ensureDir } from '@douyin-wenan/core';

const config = loadConfig();

ensureDir(config.tempDir);

const app: express.Application = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (config.nodeEnv === 'development') {
  app.use(requestLogger);
}

app.use('/api', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`服务已启动: http://localhost:${config.port}`);
  console.log(`临时目录: ${config.tempDir}`);
  console.log(`环境: ${config.nodeEnv}`);
});

export default app;
