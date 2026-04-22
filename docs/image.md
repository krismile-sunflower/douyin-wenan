# 图片服务

支持抖音图集和豆包对话图片的无水印提取与下载，以及本地图片去水印处理。

## 支持来源

| 来源 | 链接格式 | 原理 |
|------|---------|------|
| 抖音图集 | `https://v.douyin.com/xxx` | 解析 `_ROUTER_DATA` JSON，替换 CDN 模板参数获取无水印 URL |
| 豆包对话 | `https://www.doubao.com/thread/xxx` | 解析 `data-fn-args` JSON，提取 `image_ori_raw` 原始 URL |

## 工作流程

### 抖音图集

```
分享链接 → 短链重定向 → iesdouyin.com → 解析 _ROUTER_DATA → 提取无水印 URL → 下载
```

### 豆包对话图片

```
doubao.com/thread/xxx → 解析 data-fn-args JSON
  → message_list → content_block → creation_block
    → image.image_ori_raw.url  ← 直接原始无水印 URL → 下载
```

### 图片去水印

```
上传文件 / HTTP 链接
  → 自动检测水印区域
    → 纯色/渐变背景条：扫描真实边界 → 直接裁剪（crop）
    → 叠在内容上的水印：IOPaint LaMa AI 修复（inpaint）
    → LaMa 不可用时：JS 像素修复（fallback）
```

## 核心模块

位于 `packages/core/src/image/`：

| 文件 | 职责 |
|------|------|
| `image-service.ts` | 解析抖音/豆包链接、提取无水印 URL、下载图片（支持本地路径和 HTTP URL） |
| `watermark-remover.ts` | 自动检测水印位置、inpaint 修复、裁剪、外部 API 去水印 |

## API 接口

### 1. 解析图片链接

支持抖音图集和豆包对话链接。

```
POST /api/image/parse
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

```
POST /api/image/parse
Content-Type: application/json

{
  "url": "https://www.doubao.com/thread/ae6a8e6d1cd34"
}
```

**返回：**

```json
{
  "success": true,
  "data": {
    "albumId": "ae6a8e6d1cd34",
    "title": "doubao_ae6a8e6d1cd34",
    "imageCount": 8,
    "images": [
      { "index": 1, "url": "https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-xxx/rc_gen_image/xxx", "width": 2048, "height": 2048 }
    ]
  }
}
```

### 2. 下载单张图片

支持 HTTP URL 和本地文件路径。

```
POST /api/image/download
Content-Type: application/json

{
  "url": "https://example.com/1.jpg",
  "fileName": "optional_custom_name.jpg"
}
```

**返回：**

```json
{
  "success": true,
  "data": {
    "imageUrl": "https://example.com/1.jpg",
    "filePath": "/project/tmp/image_1234567890.jpg",
    "fileSize": 1048576
  }
}
```

### 3. 去除图片水印 — 上传文件

> **说明**：通过 `/parse` + `/download` 获取的抖音/豆包图片本身已无水印，此接口用于处理其他来源的含水印图片。

上传本地图片文件，服务端自动识别水印并去除。

```
POST /api/image/remove-watermark/upload
Content-Type: multipart/form-data

file=<图片文件>          # 必填，支持 JPEG/PNG/WebP/GIF，最大 20MB
mode=smart              # 可选，默认 smart
```

**mode 取值：**

| mode | 说明 |
|------|------|
| `smart`（默认） | 自动判断：纯色背景条 → 裁剪；叠加水印 → LaMa AI 修复 |
| `autoCrop` | 强制裁剪 |
| `inpaint` | 强制 LaMa AI 修复（需安装 IOPaint） |

**示例（curl）：**

```bash
curl -X POST http://localhost:3000/api/image/remove-watermark/upload \
  -F "file=@/path/to/image.png" \
  -F "mode=smart"
```

**返回：**

```json
{
  "success": true,
  "data": {
    "outputPath": "/project/tmp/wm_upload_1234567890.jpg",
    "method": "crop",
    "originalSize": 199249,
    "outputSize": 184832,
    "detectedRegion": {
      "position": "bottom",
      "confidence": 0.89,
      "crop": { "bottom": 138 }
    },
    "strategy": "crop"
  }
}
```

### 4. 去除图片水印 — 通过链接

传入图片 HTTP 链接（或本地路径），服务端自动下载并处理。

```
POST /api/image/remove-watermark/url
Content-Type: application/json

{
  "imageUrl": "https://example.com/image.jpg",
  "mode": "smart"
}
```

**示例（curl）：**

```bash
curl -X POST http://localhost:3000/api/image/remove-watermark/url \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "https://example.com/image.jpg", "mode": "smart"}'
```

**返回格式同上。**

### 5. 删除图片文件

### 6. 删除图片文件

```
DELETE /api/image/download/image_1234567890.jpg
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `TEMP_DIR` | 否 | `./tmp` | 临时文件目录 |
| `DOUYIN_USER_AGENT` | 否 | iPhone UA | 抖音请求 UA |

## 注意事项

1. **豆包链接无需去水印**：豆包 `image_ori_raw` 字段即为 AI 生成的原始图片，直接下载即可
2. **抖音图集 URL 提取策略**：优先 `download_addr` 字段 → 筛选无水印 CDN 模板 → 去除 `~tplv-xxx` 参数 → fallback 到 `~tplv-ow360noawqhd.jpeg`
3. **去水印依赖**：`sharp`（自动编译，可能需要 Python + C++ 构建工具）；AI 修复模式额外需要 `pip install iopaint`
4. **IOPaint LaMa 模型**：首次运行自动下载约 200MB，之后缓存在本地（HuggingFace 缓存目录）
5. **smart 策略判断逻辑**：对比水印区与内容区的亮度方差，水印区方差 < 内容区 75% 则判定为纯色/渐变背景条使用裁剪，否则使用 LaMa AI 修复
6. **API 模式需自备服务**：旧接口 `/remove-watermark` 保留，需自行对接外部 AI 去水印服务
