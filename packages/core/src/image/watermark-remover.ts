/**
 * 图片去水印模块
 * 支持多位置检测、裁剪去水印、像素修复(inpaint)、外部API去水印
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export interface CropOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface ApiConfig {
  endpoint: string;
  apiKey: string;
  headers?: Record<string, string>;
  bodyTransform?: (base64Image: string) => Record<string, unknown>;
  responseTransform?: (response: Record<string, unknown>) => string;
}

export interface WatermarkRemoveResult {
  outputPath: string;
  method: 'crop' | 'api' | 'inpaint';
  originalSize: number;
  outputSize: number;
}

/** 水印位置类型 */
export type WatermarkPosition = 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'center-overlay' | 'none';

/** 检测到的水印区域信息 */
export interface WatermarkRegion {
  position: WatermarkPosition;
  /** 裁剪/修复区域 */
  crop: CropOptions;
  /** 检测置信度 0-1 */
  confidence: number;
  /** 检测到的区域像素尺寸 */
  pixelSize: { width: number; height: number };
}

export class WatermarkRemover {
  private tempDir: string;

  constructor(options?: { tempDir?: string }) {
    this.tempDir = options?.tempDir || path.join(process.cwd(), 'tmp');

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 将图片转为 Base64
   */
  private async imageToBase64(imagePath: string): Promise<string> {
    const buffer = await fs.promises.readFile(imagePath);
    return buffer.toString('base64');
  }

  /**
   * 将 Base64 保存为图片
   */
  private async base64ToImage(base64Data: string, outputPath: string): Promise<void> {
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.promises.writeFile(outputPath, buffer);
  }

  /**
   * 下载远程图片到本地
   */
  private async downloadImage(imageUrl: string): Promise<string> {
    const url = imageUrl.replace(/^http:/, 'https:');
    const fileName = `wm_input_${Date.now()}.jpg`;
    const filePath = path.join(this.tempDir, fileName);

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
    });

    const writer = createWriteStream(filePath);
    await pipeline(response.data, writer);

