/**
 * 文案提取路由 - 处理视频文案提取相关请求
 * 
 * 参考: https://github.com/yzfly/douyin-mcp-server
 * 流程: 解析链接 → 获取无水印视频 URL → 直接用 URL 调百炼 API 转录
 * 不需要下载视频到本地，不需要 FFmpeg
 */

import { Router, Request, Response } from 'express';
import { VideoDownloader } from '../../downloader';
import { DashScopeTranscriber } from '../../transcriber/dashscope-transcriber';
import { loadConfig } from '../../utils';

const router = Router();

// 初始化依赖
const config = loadConfig();
const downloader = new VideoDownloader({
  userAgent: config.douyin.userAgent,
  tempDir: config.tempDir,
});

/**
 * POST /api/transcribe
 * 提取视频文案 (简化流程: 解析 → 获取视频 URL → 百炼 API 转录)
 */
router.post('/transcribe', async (req: Request, res: Response, next) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: '请提供有效的链接',
      });
      return;
    }

    // 步骤 1: 解析链接并获取无水印视频 URL
    const videoInfo = await downloader.getVideoInfo(url);

    // 步骤 2: 用百炼 API 直接从视频 URL 转录
    if (!config.dashscope.apiKey) {
      res.status(500).json({
        success: false,
        error: '缺少 DASHSCOPE_API_KEY，请在环境变量中配置',
      });
      return;
    }

    const transcriber = new DashScopeTranscriber({
      apiKey: config.dashscope.apiKey,
      model: config.dashscope.model,
    });

    const transcriptionResult = await transcriber.transcribe(videoInfo.videoUrl);

    res.json({
      success: true,
      data: {
        text: transcriptionResult.text,
        videoId: videoInfo.videoId,
        title: videoInfo.title,
        taskId: transcriptionResult.taskId,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
