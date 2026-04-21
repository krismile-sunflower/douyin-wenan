import { Router, Request, Response } from 'express';
import {
  ImageService,
  WatermarkRemover,
  generateFileName,
  safeDelete,
  loadConfig,
} from '@douyin-wenan/core';

const router: Router = Router();

const config = loadConfig();
const imageService = new ImageService({
  userAgent: config.douyin.userAgent,
  tempDir: config.tempDir,
});
const watermarkRemover = new WatermarkRemover({
  tempDir: config.tempDir,
});

/**
 * POST /api/image/parse
 * 解析抖音图集分享链接，获取无水印图片信息
 */
router.post('/parse', async (req: Request, res: Response, next) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: '请提供有效的分享链接',
      });
      return;
    }

    const albumInfo = await imageService.getAlbumInfo(url);

    res.json({
      success: true,
      data: {
        albumId: albumInfo.albumId,
        title: albumInfo.title,
        imageCount: albumInfo.imageCount,
        images: albumInfo.images.map((img: { url: string; width: number; height: number }, index: number) => ({
          index: index + 1,
          url: img.url,
          width: img.width,
          height: img.height,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/image/download
 * 下载图集图片或单张图片
 */
router.post('/download', async (req: Request, res: Response, next) => {
  try {
    const { url, fileName } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: '请提供有效的图片链接',
      });
      return;
    }

    const result = await imageService.downloadImage(url, fileName);

    res.json({
      success: true,
      data: {
        imageUrl: result.imageUrl,
        filePath: result.filePath,
        fileSize: result.fileSize,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/image/remove-watermark
 * 去除图片水印
 * 支持两种模式:
 * 1. crop: 通过裁剪去除固定位置水印
 *    { imageUrl, mode: 'crop', options: { top: 0, bottom: 100, left: 0, right: 0 } }
 * 2. api: 通过外部AI API去除水印
 *    { imageUrl, mode: 'api', apiConfig: { endpoint, apiKey } }
 */
router.post('/remove-watermark', async (req: Request, res: Response, next) => {
  try {
    const { imageUrl, mode, options, apiConfig } = req.body;

    if (!imageUrl || typeof imageUrl !== 'string') {
      res.status(400).json({
        success: false,
        error: '请提供有效的图片链接或路径',
      });
      return;
    }

    if (!mode || !['crop', 'api'].includes(mode)) {
      res.status(400).json({
        success: false,
        error: '请指定有效的去水印模式: crop 或 api',
      });
      return;
    }

    let result;
    const outputFileName = generateFileName('wm_removed', 'jpg');

    if (mode === 'crop') {
      if (!options || typeof options !== 'object') {
        res.status(400).json({
          success: false,
          error: 'crop 模式需要提供 options 参数',
        });
        return;
      }

      result = await watermarkRemover.removeByCrop(
        imageUrl,
        options,
        outputFileName
      );
    } else {
      if (!apiConfig || !apiConfig.endpoint || !apiConfig.apiKey) {
        res.status(400).json({
          success: false,
          error: 'api 模式需要提供 apiConfig.endpoint 和 apiConfig.apiKey',
        });
        return;
      }

      result = await watermarkRemover.removeByApi(
        imageUrl,
        apiConfig,
        outputFileName
      );
    }

    res.json({
      success: true,
      data: {
        outputPath: result.outputPath,
        method: result.method,
        originalSize: result.originalSize,
        outputSize: result.outputSize,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/image/download/:fileName
 * 删除下载的图片文件
 */
router.delete('/download/:fileName', async (req: Request, res: Response, next) => {
  try {
    const { fileName } = req.params;
    const filePath = `${config.tempDir}/${fileName}`;

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
