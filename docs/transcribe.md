# 文案提取

从抖音分享链接提取视频中的语音文案，转为文本输出。

## 工作流程

```
用户分享链接 → 解析 _ROUTER_DATA → 获取无水印视频 URL → 百炼 paraformer-v2 转录 → 返回文本
```

## 核心模块

位于 `packages/core/src/transcribe/`：

| 文件 | 职责 |
|------|------|
| `parser.ts` | 从分享链接提取视频 ID |
| `downloader.ts` | 通过 iesdouyin.com 获取无水印视频 URL |
| `transcriber.ts` | 调用阿里云百炼语音识别 API |

## API 接口

### 1. 解析视频链接

```
POST /api/parse
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
    "videoId": "7123456789012345678",
    "title": "视频标题",
    "videoUrl": "https://example.com/video.mp4"
  }
}
```

### 2. 下载无水印视频

```
POST /api/download
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
    "videoUrl": "https://example.com/video.mp4",
    "filePath": "/project/tmp/video_1234567890.mp4",
    "fileSize": 5242880,
    "videoId": "7123456789012345678",
    "title": "视频标题"
  }
}
```

### 3. 提取文案（一键完成）

```
POST /api/transcribe
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
    "text": "提取出的语音文案内容...",
    "videoId": "7123456789012345678",
    "title": "视频标题",
    "taskId": "transcribe-task-xxx"
  }
}
```

### 4. 删除视频文件

```
DELETE /api/download/video_1234567890.mp4
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `DASHSCOPE_API_KEY` | 是 | - | 阿里云百炼 API Key |
| `DASHSCOPE_MODEL` | 否 | `paraformer-v2` | 语音识别模型 |

获取 API Key: [阿里云百炼文档](https://help.aliyun.com/zh/model-studio/get-api-key)

## 计费说明

百炼 API 按量计费，请参考 [paraformer 定价](https://help.aliyun.com/zh/model-studio/developer-reference/paraformer)。

## 实现参考

- 视频解析逻辑参考: [douyin-mcp-server](https://github.com/yzfly/douyin-mcp-server)
