import { Router, Request, Response } from 'express';
import { VideoDownloader, safeDelete, generateFileName, loadConfig } from '@douyin-wenan/core';

const router: Router = Router();

const config = loadConfig();
const downloader = new VideoDownloader({
  userAgent: config.douyin.userAgent,
  tempDir: config.tempDir,
});

router.post('/parse', async (req: Request, res: Response, next) => {
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

    res.json({
      success: true,
      data: {
        videoId: videoInfo.videoId,
        title: videoInfo.title,
        videoUrl: videoInfo.videoUrl,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/download', async (req: Request, res: Response, next) => {
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
    const fileName = generateFileName('video', 'mp4');
    const downloadResult = await downloader.download(videoInfo.videoUrl, fileName);

    res.json({
      success: true,
      data: {
        videoUrl: downloadResult.videoUrl,
        filePath: downloadResult.filePath,
        fileSize: downloadResult.fileSize,
        videoId: videoInfo.videoId,
        title: videoInfo.title,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/download/:fileName', async (req: Request, res: Response, next) => {
  try {
    const { fileName } = req.params;
    const tempDir = process.env.TEMP_DIR || './tmp';
    const filePath = `${tempDir}/${fileName}`;

    await safeDelete(filePath);

    res.json({
      success: true,
      message: '文件已清理',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
