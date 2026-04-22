/**
 * 图片服务模块
 * 支持抖音图集解析下载、豆包对话图片提取、图片去水印
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
   * 解析豆包对话链接，提取无水印原始图片
   * 参考: https://github.com/ihmily/doubao-nomark
   */
  private async getDoubaoAlbumInfo(url: string): Promise<AlbumInfo> {
    const threadId = url.split('?')[0].split('/').filter(Boolean).pop() || 'doubao';

    const response = await axios.get(url, {
      headers: {
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      },
      responseType: 'text',
      timeout: 20000,
    });

    const html = response.data as string;

    const match = html.match(/data-script-src="modern-run-router-data-fn"\s+data-fn-args="(.*?)"\s+nonce="/s);
    if (!match) {
      throw new Error('无法解析豆包页面数据，请确认链接有效');
    }

    const jsonStr = match[1].replace(/&quot;/g, '"');
    let jsonData: unknown[];
    try {
      jsonData = JSON.parse(jsonStr) as unknown[];
    } catch {
      throw new Error('豆包页面数据格式错误，无法解析');
    }

    const images: AlbumImage[] = [];

    for (const item of jsonData) {
      const data = (item as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
      if (!data) continue;

      const messageSnapshot = data.message_snapshot as Record<string, unknown> | undefined;
      const messageList = messageSnapshot?.message_list as Record<string, unknown>[] | undefined;
      if (!messageList) continue;

      for (const message of messageList) {
        const contentBlock = message.content_block as Record<string, unknown>[] | undefined;
        if (!contentBlock) continue;

        for (const block of contentBlock) {
          let contentV2: Record<string, unknown>;
          try {
            contentV2 = JSON.parse(block.content_v2 as string) as Record<string, unknown>;
          } catch {
            continue;
          }

          const creationBlock = contentV2.creation_block as Record<string, unknown> | undefined;
          const creations = creationBlock?.creations as Record<string, unknown>[] | undefined;
          if (!creations) continue;

          for (const creation of creations) {
            const imageData = creation.image as Record<string, unknown> | undefined;
            const oriRaw = imageData?.image_ori_raw as Record<string, unknown> | undefined;
            if (!oriRaw) continue;

            const imageUrl = ((oriRaw.url as string) || '').replace(/&amp;/g, '&');
            if (!imageUrl) continue;

            images.push({
              url: imageUrl,
              width: (oriRaw.width as number) || 0,
              height: (oriRaw.height as number) || 0,
            });
          }
        }
      }
    }

    if (images.length === 0) {
      throw new Error('未在豆包对话中找到图片');
    }

    return {
      albumId: threadId,
      title: `doubao_${threadId}`,
      images,
      imageCount: images.length,
    };
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

    // 豆包对话链接单独处理
    if (shareUrl.includes('doubao.com/thread/')) {
      return this.getDoubaoAlbumInfo(shareUrl);
    }

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
   * 从图片数据对象中提取最佳无水印 URL
   *
   * 策略（参考 doubao-nomark 的 image_ori_raw 思路）：
   * 1. 优先使用 download_addr.url_list — 原始下载级无水印 URL
   * 2. 从 url_list 所有 URL 中选最优（排除含水印模板参数的）
   * 3. 尝试去除 ~tplv-xxx 处理参数，得到 CDN 原始路径
   * 4. 回退到 ~tplv-ow360noawqhd.jpeg / ~tplv-ow360noawqhd 模板替换
   */
  private extractBestImageUrl(img: Record<string, unknown>): string {
    const toHttps = (u: string) => u.replace(/^http:/, 'https:');

    // 1. download_addr 字段（部分接口包含原始无水印 URL）
    const downloadAddr = img.download_addr as Record<string, unknown> | undefined;
    if (downloadAddr) {
      const dlUrls = (downloadAddr.url_list as string[]) || [];
      if (dlUrls.length > 0) return toHttps(dlUrls[0]);
    }

    const urlList = ((img.url_list as string[]) || []).map(toHttps);
    if (urlList.length === 0) return '';

    // 2. 优先选不含水印模板参数的 URL
    const noWatermarkUrl = urlList.find(
      (u) => !/~tplv-[^~?]+(?:watermark|logowatermark|logo)/i.test(u)
        && /~tplv-/.test(u) === false
    );
    if (noWatermarkUrl) return noWatermarkUrl;

    // 3. 从 url_list 中找非水印模板的 URL（有 ~tplv- 但不是 watermark 类型）
    const nonWatermarkTplUrl = urlList.find(
      (u) => !/~tplv-[^~?]+(?:watermark|logowatermark|logo)/i.test(u)
    );
    const base = nonWatermarkTplUrl || urlList[0];

    // 4. 尝试去除 ~tplv-xxx 处理参数（最接近原始 CDN 路径）
    const stripped = base.replace(/~tplv-[^~?&#/]+/g, '');
    if (stripped && stripped !== base) return stripped;

    // 5. 替换为已知无水印模板（加扩展名变体为新格式）
    const withExt = base.replace(/~tplv-[^~?&#/]+/, '~tplv-ow360noawqhd.jpeg');
    if (withExt !== base) return withExt;

    // 6. 旧格式兜底
    return base.replace(/~tplv-[^~?&#/]+/, '~tplv-ow360noawqhd');
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
        const url = this.extractBestImageUrl(img);
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
    // 本地文件路径直接复制到 tempDir
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      const srcPath = path.resolve(imageUrl);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`文件不存在: ${srcPath}`);
      }
      const safeFileName = fileName || `image_${Date.now()}${path.extname(srcPath) || '.jpg'}`;
      const destPath = path.join(this.tempDir, safeFileName);
      await fs.promises.copyFile(srcPath, destPath);
      const stats = fs.statSync(destPath);
      return { imageUrl: srcPath, filePath: destPath, fileSize: stats.size, width: 0, height: 0 };
    }

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
