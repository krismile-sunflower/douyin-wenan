/**
 * 视频路由 - 处理视频解析和下载相关请求
 */

import { Router, Request, Response } from 'express';
import { VideoDownloader } from '../../downloader';
import { safeDelete, generateFileName, loadConfig } from '../../utils';

const router = Router();

// 初始化依赖
const config = loadConfig();
const downloader = new VideoDownloader({
  userAgent: config.douyin.userAgent,
  tempDir: config.tempDir,
});

/**
 * POST /api/parse
 * 解析抖音分享链接，返回视频信息
 */
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

/**
 * POST /api/download
 * 下载无水印视频，返回文件路径和 URL
 */
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

    // 获取视频信息 (包含无水印 URL)
    const videoInfo = await downloader.getVideoInfo(url);

    // 下载视频
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

/**
 * DELETE /api/download/:fileName
 * 清理已下载的视频文件
 */
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
