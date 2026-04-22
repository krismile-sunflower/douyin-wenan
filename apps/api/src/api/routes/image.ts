import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
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

const upload = multer({
  dest: path.join(config.tempDir, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JPEG / PNG / WebP / GIF 格式'));
    }
  },
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
 * 支持多种模式:
 * 1. crop: 通过裁剪去除固定位置水印
 *    { imageUrl, mode: 'crop', options: { top: 0, bottom: 100, left: 0, right: 0 } }
 * 2. autoCrop: 自动检测水印位置并裁剪（支持顶部/底部/左侧/右侧/四角）
 *    { imageUrl, mode: 'autoCrop' }
 * 3. inpaint: 自动检测水印位置并像素修复（保留完整尺寸，支持任意位置）
 *    { imageUrl, mode: 'inpaint' }
 * 4. smart: 智能选择最佳去水印方案（自动检测 + 策略选择）
 *    { imageUrl, mode: 'smart' }
 * 5. api: 通过外部AI API去除水印
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

    const validModes = ['crop', 'autoCrop', 'inpaint', 'smart', 'api'];
    if (!mode || !validModes.includes(mode)) {
      res.status(400).json({
        success: false,
        error: `请指定有效的去水印模式: ${validModes.join(', ')}`,
      });
      return;
    }

    let result;
    const outputFileName = generateFileName('wm_removed', 'jpg');

    switch (mode) {
      case 'crop': {
        if (!options || typeof options !== 'object') {
          res.status(400).json({
            success: false,
            error: 'crop 模式需要提供 options 参数',
          });
          return;
        }
        result = await watermarkRemover.removeByCrop(imageUrl, options, outputFileName);
        break;
      }

      case 'autoCrop': {
        const autoResult = await watermarkRemover.removeByAutoCrop(imageUrl, outputFileName);
        result = {
          outputPath: autoResult.outputPath,
          method: autoResult.method,
          originalSize: autoResult.originalSize,
          outputSize: autoResult.outputSize,
          detectedRegion: autoResult.detectedRegion,
        };
        break;
      }

      case 'inpaint': {
        const inpaintResult = await watermarkRemover.removeByInpaint(imageUrl, outputFileName);
        result = {
          outputPath: inpaintResult.outputPath,
          method: inpaintResult.method,
          originalSize: inpaintResult.originalSize,
          outputSize: inpaintResult.outputSize,
          repairedPixels: inpaintResult.repairedPixels,
          detectedRegion: inpaintResult.detectedRegion,
        };
        break;
      }

      case 'smart': {
        const smartResult = await watermarkRemover.removeBySmart(imageUrl, outputFileName);
        result = {
          outputPath: smartResult.outputPath,
          method: smartResult.method,
          originalSize: smartResult.originalSize,
          outputSize: smartResult.outputSize,
          detectedRegion: smartResult.detectedRegion,
          strategy: smartResult.strategy,
        };
        break;
      }

      case 'api':
      default: {
        if (!apiConfig || !apiConfig.endpoint || !apiConfig.apiKey) {
          res.status(400).json({
            success: false,
            error: 'api 模式需要提供 apiConfig.endpoint 和 apiConfig.apiKey',
          });
          return;
        }
        result = await watermarkRemover.removeByApi(imageUrl, apiConfig, outputFileName);
        break;
      }
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/image/remove-watermark/upload
 * 上传图片文件去水印
 * Content-Type: multipart/form-data
 * 字段: file (图片文件), mode (可选, 默认 smart)
 */
router.post('/remove-watermark/upload', upload.single('file'), async (req: Request, res: Response, next) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: '请上传图片文件（字段名: file）' });
      return;
    }

    const mode = (req.body.mode as string) || 'smart';
    const validModes = ['smart', 'autoCrop', 'inpaint'];
    if (!validModes.includes(mode)) {
      res.status(400).json({ success: false, error: `mode 仅支持: ${validModes.join(', ')}` });
      return;
    }

    const outputFileName = generateFileName('wm_upload', 'jpg');
    let result;

    if (mode === 'autoCrop') {
      result = await watermarkRemover.removeByAutoCrop(uploadedPath!, outputFileName);
    } else if (mode === 'inpaint') {
      result = await watermarkRemover.removeByInpaint(uploadedPath!, outputFileName);
    } else {
      result = await watermarkRemover.removeBySmart(uploadedPath!, outputFileName);
    }

    res.json({
      success: true,
      data: {
        outputPath: result.outputPath,
        method: result.method,
        originalSize: result.originalSize,
        outputSize: result.outputSize,
        detectedRegion: (result as { detectedRegion?: unknown }).detectedRegion,
        strategy: (result as { strategy?: unknown }).strategy,
      },
    });
  } catch (error) {
    next(error);
  } finally {
    if (uploadedPath) safeDelete(uploadedPath).catch(() => {});
  }
});

/**
 * POST /api/image/remove-watermark/url
 * 通过图片链接去水印
 * Body: { imageUrl: string, mode?: 'smart' | 'autoCrop' | 'inpaint' }
 */
router.post('/remove-watermark/url', async (req: Request, res: Response, next) => {
  try {
    const { imageUrl, mode = 'smart' } = req.body;

    if (!imageUrl || typeof imageUrl !== 'string') {
      res.status(400).json({ success: false, error: '请提供有效的图片链接 imageUrl' });
      return;
    }

    const validModes = ['smart', 'autoCrop', 'inpaint'];
    if (!validModes.includes(mode)) {
      res.status(400).json({ success: false, error: `mode 仅支持: ${validModes.join(', ')}` });
      return;
    }

    const outputFileName = generateFileName('wm_url', 'jpg');
    let result;

    if (mode === 'autoCrop') {
      result = await watermarkRemover.removeByAutoCrop(imageUrl, outputFileName);
    } else if (mode === 'inpaint') {
      result = await watermarkRemover.removeByInpaint(imageUrl, outputFileName);
    } else {
      result = await watermarkRemover.removeBySmart(imageUrl, outputFileName);
    }

    res.json({
      success: true,
      data: {
        outputPath: result.outputPath,
        method: result.method,
        originalSize: result.originalSize,
        outputSize: result.outputSize,
        detectedRegion: (result as { detectedRegion?: unknown }).detectedRegion,
        strategy: (result as { strategy?: unknown }).strategy,
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
