/**
 * 抖音分享链接解析模块
 * 处理各种格式的抖音分享链接，提取视频 ID
 */

import axios, { AxiosInstance } from 'axios';

export interface ParsedVideoInfo {
  videoId: string;
  originalUrl: string;
  redirectUrl: string;
}

export class DouyinParser {
  private client: AxiosInstance;
  private userAgent: string;

  constructor(userAgent?: string) {
    this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    this.client = axios.create({
      timeout: 15000,
      maxRedirects: 10,
      validateStatus: (status) => status < 400,
    });
  }

  /**
   * 标准化用户输入的链接
   * 支持格式:
   * - https://v.douyin.com/xxxxx/
   * - https://www.douyin.com/video/xxxxx
   * - 包含链接的分享文本
   */
  private normalizeInput(input: string): string {
    // 从分享文本中提取 URL
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = input.match(urlPattern);
    if (matches && matches.length > 0) {
      return matches[0];
    }
    return input.trim();
  }

  /**
   * 解析抖音分享链接
   */
  async parse(input: string): Promise<ParsedVideoInfo> {
    const url = this.normalizeInput(input);

    // 跟随短链重定向获取真实 URL
    const redirectUrl = await this.followRedirect(url);

    // 从 URL 中提取视频 ID
    const videoId = this.extractVideoId(redirectUrl);

    if (!videoId) {
      throw new Error(`无法从链接中提取视频 ID: ${redirectUrl}`);
    }

    return {
      videoId,
      originalUrl: url,
      redirectUrl,
    };
  }

  /**
   * 跟随 URL 重定向
   */
  private async followRedirect(url: string): Promise<string> {
    try {
      const response = await this.client.get(url, {
        headers: {
          'User-Agent': this.userAgent,
        },
      });

      // axios 默认跟随重定向，最终 URL 在 response.request 中
      if (response.request) {
        // Node.js http/https 模块
        const finalUrl = response.request.res?.responseUrl || response.config.url;
        return finalUrl || url;
      }
      return url;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        // 即使有错误响应，也尝试从 config 获取 URL
        return error.config?.url || url;
      }
      throw new Error(`链接解析失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 从抖音 URL 中提取视频 ID
   * 支持格式:
   * - https://www.douyin.com/video/7123456789012345678
   * - https://www.iesdouyin.com/share/video/7123456789012345678
   */
  private extractVideoId(url: string): string | null {
    // 匹配 /video/ 后面的数字 ID
    const patterns = [
      /\/video\/(\d+)/,
      /\/note\/(\d+)/,
      /video_id=(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }
}
