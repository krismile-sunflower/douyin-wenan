import { Router, Request, Response } from 'express';
import { VideoDownloader, DashScopeTranscriber, loadConfig } from '@douyin-wenan/core';

const router: Router = Router();

const config = loadConfig();
const downloader = new VideoDownloader({
  userAgent: config.douyin.userAgent,
  tempDir: config.tempDir,
});

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

    const videoInfo = await downloader.getVideoInfo(url);

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