    return filePath;
  }

  /**
   * 获取输入图片的本地路径
   */
  private async resolveInputPath(imageUrlOrPath: string): Promise<string> {
    if (imageUrlOrPath.startsWith('http://') || imageUrlOrPath.startsWith('https://')) {
      return this.downloadImage(imageUrlOrPath);
    }
    if (fs.existsSync(imageUrlOrPath)) {
      return imageUrlOrPath;
    }
    throw new Error('无效的图片路径或URL');
  }

  /**
   * 自动检测水印高度
   * 基于像素方差分析，从下往上扫描寻找水印边界
   */
  private async detectWatermarkHeight(
    imagePath: string,
    maxScanRatio: number = 0.15,
    minHeight: number = 5,
    maxCropRatio: number = 0.08
  ): Promise<number> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      throw new Error('自动检测水印需要安装 sharp 依赖');
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (width === 0 || height === 0) return 0;

    const maxCropHeight = Math.max(Math.floor(height * maxCropRatio), 30);
    const scanHeight = Math.min(Math.floor(height * maxScanRatio), 200);
    const startY = height - scanHeight;

    const { data, info } = await image
      .extract({ left: 0, top: startY, width, height: scanHeight })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bytesPerRow = width * channels;

    const calcRowStdDev = (row: number): number => {
      const rowStart = row * bytesPerRow;
      let rSum = 0, gSum = 0, bSum = 0;
      for (let x = 0; x < width; x++) {
        const idx = rowStart + x * channels;
        rSum += data[idx]; gSum += data[idx + 1]; bSum += data[idx + 2];
      }
      const rM = rSum / width, gM = gSum / width, bM = bSum / width;
      let v = 0;
      for (let x = 0; x < width; x++) {
        const idx = rowStart + x * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
      return Math.sqrt(v / (width * 3));
    };

    const calcRegionStdDev = (row: number, xStart: number, xEnd: number): number => {
      const rowStart = row * bytesPerRow;
      const n = xEnd - xStart;
      let rS = 0, gS = 0, bS = 0;
      for (let x = xStart; x < xEnd; x++) {
        const idx = rowStart + x * channels;
        rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
      }
      const rM = rS / n, gM = gS / n, bM = bS / n;
      let v = 0;
      for (let x = xStart; x < xEnd; x++) {
        const idx = rowStart + x * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
      return Math.sqrt(v / (n * 3));
    };

    const rowStdDevs: number[] = [];
    for (let row = 0; row < scanHeight; row++) {
      rowStdDevs.push(calcRowStdDev(row));
    }

    // 参考区域：扫描区域上半部分
    const refEnd = Math.floor(scanHeight * 0.5);
    let refSum = 0;
    for (let i = 0; i < refEnd; i++) refSum += rowStdDevs[i];
    const refStdDev = refSum / refEnd;
    if (refStdDev < 1) return 0;

    // Step 1: 检测底部纯色区域（stdDev < 10）
    let pureHeight = 0;
    for (let i = scanHeight - 1; i >= 0; i--) {
      if (rowStdDevs[i] < 10) pureHeight++;
      else break;
    }

    // Step 2: 从纯色区域上方，用差分突变找水印上边界
    if (pureHeight > 0) {
      const searchStart = scanHeight - 1 - pureHeight;
      let maxDiff = 0;
      let boundaryRow = -1;
      const win = 3;

      for (let i = searchStart; i >= win * 2; i--) {
        let below = 0, above = 0;
        for (let j = 0; j < win; j++) {
          below += rowStdDevs[i - j];
          above += rowStdDevs[i - win - j];
        }
        const diff = (above - below) / win;
        if (diff > maxDiff) {
          maxDiff = diff;
          boundaryRow = i - win;
        }
      }

      if (boundaryRow >= 0 && maxDiff > 3) {
        const total = Math.min(scanHeight - boundaryRow, maxCropHeight);
        return total >= minHeight ? total : 0;
      }

      const fallback = Math.min(pureHeight, maxCropHeight);
      return fallback >= minHeight ? fallback : 0;
    }

    // Step 3: 没有纯色底部，用左右对比检测
    const rightStart = Math.floor(width * 0.75);
    const leftEnd = Math.floor(width * 0.25);

    let watermarkTopRow = -1;
    for (let i = scanHeight - 1; i >= 3; i--) {
      const rightStd = calcRegionStdDev(i, rightStart, width);
      const leftStd = calcRegionStdDev(i, 0, leftEnd);
      const aboveRightStd = calcRegionStdDev(Math.max(i - 3, 0), rightStart, width);

      const dropRatio = rightStd / Math.max(aboveRightStd, 1);
      const lrRatio = rightStd / Math.max(leftStd, 1);

      if (dropRatio < 0.8 && lrRatio < 0.8) {
        watermarkTopRow = i;
        break;
      }
    }

    if (watermarkTopRow >= 0) {
      const total = Math.min(scanHeight - watermarkTopRow, maxCropHeight);
      return total >= minHeight ? total : 0;
    }

    // Step 4: 兜底 - 差分突变检测
    for (let i = scanHeight - 1; i >= 5; i--) {
      const below = (rowStdDevs[i] + rowStdDevs[i - 1] + rowStdDevs[i - 2]) / 3;
      const above = (rowStdDevs[i - 3] + rowStdDevs[i - 4] + rowStdDevs[i - 5]) / 3;
      if (above - below > 8 && below < refStdDev * 0.7) {
        const total = Math.min(scanHeight - i, maxCropHeight);
        return total >= minHeight ? total : 0;
      }
    }

    return 0;
  }

  /**
   * 多位置水印检测（统一入口）
   * 扫描图片四边 + 四角 + 中心区域，返回检测到的最佳水印区域
   */
  async detectWatermark(imagePath: string): Promise<WatermarkRegion> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      throw new Error('水印检测需要安装 sharp 依赖');
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (width === 0 || height === 0) {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    // 并行检测所有位置
    const [bottomResult, topResult, leftResult, rightResult] = await Promise.all([
      this.detectBottomWatermark(imagePath),
      this.detectTopWatermark(imagePath),
      this.detectLeftWatermark(imagePath),
      this.detectRightWatermark(imagePath),
    ]);

    const cornerResult = this.detectCornerWatermarks(bottomResult, topResult, leftResult, rightResult, width, height);
    const centerResult = await this.detectCenterOverlay(imagePath);

    // 收集所有有效检测结果，按置信度排序
    const candidates: WatermarkRegion[] = [
      bottomResult, topResult, leftResult, rightResult,
      ...cornerResult, centerResult,
    ].filter(r => r.position !== 'none' && r.confidence > 0);

    if (candidates.length === 0) {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0];
  }

  /** 检测底部水印 */
  private async detectBottomWatermark(imagePath: string): Promise<WatermarkRegion> {
    try {
      const h = await this.detectWatermarkHeight(imagePath);
      if (h <= 0) {
        return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
      let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
      const meta = await sharpInstance(imagePath).metadata();
      const w = meta.width || 0;
      const imgH = meta.height || 0;
      // 置信度：基于检测高度占图片比例，越大越可能是真实水印
      const confidence = Math.min(0.95, 0.6 + (h / imgH) * 5);
      return {
        position: 'bottom',
        crop: { bottom: h },
        confidence,
        pixelSize: { width: w, height: h },
      };
    } catch {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }
  }

  /** 检测顶部水印（与底部对称） */
  private async detectTopWatermark(imagePath: string): Promise<WatermarkRegion> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width === 0 || height === 0) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    const maxCropH = Math.max(Math.floor(height * 0.08), 30);
    const scanH = Math.min(Math.floor(height * 0.15), 200);

    const { data, info } = await image
      .extract({ left: 0, top: 0, width, height: scanH })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bpr = width * channels;

    const calcRowStdDev = (row: number): number => {
      const rs = row * bpr;
      let rS = 0, gS = 0, bS = 0;
      for (let x = 0; x < width; x++) {
        const idx = rs + x * channels;
        rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
      }
      const rM = rS / width, gM = gS / width, bM = bS / width;
      let v = 0;
      for (let x = 0; x < width; x++) {
        const idx = rs + x * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
      return Math.sqrt(v / (width * 3));
    };

    const rowStdDevs: number[] = [];
    for (let row = 0; row < scanH; row++) rowStdDevs.push(calcRowStdDev(row));

    // 参考区域：扫描区域下半部分
    const refStart = Math.floor(scanH * 0.5);
    let refSum = 0;
    for (let i = refStart; i < scanH; i++) refSum += rowStdDevs[i];
    const refStdDev = refSum / (scanH - refStart);
    if (refStdDev < 1) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    // Step 1: 检测顶部纯色区域
    let pureHeight = 0;
    for (let i = 0; i < scanH; i++) {
      if (rowStdDevs[i] < 10) pureHeight++;
      else break;
    }

    if (pureHeight > 0) {
      const searchStart = pureHeight;
      let maxDiff = 0;
      let boundaryRow = -1;
      const win = 3;
      for (let i = searchStart; i < scanH - win * 2; i++) {
        let below = 0, above = 0;
        for (let j = 0; j < win; j++) {
          above += rowStdDevs[i + j];
          below += rowStdDevs[i + win + j];
        }
        const diff = (below - above) / win;
        if (diff > maxDiff) { maxDiff = diff; boundaryRow = i + win; }
      }
      if (boundaryRow >= 0 && maxDiff > 3) {
        const total = Math.min(boundaryRow + 1, maxCropH);
        return total >= 5
          ? { position: 'top', crop: { top: total }, confidence: Math.min(0.9, 0.55 + total / height * 4), pixelSize: { width: width, height: total } }
          : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
      const fallback = Math.min(pureHeight, maxCropH);
      return fallback >= 5
        ? { position: 'top', crop: { top: fallback }, confidence: 0.5, pixelSize: { width: width, height: fallback } }
        : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    // Step 2: 左右对比检测
    const rightStart = Math.floor(width * 0.75);
    const leftEnd = Math.floor(width * 0.25);
    for (let i = 0; i < scanH - 3; i++) {
      const rightStd = this.calcColRegionStdDev(data, i, rightStart, width, channels, bpr);
      const leftStd = this.calcColRegionStdDev(data, i, 0, leftEnd, channels, bpr);
      const belowRightStd = this.calcColRegionStdDev(data, Math.min(i + 3, scanH - 1), rightStart, width, channels, bpr);
      const dropRatio = rightStd / Math.max(belowRightStd, 1);
      const lrRatio = rightStd / Math.max(leftStd, 1);
      if (dropRatio < 0.8 && lrRatio < 0.8) {
        const total = Math.min(i + 1, maxCropH);
        return total >= 5
          ? { position: 'top', crop: { top: total }, confidence: 0.6, pixelSize: { width: width, height: total } }
          : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
    }

    return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
  }

  /** 检测左侧水印 */
  private async detectLeftWatermark(imagePath: string): Promise<WatermarkRegion> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width === 0 || height === 0) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    const maxCropW = Math.max(Math.floor(width * 0.08), 30);
    const scanW = Math.min(Math.floor(width * 0.15), 200);

    const { data, info } = await image
      .extract({ left: 0, top: 0, width: scanW, height })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bpr = scanW * channels;

    const calcColStdDev = (col: number): number => {
      let rS = 0, gS = 0, bS = 0;
      for (let y = 0; y < height; y++) {
        const idx = y * bpr + col * channels;
        rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
      }
      const rM = rS / height, gM = gS / height, bM = bS / height;
      let v = 0;
      for (let y = 0; y < height; y++) {
        const idx = y * bpr + col * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
      return Math.sqrt(v / (height * 3));
    };

    const colStdDevs: number[] = [];
    for (let col = 0; col < scanW; col++) colStdDevs.push(calcColStdDev(col));

    const refEnd = Math.floor(scanW * 0.5);
    let refSum = 0;
    for (let i = 0; i < refEnd; i++) refSum += colStdDevs[i];
    const refStdDev = refSum / refEnd;
    if (refStdDev < 1) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    // 检测左侧纯色区域
    let pureWidth = 0;
    for (let i = 0; i < scanW; i++) {
      if (colStdDevs[i] < 10) pureWidth++;
      else break;
    }

    if (pureWidth > 0) {
      const searchStart = pureWidth;
      let maxDiff = 0;
      let boundaryCol = -1;
      const win = 3;
      for (let i = searchStart; i < scanW - win * 2; i++) {
        let rightVal = 0, leftVal = 0;
        for (let j = 0; j < win; j++) {
          rightVal += colStdDevs[i + j];
          leftVal += colStdDevs[i + win + j];
        }
        const diff = (rightVal - leftVal) / win;
        if (diff > maxDiff) { maxDiff = diff; boundaryCol = i + win; }
      }
      if (boundaryCol >= 0 && maxDiff > 3) {
        const total = Math.min(boundaryCol + 1, maxCropW);
        return total >= 5
          ? { position: 'left', crop: { left: total }, confidence: Math.min(0.85, 0.5 + total / width * 4), pixelSize: { width: total, height } }
          : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
      const fallback = Math.min(pureWidth, maxCropW);
      return fallback >= 5
        ? { position: 'left', crop: { left: fallback }, confidence: 0.45, pixelSize: { width: fallback, height } }
        : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    // 上下对比检测
    const bottomStart = Math.floor(height * 0.75);
    const topEnd = Math.floor(height * 0.25);
    for (let i = 0; i < scanW - 3; i++) {
      const bottomStd = this.calcRowRegionStdDevV(data, bottomStart, height, i, Math.min(i + 3, scanW - 1), channels, bpr);
      const topStd = this.calcRowRegionStdDevV(data, 0, topEnd, i, Math.min(i + 3, scanW - 1), channels, bpr);
      const rightBottomStd = this.calcRowRegionStdDevV(data, bottomStart, height, Math.min(i + 3, scanW - 1), Math.min(i + 6, scanW - 1), channels, bpr);
      const dropRatio = bottomStd / Math.max(rightBottomStd, 1);
      const tbRatio = bottomStd / Math.max(topStd, 1);
      if (dropRatio < 0.75 && tbRatio < 0.75) {
        const total = Math.min(i + 1, maxCropW);
        return total >= 5
          ? { position: 'left', crop: { left: total }, confidence: 0.55, pixelSize: { width: total, height } }
          : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
    }

    return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
  }

  /** 检测右侧水印（与左侧对称） */
  private async detectRightWatermark(imagePath: string): Promise<WatermarkRegion> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width === 0 || height === 0) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    const maxCropW = Math.max(Math.floor(width * 0.08), 30);
    const scanW = Math.min(Math.floor(width * 0.15), 200);
    const startX = width - scanW;

    const { data, info } = await image
      .extract({ left: startX, top: 0, width: scanW, height })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bpr = scanW * channels;

    const calcColStdDev = (col: number): number => {
      let rS = 0, gS = 0, bS = 0;
      for (let y = 0; y < height; y++) {
        const idx = y * bpr + col * channels;
        rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
      }
      const rM = rS / height, gM = gS / height, bM = bS / height;
      let v = 0;
      for (let y = 0; y < height; y++) {
        const idx = y * bpr + col * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
      return Math.sqrt(v / (height * 3));
    };

    const colStdDevs: number[] = [];
    for (let col = 0; col < scanW; col++) colStdDevs.push(calcColStdDev(col));

    const refStart = Math.floor(scanW * 0.5);
    let refSum = 0;
    for (let i = refStart; i < scanW; i++) refSum += colStdDevs[i];
    const refStdDev = refSum / (scanW - refStart);
    if (refStdDev < 1) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    // 从右向左检测纯色区域
    let pureWidth = 0;
    for (let i = scanW - 1; i >= 0; i--) {
      if (colStdDevs[i] < 10) pureWidth++;
      else break;
    }

    if (pureWidth > 0) {
      const searchStart = scanW - 1 - pureWidth;
      let maxDiff = 0;
      let boundaryCol = -1;
      const win = 3;
      for (let i = searchStart; i >= win * 2; i--) {
        let leftVal = 0, rightVal = 0;
        for (let j = 0; j < win; j++) {
          leftVal += colStdDevs[i - j];
          rightVal += colStdDevs[i - win - j];
        }
        const diff = (leftVal - rightVal) / win;
        if (diff > maxDiff) { maxDiff = diff; boundaryCol = i - win; }
      }
      if (boundaryCol >= 0 && maxDiff > 3) {
        const total = Math.min(scanW - boundaryCol, maxCropW);
        return total >= 5
          ? { position: 'right', crop: { right: total }, confidence: Math.min(0.85, 0.5 + total / width * 4), pixelSize: { width: total, height } }
          : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }
      const fallback = Math.min(pureWidth, maxCropW);
      return fallback >= 5
        ? { position: 'right', crop: { right: fallback }, confidence: 0.45, pixelSize: { width: fallback, height } }
        : { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
  }

  /** 基于边缘检测结果推断角部水印 */
  private detectCornerWatermarks(
    bottom: WatermarkRegion,
    top: WatermarkRegion,
    left: WatermarkRegion,
    right: WatermarkRegion,
    imgWidth: number,
    imgHeight: number
  ): WatermarkRegion[] {
    const results: WatermarkRegion[] = [];
    const cornerThreshold = 0.3; // 边缘检测有中等信号即可

    // 右下角：bottom + right 都有信号
    if (bottom.confidence > cornerThreshold && right.confidence > cornerThreshold) {
      const bw = bottom.pixelSize.width;
      const rh = right.pixelSize.height;
      results.push({
        position: 'bottom-right',
        crop: {
          bottom: bottom.crop.bottom || 0,
          right: right.crop.right || 0,
        },
        confidence: Math.min(bottom.confidence, right.confidence) * 0.9,
        pixelSize: { width: right.crop.right || 0, height: bottom.crop.bottom || 0 },
      });
    }
    // 左下角：bottom + left
    if (bottom.confidence > cornerThreshold && left.confidence > cornerThreshold) {
      results.push({
        position: 'bottom-left',
        crop: {
          bottom: bottom.crop.bottom || 0,
          left: left.crop.left || 0,
        },
        confidence: Math.min(bottom.confidence, left.confidence) * 0.9,
        pixelSize: { width: left.crop.left || 0, height: bottom.crop.bottom || 0 },
      });
    }
    // 右上角：top + right
    if (top.confidence > cornerThreshold && right.confidence > cornerThreshold) {
      results.push({
        position: 'top-right',
        crop: {
          top: top.crop.top || 0,
          right: right.crop.right || 0,
        },
        confidence: Math.min(top.confidence, right.confidence) * 0.85,
        pixelSize: { width: right.crop.right || 0, height: top.crop.top || 0 },
      });
    }
    // 左上角：top + left
    if (top.confidence > cornerThreshold && left.confidence > cornerThreshold) {
      results.push({
        position: 'top-left',
        crop: {
          top: top.crop.top || 0,
          left: left.crop.left || 0,
        },
        confidence: Math.min(top.confidence, left.confidence) * 0.85,
        pixelSize: { width: left.crop.left || 0, height: top.crop.top || 0 },
      });
    }
    return results;
  }

  /** 检测中心叠加水印（半透明/文字类） */
  private async detectCenterOverlay(imagePath: string): Promise<WatermarkRegion> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    const image = sharpInstance(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width === 0 || height === 0) return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };

    // 在中心区域采样，检测半透明均匀区域
    const marginX = Math.floor(width * 0.25);
    const marginY = Math.floor(height * 0.25);
    const sampleW = width - 2 * marginX;
    const sampleH = height - 2 * marginY;

    if (sampleW < 50 || sampleH < 50) {
      return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
    }

    const { data, info } = await image
      .extract({ left: marginX, top: marginY, width: sampleW, height: sampleH })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bpr = sampleW * channels;

    // 将采样区划分为网格，计算每个网格块的方差
    const gridSize = Math.min(Math.min(sampleW, sampleH) / 10, 40);
    const gridCols = Math.floor(sampleW / gridSize);
    const gridRows = Math.floor(sampleH / gridSize);

    const gridStdDevs: number[][] = [];
    for (let gr = 0; gr < gridRows; gr++) {
      gridStdDevs[gr] = [];
      for (let gc = 0; gc < gridCols; gc++) {
        const startR = Math.floor(gr * gridSize);
        const startC = Math.floor(gc * gridSize);
        const endR = Math.floor((gr + 1) * gridSize);
        const endC = Math.floor((gc + 1) * gridSize);
        let rS = 0, gS = 0, bS = 0, count = 0;
        for (let r = startR; r < endR; r++) {
          for (let c = startC; c < endC; c++) {
            const idx = r * bpr + c * channels;
            rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
            count++;
          }
        }
        const n = Math.max(count, 1);
        const rM = rS / n, gM = gS / n, bM = bS / n;
        let v = 0;
        for (let r = startR; r < endR; r++) {
          for (let c = startC; c < endC; c++) {
            const idx = r * bpr + c * channels;
            v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
          }
        }
        gridStdDevs[gr][gc] = Math.sqrt(v / (n * 3));
      }
    }

    // 计算整体参考方差
    let totalStdDev = 0;
    let gridCount = 0;
    for (let gr = 0; gr < gridRows; gr++)
      for (let gc = 0; gc < gridCols; gc++) { totalStdDev += gridStdDevs[gr][gc]; gridCount++; }
    const avgStdDev = totalStdDev / Math.max(gridCount, 1);

    // 寻找连续低方差区域（可能的水印）
    let lowVarCount = 0;
    const threshold = Math.max(avgStdDev * 0.5, 8);
    for (let gr = 0; gr < gridRows; gr++)
      for (let gc = 0; gc < gridCols; gc++)
        if (gridStdDevs[gr][gc] < threshold) lowVarCount++;

    const lowVarRatio = lowVarCount / Math.max(gridCount, 1);

    // 如果中心区域有大面积低方差但不是整图均匀，可能是叠加水印
    if (lowVarRatio > 0.15 && lowVarRatio < 0.7 && avgStdDev > 15) {
      // 找低方差区域的边界框
      let minGC = gridCols, maxGC = 0, minGR = gridRows, maxGR = 0;
      for (let gr = 0; gr < gridRows; gr++)
        for (let gc = 0; gc < gridCols; gc++)
          if (gridStdDevs[gr][gc] < threshold) {
            minGC = Math.min(minGC, gc); maxGC = Math.max(maxGC, gc);
            minGR = Math.min(minGR, gr); maxGR = Math.max(maxGR, gr);
          }

      const wmLeft = marginX + Math.floor(minGC * gridSize);
      const wmTop = marginY + Math.floor(minGR * gridSize);
      const wmRight = (width - marginX) - Math.floor((maxGC + 1) * gridSize);
      const wmBottom = (height - marginY) - Math.floor((maxGR + 1) * gridSize);

      return {
        position: 'center-overlay',
        crop: { top: wmTop, bottom: wmBottom, left: wmLeft, right: wmRight },
        confidence: Math.min(0.6, lowVarRatio * 0.8),
        pixelSize: { width: width - wmLeft - wmRight, height: height - wmTop - wmBottom },
      };
    }

    return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
  }

  /** 辅助：计算指定行内某列区域的 stdDev */
  private calcColRegionStdDev(
    data: Buffer, row: number, xStart: number, xEnd: number,
    channels: number, bytesPerRow: number
  ): number {
    const rowStart = row * bytesPerRow;
    const n = Math.max(xEnd - xStart, 1);
    let rS = 0, gS = 0, bS = 0;
    for (let x = xStart; x < xEnd; x++) {
      const idx = rowStart + x * channels;
      rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
    }
    const rM = rS / n, gM = gS / n, bM = bS / n;
    let v = 0;
    for (let x = xStart; x < xEnd; x++) {
      const idx = rowStart + x * channels;
      v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
    }
    return Math.sqrt(v / (n * 3));
  }

  /** 辅助：计算指定列内某行区域的 stdDev */
  private calcRowRegionStdDevV(
    data: Buffer, yStart: number, yEnd: number, xStart: number, xEnd: number,
    channels: number, bytesPerRow: number
  ): number {
    const n = Math.max((yEnd - yStart) * (xEnd - xStart), 1);
    let rS = 0, gS = 0, bS = 0;
    for (let y = yStart; y < yEnd; y++) {
      const rowStart = y * bytesPerRow;
      for (let x = xStart; x < xEnd; x++) {
        const idx = rowStart + x * channels;
        rS += data[idx]; gS += data[idx + 1]; bS += data[idx + 2];
      }
    }
    const rM = rS / n, gM = gS / n, bM = bS / n;
    let v = 0;
    for (let y = yStart; y < yEnd; y++) {
      const rowStart = y * bytesPerRow;
      for (let x = xStart; x < xEnd; x++) {
        const idx = rowStart + x * channels;
        v += (data[idx] - rM) ** 2 + (data[idx + 1] - gM) ** 2 + (data[idx + 2] - bM) ** 2;
      }
    }
    return Math.sqrt(v / (n * 3));
  }

  /**
   * 通过裁剪去除固定位置水印
   * 注意: 此方法需要安装 sharp 依赖
   */
  async removeByCrop(
    imageUrlOrPath: string,
    options: CropOptions,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      throw new Error('裁剪去水印需要安装 sharp 依赖，请运行: pnpm add sharp');
    }

    const inputPath = await this.resolveInputPath(imageUrlOrPath);
    const isTempInput = imageUrlOrPath.startsWith('http://') || imageUrlOrPath.startsWith('https://');

    try {
      const outputName = outputFileName || `wm_removed_${Date.now()}.jpg`;
      const outputPath = path.join(this.tempDir, outputName);

      const image = sharpInstance(inputPath);
      const metadata = await image.metadata();

      const width = metadata.width || 0;
      const height = metadata.height || 0;

      if (width === 0 || height === 0) {
        throw new Error('无法读取图片尺寸');
      }

      const left = options.left || 0;
      const top = options.top || 0;
      const right = options.right || 0;
      const bottom = options.bottom || 0;

      const cropWidth = width - left - right;
      const cropHeight = height - top - bottom;

      if (cropWidth <= 0 || cropHeight <= 0) {
        throw new Error('裁剪参数无效，裁剪后图片尺寸必须大于0');
      }

      await image
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .toFile(outputPath);

      const originalStats = fs.statSync(inputPath);
      const outputStats = fs.statSync(outputPath);

      // 清理临时下载的输入文件
      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }

      return {
        outputPath,
        method: 'crop',
        originalSize: originalStats.size,
        outputSize: outputStats.size,
      };
    } catch (error) {
      // 清理临时下载的输入文件
      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * 自动检测水印位置并裁剪去除
   * 支持检测任意位置水印（顶部/底部/左侧/右侧/四角）
   */
  async removeByAutoCrop(
    imageUrlOrPath: string,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult & { detectedRegion: WatermarkRegion }> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      throw new Error('自动裁剪去水印需要安装 sharp 依赖，请运行: pnpm add sharp');
    }

    const inputPath = await this.resolveInputPath(imageUrlOrPath);
    const isTempInput = imageUrlOrPath.startsWith('http://') || imageUrlOrPath.startsWith('https://');

    try {
      const image = sharpInstance(inputPath);
      const metadata = await image.metadata();

      const width = metadata.width || 0;
      const height = metadata.height || 0;

      if (width === 0 || height === 0) {
        throw new Error('无法读取图片尺寸');
      }

      // 使用多位置检测
      const region = await this.detectWatermark(inputPath);

      if (region.position === 'none' || region.confidence === 0) {
        throw new Error('未检测到水印区域，图片可能没有明显水印');
      }

      // 中心叠加水印不适合纯裁剪，提示用户使用 inpaint
      if (region.position === 'center-overlay') {
        throw new Error('检测到中心叠加水印，建议使用 removeByInpaint 或 removeBySmart 方法进行像素修复');
      }

      const outputName = outputFileName || `wm_auto_${Date.now()}.jpg`;
      const outputPath = path.join(this.tempDir, outputName);

      const cropLeft = region.crop.left || 0;
      const cropTop = region.crop.top || 0;
      const cropRight = region.crop.right || 0;
      const cropBottom = region.crop.bottom || 0;

      const cropWidth = width - cropLeft - cropRight;
      const cropHeight = height - cropTop - cropBottom;

      if (cropWidth <= 0 || cropHeight <= 0) {
        throw new Error('裁剪参数无效，裁剪后图片尺寸必须大于0');
      }

      await image
        .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
        .toFile(outputPath);

      const originalStats = fs.statSync(inputPath);
      const outputStats = fs.statSync(outputPath);

      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }

      return {
        outputPath,
        method: 'crop',
        originalSize: originalStats.size,
        outputSize: outputStats.size,
        detectedRegion: region,
      };
    } catch (error) {
      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * 通过像素修复去除水印（不裁剪，保留图片完整尺寸）
   * 支持任意位置水印：自动检测后对水印区域进行纹理修复
   */
  async removeByInpaint(
    imageUrlOrPath: string,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult & { repairedPixels: number; detectedRegion: WatermarkRegion }> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      throw new Error('像素修复去水印需要安装 sharp 依赖，请运行: pnpm add sharp');
    }

    const inputPath = await this.resolveInputPath(imageUrlOrPath);
    const isTempInput = imageUrlOrPath.startsWith('http://') || imageUrlOrPath.startsWith('https://');

    try {
      const image = sharpInstance(inputPath);
      const metadata = await image.metadata();

      const width = metadata.width || 0;
      const height = metadata.height || 0;

      if (width === 0 || height === 0) {
        throw new Error('无法读取图片尺寸');
      }

      // 使用多位置检测
      const region = await this.detectWatermark(inputPath);

      if (region.position === 'none' || region.confidence === 0) {
        throw new Error('未检测到水印区域，图片可能没有明显水印');
      }

      const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });

      const channels = info.channels;
      const bytesPerRow = width * channels;

      // 计算水印区域边界（支持任意位置）
      const wmTop = region.crop.top || 0;
      const wmBottom = region.crop.bottom || 0;
      const wmLeft = region.crop.left || 0;
      const wmRight = region.crop.right || 0;

      // 水印区域在原图中的像素坐标范围
      const wmStartRow = wmTop;
      const wmEndRow = height - wmBottom;
      const wmStartCol = wmLeft;
      const wmEndCol = width - wmRight;

      this.advancedInpaint(data, width, height, channels, bytesPerRow, wmStartRow, wmEndRow, wmStartCol, wmEndCol);

      const outputName = outputFileName || `wm_inpaint_${Date.now()}.jpg`;
      const outputPath = path.join(this.tempDir, outputName);

      const sharpMod = (await import('sharp')).default || (await import('sharp'));
      await sharpMod(Buffer.from(data), {
        raw: { width, height, channels: channels as 1 | 2 | 3 | 4 },
      })
        .jpeg({ quality: 95 })
        .toFile(outputPath);

      const originalStats = fs.statSync(inputPath);
      const outputStats = fs.statSync(outputPath);

      const repairedPixels = (wmEndRow - wmStartRow) * (wmEndCol - wmStartCol);

      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }

      return {
        outputPath,
        method: 'inpaint',
        originalSize: originalStats.size,
        outputSize: outputStats.size,
        repairedPixels,
        detectedRegion: region,
      };
    } catch (error) {
      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * 高级 inpaint 算法核心实现
   * 支持任意矩形水印区域: Patch匹配填充 -> 多方向纹理传播 -> 边缘感知细化 -> 双边滤波平滑
   */
  private advancedInpaint(
    data: Buffer,
    width: number,
    height: number,
    channels: number,
    bytesPerRow: number,
    wmStartRow: number,
    wmEndRow: number,
    wmStartCol: number,
    wmEndCol: number
  ): void {
    const wmHeight = wmEndRow - wmStartRow;
    const wmWidth = wmEndCol - wmStartCol;
    const patchSize = 8;
    const halfPatch = patchSize >> 1;

    // 边界安全检查
    if (wmHeight <= 0 || wmWidth <= 0) return;

    const px = (row: number, col: number, c: number) => (row * bytesPerRow + col * channels + c);

    const getPixel = (row: number, col: number, c: number): number => {
      if (row < 0 || row >= height || col < 0 || col >= width) return 128;
      return data[px(row, col, c)];
    };

    const clamp = (v: number) => Math.max(0, Math.min(255, v));

    /** 判断像素是否在水印区域内 */
    const isInWm = (r: number, c: number) =>
      r >= wmStartRow && r < wmEndRow && c >= wmStartCol && c < wmEndCol;

    /** 判断像素是否在非水印源区域（可用于采样） */
    const isSource = (r: number, c: number) =>
      r >= 0 && r < height && c >= 0 && c < width && !isInWm(r, c);

    const patchSSD = (r1: number, c1: number, r2: number, c2: number): number => {
      let sum = 0;
      let count = 0;
      for (let dr = -halfPatch; dr <= halfPatch; dr++) {
        for (let dc = -halfPatch; dc <= halfPatch; dc++) {
          const ar = r1 + dr, ac = c1 + dc;
          const br = r2 + dr, bc = c2 + dc;
          // 只比较双方都有效的像素（至少一方在图内）
          if (ar >= 0 && ar < height && ac >= 0 && ac < width &&
              br >= 0 && br < height && bc >= 0 && bc < width) {
            for (let ch = 0; ch < 3; ch++) {
              const diff = getPixel(ar, ac, ch) - getPixel(br, bc, ch);
              sum += diff * diff;
            }
            count++;
          }
        }
      }
      return count > 0 ? sum / count : Infinity;
    };

    // Phase 1: Patch 匹配填充 — 对水印区域的每个 patch，在非水印区域搜索最相似 patch
    const filled = new Float32Array(wmHeight * wmWidth * channels);

    // 确定搜索区域：优先从相邻的非水印区域搜索
    const searchAboveRows = wmStartRow;
    const searchBelowRows = height - wmEndRow;
    const searchLeftCols = wmStartCol;
    const searchRightCols = width - wmEndCol;

    for (let row = wmStartRow; row < wmEndRow; row += patchSize) {
      for (let col = wmStartCol; col < wmEndCol; col += patchSize) {
        const centerR = Math.min(row + halfPatch, wmEndRow - 1);
        const centerC = Math.min(col + halfPatch, wmEndCol - 1);

        let bestSSD = Infinity;
        let bestSR = centerR;
        let bestSC = centerC;

        // 搜索步长：根据图片大小自适应
        const step = Math.max(1, Math.floor(Math.max(searchAboveRows, searchBelowRows, 100) / 40));

        // 向上搜索（最优先）
        if (searchAboveRows > halfPatch) {
          const searchEnd = Math.max(halfPatch, wmStartRow - searchAboveRows);
          for (let sr = wmStartRow - 1; sr >= searchEnd; sr -= step) {
            const ssd = patchSSD(centerR, centerC, sr, centerC);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = centerC; }
          }
        }

        // 向下搜索
        if (searchBelowRows > halfPatch) {
          const searchStart = Math.min(height - halfPatch - 1, wmEndRow + searchBelowRows);
          for (let sr = wmEndRow; sr <= searchStart; sr += step) {
            const ssd = patchSSD(centerR, centerC, sr, centerC);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = centerC; }
          }
        }

        // 向左搜索
        if (searchLeftCols > halfPatch) {
          const searchEnd = Math.max(halfPatch, wmStartCol - searchLeftCols);
          for (let sc = wmStartCol - 1; sc >= searchEnd; sc -= step) {
            const ssd = patchSSD(centerR, centerC, centerR, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = centerR; bestSC = sc; }
          }
        }

        // 向右搜索
        if (searchRightCols > halfPatch) {
          const searchStart = Math.min(width - halfPatch - 1, wmEndCol + searchRightCols);
          for (let sc = wmEndCol; sc <= searchStart; sc += step) {
            const ssd = patchSSD(centerR, centerC, centerR, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = centerR; bestSC = sc; }
          }
        }

        // 局部精细搜索
        const localR1 = Math.max(0, bestSR - patchSize * 2);
        const localR2 = Math.min(height - 1, bestSR + patchSize * 2);
        const localC1 = Math.max(0, bestSC - patchSize * 2);
        const localC2 = Math.min(width - 1, bestSC + patchSize * 2);
        for (let sr = localR1; sr <= localR2; sr += Math.max(1, Math.floor(step / 2))) {
          for (let sc = localC1; sc <= localC2; sc += Math.max(1, Math.floor(step / 2))) {
            if (!isSource(sr, sc)) continue;
            const ssd = patchSSD(centerR, centerC, sr, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = sc; }
          }
        }

        // 填充结果到 filled buffer
        for (let dr = -halfPatch; dr <= halfPatch; dr++) {
          for (let dc = -halfPatch; dc <= halfPatch; dc++) {
            const tr = row + dr;
            const tc = col + dc;
            if (isInWm(tr, tc)) {
              const fi = (tr - wmStartRow) * wmWidth * channels + (tc - wmStartCol) * channels;
              for (let ch = 0; ch < channels; ch++) {
                filled[fi + ch] = getPixel(bestSR + dr, bestSC + dc, ch);
              }
            }
          }
        }
      }
    }

    // 填补未覆盖的像素（用最近邻）
    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const fi = (r - wmStartRow) * wmWidth * channels + (c - wmStartCol) * channels;
        let hasFilled = false;
        for (let ch = 0; ch < channels; ch++) {
          if (filled[fi + ch] > 0) { hasFilled = true; break; }
        }
        if (!hasFilled) {
          // 从四个方向找最近的非水印像素
          const candidates: [number, number][] = [];
          if (isSource(r - 1, c)) candidates.push([r - 1, c]);
          if (isSource(r + 1, c)) candidates.push([r + 1, c]);
          if (isSource(r, c - 1)) candidates.push([r, c - 1]);
          if (isSource(r, c + 1)) candidates.push([r, c + 1]);
          if (candidates.length > 0) {
            const [refR, refC] = candidates[0];
            for (let ch = 0; ch < channels; ch++) {
              filled[fi + ch] = data[px(refR, refC, ch)];
            }
          } else {
            for (let ch = 0; ch < channels; ch++) {
              filled[fi + ch] = 128;
            }
          }
        }
      }
    }

    // Phase 2: 多方向纹理传播 — 从所有非水印边界向中心加权融合
    const propagated = new Float32Array(wmHeight * wmWidth * channels);

    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const pi = (r - wmStartRow) * wmWidth * channels + (c - wmStartCol) * channels;
        let wSum = 0;
        const val = [0, 0, 0, 0];

        // 从上方边界传播
        if (wmStartRow > 0) {
          const dist = (r - wmStartRow + 1);
          const w = 1.0 / (dist * dist + 1);
          const srcR = wmStartRow - 1;
          for (let ch = 0; ch < channels; ch++) val[ch] += data[px(srcR, c, ch)] * w;
          wSum += w;
        }
        // 从下方边界传播
        if (wmEndRow < height) {
          const dist = (wmEndRow - r);
          const w = 1.0 / (dist * dist + 1);
          const srcR = wmEndRow;
          for (let ch = 0; ch < channels; ch++) val[ch] += data[px(srcR, c, ch)] * w;
          wSum += w;
        }
        // 从左边界传播
        if (c > wmStartCol) {
          const margin = c - wmStartCol;
          const w = 0.5 / (margin * margin + 1);
          const srcC = wmStartCol - 1;
          if (srcC >= 0) {
            for (let ch = 0; ch < channels; ch++) val[ch] += data[px(r, srcC, ch)] * w;
            wSum += w;
          }
        }
        // 从右边界传播
        if (c < wmEndCol - 1) {
          const margin = wmEndCol - 1 - c;
          const w = 0.5 / (margin * margin + 1);
          const srcC = wmEndCol;
          if (srcC < width) {
            for (let ch = 0; ch < channels; ch++) val[ch] += data[px(r, srcC, ch)] * w;
            wSum += w;
          }
        }

        // 融合 Patch 匹配结果
        const patchVal = [filled[pi], filled[pi + 1], filled[pi + 2], channels > 3 ? filled[pi + 3] : 0];
        const patchW = 1.5;
        for (let ch = 0; ch < channels; ch++) val[ch] += patchVal[ch] * patchW;
        wSum += patchW;

        for (let ch = 0; ch < channels; ch++) {
          propagated[pi + ch] = val[ch] / Math.max(wSum, 0.001);
        }
      }
    }

    // Phase 3: 边缘感知细化 — 检测边缘并沿边缘方向平滑
    const edgeRadius = 2;
    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol + edgeRadius; c < wmEndCol - edgeRadius; c++) {
        const pi = (r - wmStartRow) * wmWidth * channels + (c - wmStartCol) * channels;

        let leftGrad = 0, rightGrad = 0;
        for (let ch = 0; ch < 3; ch++) {
          const li = (r - wmStartRow) * wmWidth * channels + (c - edgeRadius - wmStartCol) * channels;
          const ri = (r - wmStartRow) * wmWidth * channels + (c + edgeRadius - wmStartCol) * channels;
          leftGrad += Math.abs(propagated[pi + ch] - propagated[li + ch]);
          rightGrad += Math.abs(propagated[pi + ch] - propagated[ri + ch]);
        }

        if (leftGrad + rightGrad > 30) {
          const edgeW = 0.3;
          const neighborAvg = (cSide: number) => {
            let sum = [0, 0, 0, 0];
            for (let dc = -1; dc <= 1; dc++) {
              const ni = (r - wmStartRow) * wmWidth * channels + (c + cSide + dc - wmStartCol) * channels;
              for (let ch = 0; ch < channels; ch++) sum[ch] += propagated[ni + ch];
            }
            return sum.map(v => v / 3);
          };
          const lAvg = leftGrad > rightGrad ? neighborAvg(-1) : neighborAvg(1);
          for (let ch = 0; ch < channels; ch++) {
            propagated[pi + ch] = propagated[pi + ch] * (1 - edgeW) + lAvg[ch] * edgeW;
          }
        }
      }
    }

    // Phase 4: 双边滤波后处理 — 平滑噪声同时保持边缘
    const spatialSigma = 2.0;
    const rangeSigma = 25.0;
    const radius = 2;
    const output = new Uint8Array(wmHeight * wmWidth * channels);

    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const pi = (r - wmStartRow) * wmWidth * channels + (c - wmStartCol) * channels;
        let wSum = 0;
        const val = [0.0, 0.0, 0.0, 0.0];
        const center = [propagated[pi], propagated[pi + 1], propagated[pi + 2], channels > 3 ? propagated[pi + 3] : 0];

        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const nr = r + dr, nc = c + dc;
            if (!isInWm(nr, nc)) continue;

            const ni = (nr - wmStartRow) * wmWidth * channels + (nc - wmStartCol) * channels;
            const neighbor = [propagated[ni], propagated[ni + 1], propagated[ni + 2], channels > 3 ? propagated[ni + 3] : 0];

            const spatialDist = Math.sqrt(dr * dr + dc * dc);
            const spatialW = Math.exp(-(spatialDist * spatialDist) / (2 * spatialSigma * spatialSigma));

            let rangeDist = 0;
            for (let ch = 0; ch < 3; ch++) rangeDist += (center[ch] - neighbor[ch]) ** 2;
            const rangeW = Math.exp(-rangeDist / (2 * rangeSigma * rangeSigma));

            const w = spatialW * rangeW;
            for (let ch = 0; ch < channels; ch++) val[ch] += neighbor[ch] * w;
            wSum += w;
          }
        }

        for (let ch = 0; ch < channels; ch++) {
          output[pi + ch] = clamp(Math.round(val[ch] / Math.max(wSum, 0.001)));
        }
      }
    }

    // 写回原始数据
    const wmRowBytes = wmWidth * channels;
    const wmColOffset = wmStartCol * channels;
    for (let r = wmStartRow; r < wmEndRow; r++) {
      const rowStart = r * bytesPerRow;
      const oi = (r - wmStartRow) * wmRowBytes;
      for (let x = 0; x < wmRowBytes; x++) {
        data[rowStart + wmColOffset + x] = output[oi + x];
      }
    }
  }

  /**
   * 智能去水印：自动检测水印位置并选择最佳去除方案
   * - 边缘水印(高置信度) → 裁剪（更快更干净）
   * - 角落/中心水印 → 像素修复（保留画面完整）
   */
  async removeBySmart(
    imageUrlOrPath: string,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult & { detectedRegion: WatermarkRegion; strategy: 'crop' | 'inpaint' }> {
    const region = await this.detectWatermark(
      await this.resolveInputPath(imageUrlOrPath)
    );

    if (region.position === 'none' || region.confidence === 0) {
      throw new Error('未检测到水印区域，图片可能没有明显水印');
    }

    // 策略选择逻辑
    const edgePositions: WatermarkPosition[] = ['top', 'bottom', 'left', 'right'];
    const cornerPositions: WatermarkPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

    let strategy: 'crop' | 'inpaint';
    if (edgePositions.includes(region.position) && region.confidence > 0.75) {
      strategy = 'crop';
    } else if (cornerPositions.includes(region.position)) {
      strategy = 'inpaint';
    } else if (region.position === 'center-overlay') {
      strategy = 'inpaint';
    } else {
      // 低置信度边缘水印也用 inpaint，避免误裁
      strategy = 'inpaint';
    }

    if (strategy === 'crop') {
      const result = await this.removeByAutoCrop(imageUrlOrPath, outputFileName);
      return {
        ...result,
        detectedRegion: result.detectedRegion,
        strategy: 'crop',
      };
    } else {
      const result = await this.removeByInpaint(imageUrlOrPath, outputFileName);
      return {
        ...result,
        detectedRegion: result.detectedRegion,
        strategy: 'inpaint',
      };
    }
  }

  /**
   * 通过外部API去除水印
   */
  async removeByApi(
    imageUrlOrPath: string,
    config: ApiConfig,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult> {
    const inputPath = await this.resolveInputPath(imageUrlOrPath);
    const isTempInput = imageUrlOrPath.startsWith('http://') || imageUrlOrPath.startsWith('https://');

    try {
      const base64Image = await this.imageToBase64(inputPath);
      const outputName = outputFileName || `wm_removed_${Date.now()}.jpg`;
      const outputPath = path.join(this.tempDir, outputName);

      const body = config.bodyTransform
        ? config.bodyTransform(base64Image)
        : { image: base64Image };

      const response = await axios.post(config.endpoint, body, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          ...config.headers,
        },
        timeout: 120000,
      });

      const resultData = config.responseTransform
        ? config.responseTransform(response.data as Record<string, unknown>)
        : (response.data as Record<string, unknown>).image as string;

      if (!resultData) {
        throw new Error('API 返回的数据中未找到处理后的图片');
      }

      await this.base64ToImage(resultData, outputPath);

      const originalStats = fs.statSync(inputPath);
      const outputStats = fs.statSync(outputPath);

      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }

      return {
        outputPath,
        method: 'api',
        originalSize: originalStats.size,
        outputSize: outputStats.size,
      };
    } catch (error) {
      if (isTempInput) {
        await fs.promises.unlink(inputPath).catch(() => {});
      }
      throw error;
    }
  }
}
