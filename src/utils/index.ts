/**
 * 工具函数模块
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 确保目录存在
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 生成唯一文件名
 */
export function generateFileName(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

/**
 * 安全地删除文件
 */
export async function safeDelete(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error(`删除文件失败: ${filePath}`, error);
  }
}

/**
 * 从环境变量加载配置
 */
export function loadConfig() {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    tempDir: process.env.TEMP_DIR || path.join(process.cwd(), 'tmp'),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    dashscope: {
      apiKey: process.env.DASHSCOPE_API_KEY || '',
      model: process.env.DASHSCOPE_MODEL || 'paraformer-v2',
    },
    douyin: {
      userAgent: process.env.DOUYIN_USER_AGENT || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1',
    },
  };
}
