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
  /** 精确矩形区域（绝对像素坐标），优先于 crop 用于 inpaint */
  exactRect?: { left: number; top: number; right: number; bottom: number };
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
   * 自动检测水印高度（v2）
   * 亮度分析优先（适配抖音黑条/渐变条），stdDev 作为兜底
   */
  private async detectWatermarkHeight(
    imagePath: string,
    maxScanRatio: number = 0.20,
    minHeight: number = 5,
    maxCropRatio: number = 0.20
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

    const maxCropHeight = Math.floor(height * maxCropRatio);
    const scanHeight = Math.min(Math.floor(height * maxScanRatio), 300);
    const startY = height - scanHeight;

    const { data, info } = await image
      .extract({ left: 0, top: startY, width, height: scanHeight })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 3;
    const bytesPerRow = width * channels;

    const rowLuminance: number[] = [];
    const rowStdDev: number[] = [];
    for (let row = 0; row < scanHeight; row++) {
      let lumSum = 0;
      for (let x = 0; x < width; x++) {
        const idx = row * bytesPerRow + x * channels;
        lumSum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      }
      const lumMean = lumSum / width;
      rowLuminance.push(lumMean);
      let varSum = 0;
      for (let x = 0; x < width; x++) {
        const idx = row * bytesPerRow + x * channels;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        varSum += (lum - lumMean) ** 2;
      }
      rowStdDev.push(Math.sqrt(varSum / width));
    }

    // Method 1: 暗色条检测 — 从底部向上连续低亮度行（抖音黑条）
    const darkThresh = 80;
    let darkRows = 0;
    for (let i = scanHeight - 1; i >= 0; i--) {
      if (rowLuminance[i] < darkThresh) darkRows++;
      else break;
    }
    if (darkRows >= minHeight) {
      // 向上延伸：低亮度或低方差的渐变过渡行也纳入
      let topRow = scanHeight - darkRows;
      for (let i = topRow - 1; i >= Math.max(0, topRow - 20); i--) {
        if (rowLuminance[i] < 120 || rowStdDev[i] < 15) { darkRows++; topRow = i; }
        else break;
      }
      const total = Math.min(darkRows, maxCropHeight);
      if (total >= minHeight) return total;
    }

    // Method 2: 梯度跌落检测 — 亮度骤降后维持低位（渐变黑条）
    const win = 5;
    let bestDrop = 0, bestDropRow = -1;
    for (let i = win; i < scanHeight - win; i++) {
      let above = 0, below = 0;
      for (let j = 0; j < win; j++) { above += rowLuminance[i - j - 1]; below += rowLuminance[i + j]; }
      above /= win; below /= win;
      const drop = above - below;
      if (drop > bestDrop && below < 120) { bestDrop = drop; bestDropRow = i; }
    }
    if (bestDropRow >= 0 && bestDrop > 40) {
      const total = Math.min(scanHeight - bestDropRow, maxCropHeight);
      if (total >= minHeight) return total;
    }

    // Method 3: StdDev 兜底（文字/Logo 水印，低对比度区域）
    const refEnd = Math.floor(scanHeight * 0.5);
    let refSum = 0;
    for (let i = 0; i < refEnd; i++) refSum += rowStdDev[i];
    const refStdDev = refSum / refEnd;
    if (refStdDev < 1) return 0;

    let pureHeight = 0;
    for (let i = scanHeight - 1; i >= 0; i--) {
      if (rowStdDev[i] < 20) pureHeight++;
      else break;
    }
    if (pureHeight >= minHeight) {
      const total = Math.min(pureHeight, maxCropHeight);
      if (total >= minHeight) return total;
    }

    for (let i = scanHeight - 1; i >= 5; i--) {
      const below = (rowStdDev[i] + rowStdDev[i - 1] + rowStdDev[i - 2]) / 3;
      const above = (rowStdDev[i - 3] + rowStdDev[i - 4] + rowStdDev[i - 5]) / 3;
      if (above - below > 8 && below < refStdDev * 0.7) {
        const total = Math.min(scanHeight - i, maxCropHeight);
        if (total >= minHeight) return total;
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

    // 并行检测所有位置（包括直接角落检测）
    const [bottomResult, topResult, leftResult, rightResult, cornerLogoResults] = await Promise.all([
      this.detectBottomWatermark(imagePath),
      this.detectTopWatermark(imagePath),
      this.detectLeftWatermark(imagePath),
      this.detectRightWatermark(imagePath),
      this.detectCornerLogos(imagePath),
    ]);

    const cornerResult = this.detectCornerWatermarks(bottomResult, topResult, leftResult, rightResult, width, height);
    const centerResult = await this.detectCenterOverlay(imagePath);

    // 收集所有有效检测结果，按置信度排序
    const candidates: WatermarkRegion[] = [
      bottomResult, topResult, leftResult, rightResult,
      ...cornerResult, ...cornerLogoResults, centerResult,
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

  /**
   * 直接角落水印检测
   * 对4个角落（各取 max(12%, 80px) × max(12%, 80px) 区域）分析亮度/纹理特征。
   * 适配"AI生成"类半透明 logo pill 水印。
   * 检测策略：
   *   1. 计算角落区域的平均亮度与相邻非角落区域的对比
   *   2. 如果角落区域比周围更亮（白色 logo）或更低方差（半透明平滑 overlay），判定为水印
   *   3. 缩小到实际低方差/高亮度子区域，输出精确边界
   */
  private async detectCornerLogos(imagePath: string): Promise<WatermarkRegion[]> {
    let sharpInstance: ((input?: string | Buffer) => import('sharp').Sharp) | undefined;
    try {
      const sharpModule = await import('sharp');
      sharpInstance = (sharpModule as unknown as { default: (input?: string | Buffer) => import('sharp').Sharp }).default;
    } catch {
      return [];
    }

    const metadata = await sharpInstance(imagePath).metadata();
    const imgW = metadata.width || 0;
    const imgH = metadata.height || 0;
    if (imgW === 0 || imgH === 0) return [];

    // Strategy: scan the bottom-right and bottom-left corners (bottom 15%, each half)
    // for a badge-like overlay using a large tile approach:
    // Compare tile mean to the mean of the same columns above the tile.
    // Badge = darker than rows above it + area < 15% of image.
    const scanH = Math.max(Math.floor(imgH * 0.15), 100);
    const scanTop = imgH - scanH;
    // We need extra rows above the scan area as reference
    const refH = 40;
    const fullExtractTop = Math.max(0, scanTop - refH - 10);
    const fullExtractH = imgH - fullExtractTop;

    const { data, info } = await sharpInstance(imagePath)
      .extract({ left: 0, top: fullExtractTop, width: imgW, height: fullExtractH })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    // Offset: scan strip starts at (scanTop - fullExtractTop) within data
    const dataOffset = scanTop - fullExtractTop;
    const refOffset = dataOffset - refH - 5; // rows above scan strip used as reference

    // Mean luminance of a rectangle (row, col in extracted data coords)
    const rectMean = (left: number, top: number, w: number, h: number) => {
      let s = 0;
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const idx = ((top + dy) * imgW + (left + dx)) * ch;
          s += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        }
      }
      return s / (w * h);
    };

    // Tile parameters: look for large tiles (badge is ~90×180px)
    // Use tiles of several fixed sizes common for AI-generated badges
    const tileSizes: Array<[number, number]> = [
      [180, 90], [160, 80], [140, 70], [200, 100], [220, 90],
    ];
    const results: WatermarkRegion[] = [];

    // Only check bottom-right corner (TikTok "AI生成" badge is always there)
    const cornerXStart = Math.floor(imgW * 0.45);

    for (const [tW, tH] of tileSizes) {
      let bestScore = -1;
      let bestTx = -1, bestTy = -1;

      // Slide tile across bottom-right region
      for (let tx = cornerXStart; tx + tW <= imgW; tx += Math.max(10, Math.floor(tW * 0.2))) {
        for (let ty = dataOffset; ty + tH <= dataOffset + scanH; ty += Math.max(8, Math.floor(tH * 0.2))) {
          const tileMean = rectMean(tx, ty, tW, tH);
          const aboveMean = refOffset >= 0 ? rectMean(tx, refOffset, tW, refH) : tileMean + 30; // assume darker if no ref
          const diff = aboveMean - tileMean; // positive = tile is darker
          // Score: ratio of darkness difference, penalized by nothing (we accept any dark badge)
          const score = diff / 80.0;
          if (score > bestScore) {
            bestScore = score;
            bestTx = tx; bestTy = ty;
          }
        }
      }

      if (bestScore < 0.25 || bestTx < 0) continue; // diff must be at least 20px (0.25 * 80)

      // Convert to full image coordinates
      const fullTop = fullExtractTop + bestTy;
      const fullBottom = fullTop + tH;
      const fullLeft = bestTx;
      const fullRight = fullLeft + tW;

      // Sanity: badge area must be < 12% of image
      if (tW * tH > imgW * imgH * 0.12) continue;
      // Sanity: badge must not extend past image bounds
      if (fullBottom > imgH || fullRight > imgW) continue;

      const confidence = Math.min(0.88, 0.55 + bestScore * 0.8);
      // Extend the fill region to fully cover badge rounded-corner transition.
      // topPad: covers the fuzzy top edge of the badge.
      // leftPad: covers the fuzzy left edge; use ~25% of tile width for safety.
      const topPad  = Math.max(20, Math.floor(tH * 0.22));
      const leftPad = Math.max(30, Math.floor(tW * 0.25));
      results.push({
        position: 'bottom-right',
        crop: { top: 0, bottom: imgH - fullBottom, left: 0, right: imgW - fullRight },
        confidence,
        pixelSize: { width: tW, height: tH },
        exactRect: {
          left:   Math.max(0, fullLeft - leftPad),
          top:    Math.max(0, fullTop  - topPad),
          right:  imgW,
          bottom: imgH,
        },
      });
      break; // Use the first (largest) tile size that finds something
    }

    return results;
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

    // 提高阈值避免误检：要求 ≥35% 格子低方差且图像整体有明显纹理
    if (lowVarRatio > 0.35 && lowVarRatio < 0.65 && avgStdDev > 20) {
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

      // 仅当检测区域面积 < 图像面积的 40% 才认为是真实水印
      const detectedArea = (width - wmLeft - wmRight) * (height - wmTop - wmBottom);
      if (detectedArea > width * height * 0.40) {
        return { position: 'none', crop: {}, confidence: 0, pixelSize: { width: 0, height: 0 } };
      }

      return {
        position: 'center-overlay',
        crop: { top: wmTop, bottom: wmBottom, left: wmLeft, right: wmRight },
        confidence: Math.min(0.45, lowVarRatio * 0.7),
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
      // crop.top=N 表示水印在顶部，行范围 [0, N)，列范围全图
      // crop.bottom=N 表示水印在底部，行范围 [height-N, height)，列范围全图
      // crop.left=N 表示水印在左侧，列范围 [0, N)，行范围全图
      // crop.right=N 表示水印在右侧，列范围 [width-N, width)，行范围全图
      // 角落水印：多个方向同时有值，每个方向单独修复

      const inpaintRegions: [number, number, number, number][] = [];

      // If exactRect is provided, use gradient fill (better for corner badges on gradient background)
      if (region.exactRect) {
        const r = region.exactRect;
        this.gradientFillRegion(data, width, height, channels, r.left, r.top, r.right, r.bottom);
        const repairedPixels = (r.right - r.left) * (r.bottom - r.top);

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
      }

      if (wmTop > 0) inpaintRegions.push([0, wmTop, 0, width]);
      if (wmBottom > 0) inpaintRegions.push([height - wmBottom, height, 0, width]);
      if (wmLeft > 0) inpaintRegions.push([0, height, 0, wmLeft]);
      if (wmRight > 0) inpaintRegions.push([0, height, width - wmRight, width]);
      if (inpaintRegions.length === 0) {
        inpaintRegions.push([0, height, 0, width]);
      }

      for (const [sr, er, sc, ec] of inpaintRegions) {
        this.advancedInpaint(data, width, height, channels, bytesPerRow, sr, er, sc, ec);
      }

      const repairedPixels = inpaintRegions.reduce((sum, [sr, er, sc, ec]) => sum + (er - sr) * (ec - sc), 0);

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
   * 批处理 inpaint（大面积水印快速路径）
   * 以 patchSize 为步长处理块中心，减少 49 倍迭代量；
   * 使用修复后的 patchSSD（来源侧严格要求干净像素）+ 随机全局采样
   */
  private batchPatchInpaint(
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
    if (wmHeight <= 0 || wmWidth <= 0) return;

    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const px = (r: number, c: number, ch: number) => r * bytesPerRow + c * channels + ch;
    const isValid = (r: number, c: number) => r >= 0 && r < height && c >= 0 && c < width;
    const isWm = (r: number, c: number) =>
      r >= wmStartRow && r < wmEndRow && c >= wmStartCol && c < wmEndCol;

    const output = Buffer.from(data);
    const patchSize = 8;
    const halfPatch = Math.floor(patchSize / 2);

    const patchSSD = (r1: number, c1: number, r2: number, c2: number): number => {
      let sum = 0, count = 0;
      for (let dr = -halfPatch; dr <= halfPatch; dr++) {
        for (let dc = -halfPatch; dc <= halfPatch; dc++) {
          const ar = r1 + dr, ac = c1 + dc;
          const br = r2 + dr, bc = c2 + dc;
          if (!isValid(ar, ac) || !isValid(br, bc)) continue;
          if (isWm(br, bc)) continue;
          if (isWm(ar, ac)) continue;
          const d0 = data[px(ar, ac, 0)] - data[px(br, bc, 0)];
          const d1 = data[px(ar, ac, 1)] - data[px(br, bc, 1)];
          const d2 = data[px(ar, ac, 2)] - data[px(br, bc, 2)];
          sum += d0 * d0 + d1 * d1 + d2 * d2;
          count++;
        }
      }
      return count >= halfPatch ? sum / count : Infinity;
    };

    const sStep = Math.max(3, Math.floor(Math.sqrt(width * height) / 12));
    const srcPool: [number, number][] = [];
    for (let r = halfPatch; r < height - halfPatch; r += sStep) {
      for (let c = halfPatch; c < width - halfPatch; c += sStep) {
        if (!isWm(r, c)) srcPool.push([r, c]);
      }
    }
    for (let i = srcPool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [srcPool[i], srcPool[j]] = [srcPool[j], srcPool[i]];
    }
    const rndSample = srcPool.slice(0, 200);

    const sweepStep = Math.max(3, halfPatch);
    const sweepRange = Math.min(Math.max(wmHeight, wmWidth) + 100, 300);

    for (let row = wmStartRow; row < wmEndRow; row += patchSize) {
      for (let col = wmStartCol; col < wmEndCol; col += patchSize) {
        const cr = Math.min(row + halfPatch, wmEndRow - 1);
        const cc = Math.min(col + halfPatch, wmEndCol - 1);

        let bestSSD = Infinity, bestSR = -1, bestSC = -1;

        if (wmStartRow > halfPatch) {
          const from = Math.max(halfPatch, wmStartRow - sweepRange);
          for (let sr = wmStartRow - 1; sr >= from; sr -= sweepStep) {
            const ssd = patchSSD(cr, cc, sr, cc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = cc; }
          }
        }
        if (wmEndRow < height - halfPatch) {
          const to = Math.min(height - halfPatch - 1, wmEndRow + sweepRange);
          for (let sr = wmEndRow; sr <= to; sr += sweepStep) {
            const ssd = patchSSD(cr, cc, sr, cc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = cc; }
          }
        }
        if (wmStartCol > halfPatch) {
          const from = Math.max(halfPatch, wmStartCol - sweepRange);
          for (let sc = wmStartCol - 1; sc >= from; sc -= sweepStep) {
            const ssd = patchSSD(cr, cc, cr, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = cr; bestSC = sc; }
          }
        }
        if (wmEndCol < width - halfPatch) {
          const to = Math.min(width - halfPatch - 1, wmEndCol + sweepRange);
          for (let sc = wmEndCol; sc <= to; sc += sweepStep) {
            const ssd = patchSSD(cr, cc, cr, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = cr; bestSC = sc; }
          }
        }
        for (const [sr, sc] of rndSample) {
          const ssd = patchSSD(cr, cc, sr, sc);
          if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = sc; }
        }

        if (bestSR >= 0) {
          for (let dr = -halfPatch; dr <= halfPatch; dr++) {
            for (let dc = -halfPatch; dc <= halfPatch; dc++) {
              const tr = row + dr, tc = col + dc;
              if (!isWm(tr, tc) || !isValid(tr, tc)) continue;
              for (let ch = 0; ch < channels; ch++) {
                output[px(tr, tc, ch)] = data[px(bestSR + dr, bestSC + dc, ch)];
              }
            }
          }
        }
      }
    }

    // Bilateral filter on filled region (includes clean neighbors)
    const bfR = 2;
    const sSig2 = 2 * 2.0 * 2.0;
    const rSig2 = 2 * 25 * 25;
    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const cx0 = output[px(r, c, 0)], cx1 = output[px(r, c, 1)], cx2 = output[px(r, c, 2)];
        let wSum = 0; const val = [0, 0, 0, 0];
        for (let dr = -bfR; dr <= bfR; dr++) {
          for (let dc = -bfR; dc <= bfR; dc++) {
            const nr = r + dr, nc = c + dc;
            if (!isValid(nr, nc)) continue;
            const buf = isWm(nr, nc) ? output : data;
            const n0 = buf[px(nr, nc, 0)], n1 = buf[px(nr, nc, 1)], n2 = buf[px(nr, nc, 2)];
            const w = Math.exp(-((dr*dr+dc*dc)/sSig2) - (((cx0-n0)**2+(cx1-n1)**2+(cx2-n2)**2)/rSig2));
            val[0] += n0*w; val[1] += n1*w; val[2] += n2*w;
            if (channels > 3) val[3] += buf[px(nr, nc, 3)] * w;
            wSum += w;
          }
        }
        for (let ch = 0; ch < channels; ch++) {
          data[px(r, c, ch)] = clamp(val[ch] / Math.max(wSum, 1e-6));
        }
      }
    }
  }

  /**
   * 角落徽章 Laplace 调和填充
   *
   * 算法：
   *   1. 从填充区域上方/左方取多行/列均值作为参考（避开 badge 过渡色）
   *   2. 用仿射 tent 公式初始化（好的初值加速收敛）
   *   3. Gauss-Seidel 迭代求解离散 Laplace 方程：∇²u = 0
   *      - Dirichlet BC (上/左)：图像中 top-1 行、left-1 列（已是干净背景）
   *      - Neumann   BC (下/右)：零法向导数（镜像反射）
   *   → 结果是满足边界条件的最平滑填充，自然延伸背景渐变
   */
  private gradientFillRegion(
    data: Buffer,
    width: number,
    height: number,
    channels: number,
    left: number,
    top: number,
    right: number,
    bottom: number
  ): void {
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const fillH = bottom - top;
    const fillW = right - left;
    if (fillH <= 0 || fillW <= 0) return;

    // ── Multi-row reference (far above fill, clean background) ──────────────
    const REF_N    = 4;
    const refRowGap = Math.max(25, Math.floor(height * 0.03));
    const refRow0   = Math.max(0, top - refRowGap - REF_N);
    const refRow1   = Math.max(refRow0 + 1, top - refRowGap);
    const nRefRows  = refRow1 - refRow0;

    const topRef = new Float32Array(fillW * channels);
    for (let r = refRow0; r < refRow1 && r < height; r++) {
      for (let ci = 0; ci < fillW; ci++) {
        const si = (r * width + (left + ci)) * channels;
        for (let ch = 0; ch < channels; ch++) topRef[ci * channels + ch] += data[si + ch];
      }
    }
    for (let i = 0; i < topRef.length; i++) topRef[i] /= nRefRows;

    // ── Multi-col reference (far to the left, clean background) ─────────────
    const refColGap = Math.max(25, Math.floor(width * 0.03));
    const refCol0   = Math.max(0, left - refColGap - REF_N);
    const refCol1   = Math.max(refCol0 + 1, left - refColGap);
    const nRefCols  = refCol1 - refCol0;

    const leftRef = new Float32Array(fillH * channels);
    for (let c = refCol0; c < refCol1 && c < width; c++) {
      for (let ri = 0; ri < fillH; ri++) {
        const si = ((top + ri) * width + c) * channels;
        for (let ch = 0; ch < channels; ch++) leftRef[ri * channels + ch] += data[si + ch];
      }
    }
    for (let i = 0; i < leftRef.length; i++) leftRef[i] /= nRefCols;

    // Corner: mean of reference-row × reference-col overlap
    const cornerRef = new Float32Array(channels);
    let nCorner = 0;
    for (let r = refRow0; r < refRow1 && r < height; r++) {
      for (let c = refCol0; c < refCol1 && c < width; c++) {
        const si = (r * width + c) * channels;
        for (let ch = 0; ch < channels; ch++) cornerRef[ch] += data[si + ch];
        nCorner++;
      }
    }
    if (nCorner > 0) for (let ch = 0; ch < channels; ch++) cornerRef[ch] /= nCorner;

    // ── Init: affine tent (good starting point for Laplace) ──────────────────
    const buf = new Float32Array(fillH * fillW * channels);
    for (let ri = 0; ri < fillH; ri++) {
      for (let ci = 0; ci < fillW; ci++) {
        const bi = (ri * fillW + ci) * channels;
        for (let ch = 0; ch < channels; ch++) {
          buf[bi + ch] = topRef[ci * channels + ch] + leftRef[ri * channels + ch] - cornerRef[ch];
        }
      }
    }

    // ── Gauss-Seidel + SOR Laplace solver ──────────────────────────────────────
    // Dirichlet: row top-1 (north) and col left-1 (west) — already clean background
    // Neumann  : bottom and right — zero-gradient (index reflection)
    // SOR ω ≈ 1.9 drastically accelerates convergence vs plain Gauss-Seidel (ω=1),
    // especially for pixels far from the Dirichlet boundary (e.g. the far corner).
    const ITERS = 100;
    const SOR_W = 1.9;
    for (let iter = 0; iter < ITERS; iter++) {
      for (let ri = 0; ri < fillH; ri++) {
        const r = ri + top;
        for (let ci = 0; ci < fillW; ci++) {
          const c  = ci + left;
          const bi = (ri * fillW + ci) * channels;
          // Neumann reflection indices
          const riS = ri < fillH - 1 ? ri + 1 : (ri > 0 ? ri - 1 : 0);
          const ciE = ci < fillW - 1 ? ci + 1 : (ci > 0 ? ci - 1 : 0);

          for (let ch = 0; ch < channels; ch++) {
            // North: Dirichlet from image row top-1, or buf
            const N = ri > 0
              ? buf[((ri - 1) * fillW + ci) * channels + ch]
              : (top > 0 ? data[((top - 1) * width + c) * channels + ch]
                         : buf[(riS * fillW + ci) * channels + ch]);
            // South: Neumann reflection
            const S = buf[(riS * fillW + ci) * channels + ch];
            // West: Dirichlet from image col left-1, or buf
            const W = ci > 0
              ? buf[(ri * fillW + (ci - 1)) * channels + ch]
              : (left > 0 ? data[(r * width + (left - 1)) * channels + ch]
                          : buf[(ri * fillW + ciE) * channels + ch]);
            // East: Neumann reflection
            const E = buf[(ri * fillW + ciE) * channels + ch];

            const lap = (N + S + W + E) * 0.25;
            buf[bi + ch] = buf[bi + ch] + SOR_W * (lap - buf[bi + ch]);
          }
        }
      }
    }

    // ── Write back ──────────────────────────────────────────────────────────
    for (let ri = 0; ri < fillH; ri++) {
      for (let ci = 0; ci < fillW; ci++) {
        const bi = (ri * fillW + ci) * channels;
        const di = ((ri + top) * width + (ci + left)) * channels;
        for (let ch = 0; ch < channels; ch++) {
          data[di + ch] = clamp(buf[bi + ch]);
        }
      }
    }
  }

  /**
   * 高级 inpaint 算法核心实现（v2）
   * 改进：BFS 边界优先填充 + 修复 patchSSD（屏蔽未填充水印像素）
   *       + 精细步长搜索 + 随机全局采样 + 边界渐变融合 + 改进双边滤波
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
    if (wmHeight <= 0 || wmWidth <= 0) return;

    // 大面积水印区域使用 Patch 块批处理（速度优先）；小区域使用逐像素 BFS（质量优先）
    const wmArea = wmHeight * wmWidth;
    if (wmArea > 80000) {
      this.batchPatchInpaint(data, width, height, channels, bytesPerRow, wmStartRow, wmEndRow, wmStartCol, wmEndCol);
      return;
    }

    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const px = (r: number, c: number, ch: number) => r * bytesPerRow + c * channels + ch;
    const isValid = (r: number, c: number) => r >= 0 && r < height && c >= 0 && c < width;
    const isWm = (r: number, c: number) =>
      r >= wmStartRow && r < wmEndRow && c >= wmStartCol && c < wmEndCol;
    const wmIdx = (r: number, c: number) => (r - wmStartRow) * wmWidth + (c - wmStartCol);

    // 工作副本 — BFS 阶段填充后的像素写入此处
    const output = Buffer.from(data);
    // 布尔标记：此水印像素是否已被填充（修复 value>0 误判黑色像素的 bug）
    const isFilled = new Uint8Array(wmHeight * wmWidth);

    const patchSize = 7;
    const halfPatch = Math.floor(patchSize / 2);

    // --- patchSSD（修复核心 bug）---
    // 仅比较"双方都合法"的像素对：
    //   查询侧 (ar, ac): 干净像素 OR 已填充水印像素
    //   来源侧 (br, bc): 必须是干净像素（不在水印区）
    const patchSSD = (r1: number, c1: number, r2: number, c2: number): number => {
      let sum = 0, count = 0;
      for (let dr = -halfPatch; dr <= halfPatch; dr++) {
        for (let dc = -halfPatch; dc <= halfPatch; dc++) {
          const ar = r1 + dr, ac = c1 + dc;
          const br = r2 + dr, bc = c2 + dc;
          if (!isValid(ar, ac) || !isValid(br, bc)) continue;
          if (isWm(br, bc)) continue;
          if (isWm(ar, ac) && !isFilled[wmIdx(ar, ac)]) continue;
          const a0 = isWm(ar, ac) ? output[px(ar, ac, 0)] : data[px(ar, ac, 0)];
          const a1 = isWm(ar, ac) ? output[px(ar, ac, 1)] : data[px(ar, ac, 1)];
          const a2 = isWm(ar, ac) ? output[px(ar, ac, 2)] : data[px(ar, ac, 2)];
          const d0 = a0 - data[px(br, bc, 0)];
          const d1 = a1 - data[px(br, bc, 1)];
          const d2 = a2 - data[px(br, bc, 2)];
          sum += d0 * d0 + d1 * d1 + d2 * d2;
          count++;
        }
      }
      return count >= halfPatch ? sum / count : Infinity;
    };

    // --- BFS 填充顺序：从边界向内（边界优先，防止错误传播）---
    const fillOrder: [number, number][] = [];
    const visited = new Uint8Array(wmHeight * wmWidth);
    const bfsQueue: [number, number][] = [];
    const dirs4: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const wi = wmIdx(r, c);
        if (visited[wi]) continue;
        for (const [dr, dc] of dirs4) {
          const nr = r + dr, nc = c + dc;
          if (isValid(nr, nc) && !isWm(nr, nc)) {
            visited[wi] = 1;
            bfsQueue.push([r, c]);
            break;
          }
        }
      }
    }
    let head = 0;
    while (head < bfsQueue.length) {
      const [r, c] = bfsQueue[head++];
      fillOrder.push([r, c]);
      for (const [dr, dc] of dirs4) {
        const nr = r + dr, nc = c + dc;
        if (isWm(nr, nc)) {
          const wi = wmIdx(nr, nc);
          if (!visited[wi]) { visited[wi] = 1; bfsQueue.push([nr, nc]); }
        }
      }
    }

    // --- 全局随机采样候选源像素 ---
    const sStep = Math.max(3, Math.floor(Math.sqrt(width * height) / 15));
    const srcPool: [number, number][] = [];
    for (let r = halfPatch; r < height - halfPatch; r += sStep) {
      for (let c = halfPatch; c < width - halfPatch; c += sStep) {
        if (!isWm(r, c)) srcPool.push([r, c]);
      }
    }
    for (let i = srcPool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [srcPool[i], srcPool[j]] = [srcPool[j], srcPool[i]];
    }
    const rndSample = srcPool.slice(0, 300);

    const sweepStep = Math.max(2, halfPatch);
    const sweepRange = Math.min(Math.max(wmHeight, wmWidth) * 2 + 50, 200);

    // --- 按 BFS 顺序逐像素填充 ---
    for (const [r, c] of fillOrder) {
      let bestSSD = Infinity, bestSR = -1, bestSC = -1;

      // 四方向扫描：从水印各边界向外搜索
      if (wmStartRow > halfPatch) {
        const from = Math.max(halfPatch, wmStartRow - sweepRange);
        const fc = Math.min(Math.max(c, halfPatch), width - halfPatch - 1);
        for (let sr = wmStartRow - 1; sr >= from; sr -= sweepStep) {
          const ssd = patchSSD(r, c, sr, fc);
          if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = fc; }
        }
      }
      if (wmEndRow < height - halfPatch) {
        const to = Math.min(height - halfPatch - 1, wmEndRow + sweepRange);
        const fc = Math.min(Math.max(c, halfPatch), width - halfPatch - 1);
        for (let sr = wmEndRow; sr <= to; sr += sweepStep) {
          const ssd = patchSSD(r, c, sr, fc);
          if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = fc; }
        }
      }
      if (wmStartCol > halfPatch) {
        const from = Math.max(halfPatch, wmStartCol - sweepRange);
        const fr = Math.min(Math.max(r, halfPatch), height - halfPatch - 1);
        for (let sc = wmStartCol - 1; sc >= from; sc -= sweepStep) {
          const ssd = patchSSD(r, c, fr, sc);
          if (ssd < bestSSD) { bestSSD = ssd; bestSR = fr; bestSC = sc; }
        }
      }
      if (wmEndCol < width - halfPatch) {
        const to = Math.min(width - halfPatch - 1, wmEndCol + sweepRange);
        const fr = Math.min(Math.max(r, halfPatch), height - halfPatch - 1);
        for (let sc = wmEndCol; sc <= to; sc += sweepStep) {
          const ssd = patchSSD(r, c, fr, sc);
          if (ssd < bestSSD) { bestSSD = ssd; bestSR = fr; bestSC = sc; }
        }
      }

      // 全局随机采样
      for (const [sr, sc] of rndSample) {
        const ssd = patchSSD(r, c, sr, sc);
        if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = sc; }
      }

      // 最优候选局部精细搜索
      if (bestSR >= 0) {
        const lr1 = Math.max(halfPatch, bestSR - patchSize);
        const lr2 = Math.min(height - halfPatch - 1, bestSR + patchSize);
        const lc1 = Math.max(halfPatch, bestSC - patchSize);
        const lc2 = Math.min(width - halfPatch - 1, bestSC + patchSize);
        for (let sr = lr1; sr <= lr2; sr++) {
          for (let sc = lc1; sc <= lc2; sc++) {
            if (isWm(sr, sc)) continue;
            const ssd = patchSSD(r, c, sr, sc);
            if (ssd < bestSSD) { bestSSD = ssd; bestSR = sr; bestSC = sc; }
          }
        }
      }

      if (bestSR >= 0) {
        for (let ch = 0; ch < channels; ch++) output[px(r, c, ch)] = data[px(bestSR, bestSC, ch)];
      } else {
        // 兜底：已填充/干净邻居的均值
        const vSum = [0, 0, 0, 0]; let cnt = 0;
        const dirs8: [number, number][] = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
        for (const [dr, dc] of dirs8) {
          const nr = r + dr, nc = c + dc;
          if (!isValid(nr, nc)) continue;
          if (isWm(nr, nc) && !isFilled[wmIdx(nr, nc)]) continue;
          for (let ch = 0; ch < channels; ch++) vSum[ch] += output[px(nr, nc, ch)];
          cnt++;
        }
        if (cnt > 0) {
          for (let ch = 0; ch < channels; ch++) output[px(r, c, ch)] = clamp(vSum[ch] / cnt);
        }
      }
      isFilled[wmIdx(r, c)] = 1;
    }

    // --- 边界渐变融合：消除填充区与原图的硬接缝 ---
    const blendR = 4;
    const blended = Buffer.from(output);
    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const distEdge = Math.min(
          r - wmStartRow, wmEndRow - 1 - r,
          c - wmStartCol, wmEndCol - 1 - c
        );
        if (distEdge >= blendR) continue;
        const alpha = distEdge / blendR;
        let cSum = [0, 0, 0, 0]; let cCnt = 0;
        for (let dr = -blendR; dr <= blendR; dr++) {
          for (let dc = -blendR; dc <= blendR; dc++) {
            const nr = r + dr, nc = c + dc;
            if (!isValid(nr, nc) || isWm(nr, nc)) continue;
            for (let ch = 0; ch < channels; ch++) cSum[ch] += data[px(nr, nc, ch)];
            cCnt++;
          }
        }
        for (let ch = 0; ch < channels; ch++) {
          const f = output[px(r, c, ch)];
          const cl = cCnt > 0 ? cSum[ch] / cCnt : f;
          blended[px(r, c, ch)] = clamp(f * alpha + cl * (1 - alpha));
        }
      }
    }

    // --- 双边滤波（包含干净邻居，消除接缝噪声）---
    const bfR = 3;
    const sSig2 = 2 * 2.5 * 2.5;
    const rSig2 = 2 * 30 * 30;
    for (let r = wmStartRow; r < wmEndRow; r++) {
      for (let c = wmStartCol; c < wmEndCol; c++) {
        const cx0 = blended[px(r, c, 0)], cx1 = blended[px(r, c, 1)], cx2 = blended[px(r, c, 2)];
        let wSum = 0; const val = [0, 0, 0, 0];
        for (let dr = -bfR; dr <= bfR; dr++) {
          for (let dc = -bfR; dc <= bfR; dc++) {
            const nr = r + dr, nc = c + dc;
            if (!isValid(nr, nc)) continue;
            const buf = isWm(nr, nc) ? blended : data;
            const n0 = buf[px(nr, nc, 0)], n1 = buf[px(nr, nc, 1)], n2 = buf[px(nr, nc, 2)];
            const sDist = dr * dr + dc * dc;
            const rDist = (cx0 - n0) ** 2 + (cx1 - n1) ** 2 + (cx2 - n2) ** 2;
            const w = Math.exp(-sDist / sSig2 - rDist / rSig2);
            val[0] += n0 * w; val[1] += n1 * w; val[2] += n2 * w;
            if (channels > 3) val[3] += buf[px(nr, nc, 3)] * w;
            wSum += w;
          }
        }
        for (let ch = 0; ch < channels; ch++) {
          data[px(r, c, ch)] = clamp(val[ch] / Math.max(wSum, 1e-6));
        }
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
