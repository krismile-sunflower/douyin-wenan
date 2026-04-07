/**
 * FFmpeg 音频提取模块
 * 从视频文件中提取音频
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

export interface AudioExtractResult {
  audioPath: string;
  duration?: number;
  format: string;
}

export class AudioExtractor {
  private tempDir: string;
  private ffmpegPath: string;

  constructor(options?: { tempDir?: string; ffmpegPath?: string }) {
    this.tempDir = options?.tempDir || path.join(process.cwd(), 'tmp');
    this.ffmpegPath = options?.ffmpegPath || 'ffmpeg';

    // 确保临时目录存在
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 检查 FFmpeg 是否可用
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync(`"${this.ffmpegPath}" -version`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从视频文件中提取音频
   */
  async extract(videoPath: string, options?: { format?: string; outputName?: string }): Promise<AudioExtractResult> {
    const available = await this.checkAvailability();
    if (!available) {
      throw new Error('FFmpeg 未安装或不可用。请安装 FFmpeg: https://ffmpeg.org/download.html');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error(`视频文件不存在: ${videoPath}`);
    }

    const format = options?.format || 'mp3';
    const baseName = options?.outputName || path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(this.tempDir, `${baseName}.${format}`);

    // FFmpeg 命令: 提取音频
    const ffmpegArgs = [
      `-i "${videoPath}"`,
      '-vn', // 禁用视频
      '-acodec libmp3lame', // MP3 编码器
      '-ab 128k', // 比特率
      '-ar 44100', // 采样率
      '-y', // 覆盖输出
      `"${audioPath}"`,
    ].join(' ');

    try {
      await execAsync(`"${this.ffmpegPath}" ${ffmpegArgs}`);

      if (!fs.existsSync(audioPath)) {
        throw new Error('FFmpeg 执行成功但未生成音频文件');
      }

      const stats = fs.statSync(audioPath);
      if (stats.size === 0) {
        throw new Error('生成的音频文件为空');
      }

      return {
        audioPath,
        format,
      };
    } catch (error) {
      // 清理失败的文件
      try {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      } catch {
        // 忽略清理错误
      }

      const message = error instanceof Error ? error.message : '未知错误';
      throw new Error(`音频提取失败: ${message}`);
    }
  }

  /**
   * 获取音频时长 (秒)
   */
  async getDuration(audioPath: string): Promise<number> {
    const available = await this.checkAvailability();
    if (!available) {
      throw new Error('FFmpeg 未安装或不可用');
    }

    try {
      const { stdout } = await execAsync(
        `"${this.ffmpegPath}" -i "${audioPath}" 2>&1 | grep -oP 'Duration: \\K\\d+:\\d+:\\d+\\.\\d+' || true`
      );

      if (!stdout.trim()) {
        // 使用 ffprobe 作为备选
        const { stdout: probeOutput } = await execAsync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
        );
        return parseFloat(probeOutput.trim());
      }

      const [hours, minutes, seconds] = stdout.trim().split(':').map(Number);
      return hours * 3600 + minutes * 60 + seconds;
    } catch {
      return 0;
    }
  }

  /**
   * 清理临时音频文件
   */
  async cleanup(audioPath: string): Promise<void> {
    try {
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    } catch (error) {
      console.error(`清理文件失败: ${audioPath}`, error);
    }
  }
}
