/**
 * 图片服务模块
 * 支持抖音图集解析下载、图片去水印
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export interface AlbumImage {
  url: string;
  width: number;
  height: number;
}

export interface AlbumInfo {
  albumId: string;
  title: string;
  images: AlbumImage[];
  imageCount: number;
}

export interface ImageDownloadResult {
  imageUrl: string;
  filePath: string;
  fileSize: number;
  width: number;
  height: number;
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1';

export class ImageService {
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
   * 获取抖音图集的无水印图片信息
   * 支持输入: 完整分享文本 或 纯 URL
   */
  async getAlbumInfo(shareText: string): Promise<AlbumInfo> {
    const shareUrl = this.extractUrlFromShareText(shareText);

    const redirectResponse = await axios.get(shareUrl, {
      headers: { 'User-Agent': this.userAgent },
      maxRedirects: 10,
      validateStatus: (status) => status < 400,
    });

    const finalUrl = redirectResponse.request?.res?.responseUrl || shareUrl;
    const albumId = finalUrl.split('?')[0].split('/').filter(Boolean).pop() || '';

    if (!albumId) {
      throw new Error('无法从链接中提取图集 ID');
    }

    const iesUrl = `https://www.iesdouyin.com/share/video/${albumId}`;

    const response = await axios.get(iesUrl, {
      headers: {
        'User-Agent': this.userAgent,
        'Referer': 'https://www.douyin.com/',
      },
      responseType: 'text',
      timeout: 15000,
    });

    const html = response.data as string;
    const albumInfo = this.extractAlbumInfoFromHtml(html, albumId);

    if (!albumInfo) {
      throw new Error('无法从页面中提取图集信息');
    }

    return albumInfo;
  }

  /**
   * 从 HTML 中提取图集信息
   */
  private extractAlbumInfoFromHtml(html: string, fallbackAlbumId: string): AlbumInfo | null {
    try {
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
      const images = data.images as Record<string, unknown>[];

      if (!images || images.length === 0) {
        // 尝试解析视频封面作为单张图片
        const video = data.video as Record<string, unknown>;
        const cover = video?.cover as Record<string, unknown>;
        const urlList = cover?.url_list as string[];

        if (urlList && urlList[0]) {
          const desc = ((data.desc as string) || '').trim() || `douyin_${fallbackAlbumId}`;
          return {
            albumId: fallbackAlbumId,
            title: desc.replace(/[\\/:*?"<>|]/g, '_'),
            images: [{
              url: urlList[0],
              width: (cover.width as number) || 0,
              height: (cover.height as number) || 0,
            }],
            imageCount: 1,
          };
        }
        return null;
      }

      const albumImages: AlbumImage[] = images.map((img) => {
        const urlList = (img.url_list as string[]) || [];
        // 去水印: 使用无水印链接
        let url = urlList[0] || '';
        if (url) {
          url = url.replace(/~tplv-[^/]+/, '~tplv-ow360noawqhd');
        }
        return {
          url,
          width: (img.width as number) || 0,
          height: (img.height as number) || 0,
        };
      }).filter((img) => img.url);

      const desc = ((data.desc as string) || '').trim() || `douyin_${fallbackAlbumId}`;

      return {
        albumId: fallbackAlbumId,
        title: desc.replace(/[\\/:*?"<>|]/g, '_'),
        images: albumImages,
        imageCount: albumImages.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * 下载单张图片到本地
   */
  async downloadImage(imageUrl: string, fileName?: string): Promise<ImageDownloadResult> {
    const url = imageUrl.replace(/^http:/, 'https:');
    const safeFileName = fileName || `image_${Date.now()}.jpg`;
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
        imageUrl: url,
        filePath,
        fileSize: stats.size,
        width: 0,
        height: 0,
      };
    } catch (error) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // 忽略清理错误
      }

      throw new Error(`图片下载失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 批量下载图集图片
   */
  async downloadAlbum(albumInfo: AlbumInfo): Promise<ImageDownloadResult[]> {
    const results: ImageDownloadResult[] = [];

    for (let i = 0; i < albumInfo.images.length; i++) {
      const image = albumInfo.images[i];
      const ext = path.extname(new URL(image.url).pathname) || '.jpg';
      const fileName = `${albumInfo.title}_${i + 1}${ext}`;
      const result = await this.downloadImage(image.url, fileName);
      result.width = image.width;
      result.height = image.height;
      results.push(result);
    }

    return results;
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
