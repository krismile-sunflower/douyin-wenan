# 图片去水印

解析抖音图集分享链接获取高清无水印图片，支持裁剪和 API 两种方式去除水印。

## 工作流程

### 图集解析下载

```
用户分享链接 → 解析 _ROUTER_DATA → 获取高清无水印图片 URL → 下载到本地
```

### 去水印处理

```
本地图片 → 裁剪模式 (sharp) → 去除固定位置水印
本地图片 → API 模式 → 调用外部 AI 服务去除水印
```

## 核心模块

位于 `packages/core/src/image/`：

| 文件 | 职责 |
|------|------|
| `image-service.ts` | 解析图集链接、获取无水印图片 URL、下载图片 |
| `watermark-remover.ts` | 裁剪去水印（依赖 sharp）、API 去水印 |

## API 接口

### 1. 解析图集链接

```
POST /api/image/parse
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

**返回：**

```json
{
  "success": true,
  "data": {
    "albumId": "7123456789012345678",
    "title": "图集标题",
    "imageCount": 3,
    "images": [
      { "index": 1, "url": "https://example.com/1.jpg", "width": 1080, "height": 1920 },
      { "index": 2, "url": "https://example.com/2.jpg", "width": 1080, "height": 1920 },
      { "index": 3, "url": "https://example.com/3.jpg", "width": 1080, "height": 1920 }
    ]
  }
}
```

### 2. 下载单张图片

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

支持两种模式：`crop`（裁剪）和 `api`（外部 AI 服务）。

#### 裁剪模式

去除固定位置的水印，需要安装 `sharp` 依赖。

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

`options` 参数说明：

| 参数 | 类型 | 说明 |
|------|------|------|
| `top` | number | 顶部裁剪像素 |
| `bottom` | number | 底部裁剪像素 |
| `left` | number | 左侧裁剪像素 |
| `right` | number | 右侧裁剪像素 |

**返回：**

```json
{
  "success": true,
  "data": {
    "outputPath": "/project/tmp/wm_removed_1234567890.jpg",
    "method": "crop",
    "originalSize": 1048576,
    "outputSize": 983040
  }
}
```

#### API 模式

调用外部 AI 去水印服务。

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

`apiConfig` 参数说明：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `endpoint` | string | 是 | 去水印 API 地址 |
| `apiKey` | string | 是 | API 密钥 |
| `headers` | object | 否 | 额外请求头 |

**返回：**

```json
{
  "success": true,
  "data": {
    "outputPath": "/project/tmp/wm_removed_1234567890.jpg",
    "method": "api",
    "originalSize": 1048576,
    "outputSize": 950000
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

1. **裁剪模式依赖 sharp**: 首次安装会自动编译原生模块，可能需要安装 Python 和 C++ 构建工具
2. **API 模式需自备服务**: 项目不内置 AI 去水印模型，需要自行对接外部服务
3. **图集与视频**: 抖音图集链接和视频链接解析方式相同，图集会返回多张图片，视频会返回封面图
