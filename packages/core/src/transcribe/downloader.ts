/**
 * 视频下载模块
 * 获取无水印视频 URL 并下载
 *
 * 参考: https://github.com/yzfly/douyin-mcp-server
 * 从 _ROUTER_DATA 中提取视频信息，通过 iesdouyin.com 获取
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export interface VideoDownloadResult {
  videoUrl: string;
  filePath: string;
  fileSize: number;
  title: string;
  videoId: string;
}

export interface VideoInfo {
  videoUrl: string;
  title: string;
  videoId: string;
}

// 移动端 UA (参考 douyin-mcp-server)
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1';

export class VideoDownloader {
  private client: AxiosInstance;
  private userAgent: string;
  private tempDir: string;

  constructor(options?: { userAgent?: string; tempDir?: string }) {
    this.userAgent = options?.userAgent || MOBILE_UA;
    this.tempDir = options?.tempDir || path.join(process.cwd(), 'tmp');
    this.client = axios.create({
      timeout: 60000,
      maxRedirects: 10,
      responseType: 'stream',
    });

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 从分享文本中提取 URL
   * 参考 douyin-mcp-server 的 parse_share_url 方法
   * 示例输入: "3.33 复制打开抖音，看看【徐大队的作品】# 包子手法 https://v.douyin.com/efvO2fplgMc/ z@g.oD Jic:/ 12/30"
   */
  private extractUrlFromShareText(shareText: string): string {
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = shareText.match(urlPattern);

    if (!matches || matches.length === 0) {
      throw new Error('未找到有效的分享链接，请确认输入包含抖音分享文本');
    }

    return matches[0];
  }

  /**
   * 获取抖音视频的无水印 URL 和基本信息
   * 参考 douyin-mcp-server 的 parse_share_url 方法
   * 支持输入: 完整分享文本 或 纯 URL
   */
  async getVideoInfo(shareText: string): Promise<VideoInfo> {
    // 步骤 0: 从分享文本中提取 URL
    const shareUrl = this.extractUrlFromShareText(shareText);

    // 步骤 1: 跟随短链重定向，提取 video_id
    const redirectResponse = await axios.get(shareUrl, {
      headers: { 'User-Agent': this.userAgent },
      maxRedirects: 10,
      validateStatus: (status) => status < 400,
    });

    const finalUrl = redirectResponse.request?.res?.responseUrl || shareUrl;
    const videoId = finalUrl.split('?')[0].split('/').filter(Boolean).pop() || '';

    if (!videoId) {
      throw new Error('无法从链接中提取视频 ID');
    }

    // 步骤 2: 通过 iesdouyin.com 获取视频信息
    const iesUrl = `https://www.iesdouyin.com/share/video/${videoId}`;

    const response = await axios.get(iesUrl, {
      headers: {
        'User-Agent': this.userAgent,
        'Referer': 'https://www.douyin.com/',
      },
      responseType: 'text',
      timeout: 15000,
    });

    const html = response.data as string;

    // 步骤 3: 从 _ROUTER_DATA 中提取视频信息
    const videoInfo = this.extractVideoInfoFromHtml(html, videoId);

    if (!videoInfo) {
      throw new Error('无法从页面中提取视频信息');
    }

    return videoInfo;
  }

  /**
   * 从 HTML 中提取视频信息
   * 参考 douyin-mcp-server 的 _ROUTER_DATA 解析逻辑
   */
  private extractVideoInfoFromHtml(html: string, fallbackVideoId: string): VideoInfo | null {
    try {
      // 从 _ROUTER_DATA 中提取
      const routerDataMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
      if (!routerDataMatch || !routerDataMatch[1]) {
        return null;
      }

      const jsonText = routerDataMatch[1].trim();
      const jsonData = JSON.parse(jsonText);

      const VIDEO_ID_PAGE_KEY = 'video_(id)/page';
      const NOTE_ID_PAGE_KEY = 'note_(id)/page';

      let originalVideoInfo: Record<string, unknown>;

      if (jsonData.loaderData?.[VIDEO_ID_PAGE_KEY]?.videoInfoRes) {
        originalVideoInfo = jsonData.loaderData[VIDEO_ID_PAGE_KEY].videoInfoRes as Record<string, unknown>;
      } else if (jsonData.loaderData?.[NOTE_ID_PAGE_KEY]?.videoInfoRes) {
        originalVideoInfo = jsonData.loaderData[NOTE_ID_PAGE_KEY].videoInfoRes as Record<string, unknown>;
      } else {
        return null;
      }

      const itemList = (originalVideoInfo as Record<string, unknown>)?.item_list as Record<string, unknown>[];
      if (!itemList || !itemList[0]) {
        return null;
      }

      const data = itemList[0] as Record<string, unknown>;
      const video = data.video as Record<string, unknown>;
      const playAddr = video?.play_addr as Record<string, unknown>;
      const urlList = playAddr?.url_list as string[];

      if (!urlList || !urlList[0]) {
        return null;
      }

      // 去水印: 将 playwm 替换为 play
      let videoUrl = urlList[0].replace('playwm', 'play');

      const desc = ((data.desc as string) || '').trim() || `douyin_${fallbackVideoId}`;

      return {
        videoUrl,
        title: desc.replace(/[\\/:*?"<>|]/g, '_'),
        videoId: fallbackVideoId,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取无水印视频 URL (仅 URL，不下载)
   */
  async getVideoUrl(shareUrl: string): Promise<string> {
    const info = await this.getVideoInfo(shareUrl);
    return info.videoUrl;
  }

  /**
   * 下载视频到本地
   */
  async download(videoUrl: string, fileName?: string): Promise<VideoDownloadResult> {
    const url = videoUrl.replace(/^http:/, 'https:');
    const safeFileName = fileName || `video_${Date.now()}.mp4`;
    const filePath = path.join(this.tempDir, safeFileName);

    try {
      const response = await this.client.get(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Referer': 'https://www.douyin.com/',
        },
      });

      const writer = createWriteStream(filePath);
      await pipeline(response.data, writer);

      const stats = fs.statSync(filePath);

      return {
        videoUrl: url,
        filePath,
        fileSize: stats.size,
        title: safeFileName,
        videoId: '',
      };
    } catch (error) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // 忽略清理错误
      }

      throw new Error(`视频下载失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 清理临时文件
   */
  async cleanup(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error(`清理文件失败: ${filePath}`, error);
    }
  }
}
