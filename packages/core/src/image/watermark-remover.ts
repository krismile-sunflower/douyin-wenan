/**
 * 图片去水印模块
 * 支持裁剪去水印和外部API去水印
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
   * 基于像素方差分析，从下往上扫描寻找水印边界
   */
  async removeByAutoCrop(
    imageUrlOrPath: string,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult & { detectedHeight: number }> {
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

      const watermarkHeight = await this.detectWatermarkHeight(inputPath);

      if (watermarkHeight === 0) {
        throw new Error('未检测到水印区域，图片可能没有明显水印');
      }

      const outputName = outputFileName || `wm_auto_${Date.now()}.jpg`;
      const outputPath = path.join(this.tempDir, outputName);

      const cropHeight = height - watermarkHeight;

      await image
        .extract({ left: 0, top: 0, width, height: cropHeight })
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
        detectedHeight: watermarkHeight,
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
   * 升级版算法: 多方向纹理传播 + Patch匹配填充 + 边缘感知 + 后处理平滑
   */
  async removeByInpaint(
    imageUrlOrPath: string,
    outputFileName?: string
  ): Promise<WatermarkRemoveResult & { repairedPixels: number }> {
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

      const watermarkHeight = await this.detectWatermarkHeight(inputPath);

      if (watermarkHeight === 0) {
        throw new Error('未检测到水印区域，图片可能没有明显水印');
      }

      const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });

      const channels = info.channels;
      const bytesPerRow = width * channels;
      const wmStartRow = height - watermarkHeight;

      this.advancedInpaint(data, width, height, channels, bytesPerRow, wmStartRow);

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
        repairedPixels: width * watermarkHeight,
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
   * 分4个阶段: Patch匹配填充 -> 多方向纹理传播 -> 边缘感知细化 -> 双边滤波平滑
   */
  private advancedInpaint(
    data: Buffer,
    width: number,
    height: number,
    channels: number,
    bytesPerRow: number,
    wmStartRow: number
  ): void {
    const wmHeight = height - wmStartRow;
    const patchSize = 8;
    const halfPatch = patchSize >> 1;

    const px = (row: number, col: number, c: number) => (row * bytesPerRow + col * channels + c);

    const getPixel = (row: number, col: number, c: number): number => {
      if (row < 0 || row >= height || col < 0 || col >= width) return 128;
      return data[px(row, col, c)];
    };

    const clamp = (v: number) => Math.max(0, Math.min(255, v));

    const patchSSD = (r1: number, c1: number, r2: number, c2: number): number => {
      let sum = 0;
      for (let dr = -halfPatch; dr <= halfPatch; dr++) {
        for (let dc = -halfPatch; dc <= halfPatch; dc++) {
          for (let ch = 0; ch < 3; ch++) {
            const diff = getPixel(r1 + dr, c1 + dc, ch) - getPixel(r2 + dr, c2 + dc, ch);
            sum += diff * diff;
          }
        }
      }
      return sum;
    };

    // Phase 1: Patch 匹配填充 — 对水印区域的每个 patch，在上方搜索最相似的非水印 patch
    const filled = new Float32Array(wmHeight * width * channels);
    const searchRegionH = Math.min(wmStartRow, 120);

    for (let row = wmStartRow; row < height; row += patchSize) {
      for (let col = 0; col < width; col += patchSize) {
        const centerR = Math.min(row + halfPatch, height - 1);
        const centerC = Math.min(col + halfPatch, width - 1);

        let bestSSD = Infinity;
        let bestSR = wmStartRow - halfPatch;
        let bestSC = centerC;

        const searchStart = Math.max(halfPatch, wmStartRow - searchRegionH);
        const step = Math.max(1, Math.floor((wmStartRow - searchStart) / 40));

        for (let sr = wmStartRow - 1; sr >= searchStart; sr -= step) {
          const ssd = patchSSD(centerR, centerC, sr, centerC);
          if (ssd < bestSSD) {
            bestSSD = ssd;
            bestSR = sr;
          }
        }

        const localSearchR = Math.max(halfPatch, bestSR - patchSize * 2);
        const localSearchREnd = Math.min(wmStartRow - halfPatch, bestSR + patchSize * 2);
        for (let sr = localSearchR; sr <= localSearchREnd; sr++) {
          for (let sc = Math.max(halfPatch, centerC - patchSize * 2); sc <= Math.min(width - halfPatch - 1, centerC + patchSize * 2); sc++) {
            const ssd = patchSSD(centerR, centerC, sr, sc);
            if (ssd < bestSSD) {
              bestSSD = ssd;
              bestSR = sr;
              bestSC = sc;
            }
          }
        }

        for (let dr = -halfPatch; dr <= halfPatch; dr++) {
          for (let dc = -halfPatch; dc <= halfPatch; dc++) {
            const tr = row + dr;
            const tc = col + dc;
            if (tr >= wmStartRow && tr < height && tc >= 0 && tc < width) {
              const fi = (tr - wmStartRow) * width * channels + tc * channels;
              for (let ch = 0; ch < channels; ch++) {
                filled[fi + ch] = getPixel(bestSR + dr, bestSC + dc, ch);
              }
            }
          }
        }
      }
    }

    for (let r = wmStartRow; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const fi = (r - wmStartRow) * width * channels + c * channels;
        let hasFilled = false;
        for (let ch = 0; ch < channels; ch++) {
          if (filled[fi + ch] > 0) { hasFilled = true; break; }
        }
        if (!hasFilled) {
          const refR = Math.max(0, r - 1);
          for (let ch = 0; ch < channels; ch++) {
            filled[fi + ch] = data[px(refR, c, ch)];
          }
        }
      }
    }

    // Phase 2: 多方向纹理传播 — 从上/左/右边界向中心加权融合
    const propagated = new Float32Array(wmHeight * width * channels);
    const maxDist = wmHeight + width * 0.5;

    for (let r = wmStartRow; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const pi = (r - wmStartRow) * width * channels + c * channels;
        let wSum = 0;
        const val = [0, 0, 0, 0];

        const fromTop = () => {
          const dist = (r - wmStartRow + 1);
          const w = 1 / (dist * dist + 1);
          const srcR = Math.max(0, wmStartRow - 1);
          return { w, srcR, srcC: c };
        };
        const fromLeft = () => {
          const margin = Math.min(c, Math.floor(width * 0.15));
          if (margin < 3) return null;
          const dist = margin;
          const w = 0.5 / (dist * dist + 1);
          return { w, srcR: r, srcC: Math.max(0, c - margin - 1) };
        };
        const fromRight = () => {
          const margin = Math.min(width - 1 - c, Math.floor(width * 0.15));
          if (margin < 3) return null;
          const dist = margin;
          const w = 0.5 / (dist * dist + 1);
          return { w, srcR: r, srcC: Math.min(width - 1, c + margin + 1) };
        };

        const sources = [fromTop(), fromLeft(), fromRight()].filter(Boolean) as { w: number; srcR: number; srcC: number }[];

        for (const s of sources) {
          for (let ch = 0; ch < channels; ch++) {
            val[ch] += data[px(s.srcR, s.srcC, ch)] * s.w;
          }
          wSum += s.w;
        }

        const patchVal = [filled[pi], filled[pi + 1], filled[pi + 2], channels > 3 ? filled[pi + 3] : 0];
        const patchW = 1.5;

        for (let ch = 0; ch < channels; ch++) {
          val[ch] += patchVal[ch] * patchW;
        }
        wSum += patchW;

        for (let ch = 0; ch < channels; ch++) {
          propagated[pi + ch] = val[ch] / wSum;
        }
      }
    }

    // Phase 3: 边缘感知细化 — 检测水平边缘并沿边缘方向优先填充
    const edgeRadius = 2;
    for (let r = wmStartRow; r < height; r++) {
      for (let c = edgeRadius; c < width - edgeRadius; c++) {
        const pi = (r - wmStartRow) * width * channels + c * channels;

        let leftGrad = 0, rightGrad = 0;
        for (let ch = 0; ch < 3; ch++) {
          leftGrad += Math.abs(propagated[pi + ch] - propagated[(c - edgeRadius) * channels + ch]);
          rightGrad += Math.abs(propagated[pi + ch] - propagated[(c + edgeRadius) * channels + ch]);
        }

        if (leftGrad + rightGrad > 30) {
          const edgeW = 0.3;
          const neighborAvg = (cSide: number) => {
            let sum = [0, 0, 0, 0];
            for (let dc = -1; dc <= 1; dc++) {
              const ni = (r - wmStartRow) * width * channels + (c + cSide + dc) * channels;
              for (let ch = 0; ch < channels; ch++) {
                sum[ch] += propagated[ni + ch];
              }
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
    const output = new Uint8Array(wmHeight * width * channels);

    for (let r = wmStartRow; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const pi = (r - wmStartRow) * width * channels + c * channels;
        let wSum = 0;
        const val = [0.0, 0.0, 0.0, 0.0];
        const center = [propagated[pi], propagated[pi + 1], propagated[pi + 2], channels > 3 ? propagated[pi + 3] : 0];

        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr < wmStartRow || nr >= height || nc < 0 || nc >= width) continue;

            const ni = (nr - wmStartRow) * width * channels + nc * channels;
            const neighbor = [propagated[ni], propagated[ni + 1], propagated[ni + 2], channels > 3 ? propagated[ni + 3] : 0];

            const spatialDist = Math.sqrt(dr * dr + dc * dc);
            const spatialW = Math.exp(-(spatialDist * spatialDist) / (2 * spatialSigma * spatialSigma));

            let rangeDist = 0;
            for (let ch = 0; ch < 3; ch++) {
              rangeDist += (center[ch] - neighbor[ch]) ** 2;
            }
            const rangeW = Math.exp(-rangeDist / (2 * rangeSigma * rangeSigma));

            const w = spatialW * rangeW;
            for (let ch = 0; ch < channels; ch++) {
              val[ch] += neighbor[ch] * w;
            }
            wSum += w;
          }
        }

        for (let ch = 0; ch < channels; ch++) {
          output[pi + ch] = clamp(Math.round(val[ch] / Math.max(wSum, 0.001)));
        }
      }
    }

    // 写回原始数据
    for (let r = wmStartRow; r < height; r++) {
      const rowStart = r * bytesPerRow;
      const oi = (r - wmStartRow) * width * channels;
      for (let x = 0; x < width * channels; x++) {
        data[rowStart + x] = output[oi + x];
      }
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
