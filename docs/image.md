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

### 本地图片去水印（后备方案）

```
本地图片 → 自动检测水印位置 → inpaint 像素修复（sharp）
本地图片 → 手动裁剪（crop）
本地图片 → 外部 AI API 去水印
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

### 3. 去除图片水印

> **说明**：通过 `/parse` + `/download` 获取的抖音/豆包图片本身已无水印，此接口用于处理其他来源的含水印图片。

支持五种模式：

| 模式 | 说明 |
|------|------|
| `autoCrop` | 自动检测水印位置并裁剪（推荐） |
| `inpaint` | 自动检测并像素修复，保持原始尺寸 |
| `smart` | 智能选择最佳方案 |
| `crop` | 手动指定裁剪区域 |
| `api` | 调用外部 AI 去水印服务 |

#### autoCrop / inpaint / smart 模式

```
POST /api/image/remove-watermark
Content-Type: application/json

{
  "imageUrl": "https://example.com/image.jpg",
  "mode": "inpaint"
}
```

#### crop 模式

```
POST /api/image/remove-watermark
Content-Type: application/json

{
  "imageUrl": "https://example.com/image.jpg",
  "mode": "crop",
  "options": {
    "top": 0,
    "bottom": 100,
    "left": 0,
    "right": 0
  }
}
```

#### api 模式

```
POST /api/image/remove-watermark
Content-Type: application/json

{
  "imageUrl": "https://example.com/image.jpg",
  "mode": "api",
  "apiConfig": {
    "endpoint": "https://api.example.com/remove-watermark",
    "apiKey": "your-api-key"
  }
}
```

**返回：**

```json
{
  "success": true,
  "data": {
    "outputPath": "/project/tmp/wm_removed_1234567890.jpg",
    "method": "inpaint",
    "originalSize": 1048576,
    "outputSize": 983040
  }
}
```

### 4. 删除图片文件

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
3. **inpaint 依赖 sharp**：首次安装会编译原生模块，可能需要 Python 和 C++ 构建工具
4. **API 模式需自备服务**：项目不内置 AI 去水印模型，需自行对接外部服务
