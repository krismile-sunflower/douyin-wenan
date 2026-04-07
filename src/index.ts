/**
 * 抖音视频文案提取服务
 * 
 * 工作流程:
 * 1. 用户分享抖音链接
 * 2. 解析 HTML 获取视频信息
 * 3. 下载无水印视频
 * 4. FFmpeg 提取音频
 * 5. 阿里云 API 转录为文本
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import apiRoutes from './api';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler';
import { requestLogger } from './api/middleware/request-logger';
import { loadConfig, ensureDir } from './utils';

const config = loadConfig();

// 确保临时目录存在
ensureDir(config.tempDir);

const app = express();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (config.nodeEnv === 'development') {
  app.use(requestLogger);
}

// 路由
app.use('/api', apiRoutes);

// 404 处理
app.use(notFoundHandler);

// 错误处理
app.use(errorHandler);

// 启动服务
app.listen(config.port, () => {
  console.log(`🚀 服务已启动: http://localhost:${config.port}`);
  console.log(`📁 临时目录: ${config.tempDir}`);
  console.log(`🌍 环境: ${config.nodeEnv}`);
});

export default app;
