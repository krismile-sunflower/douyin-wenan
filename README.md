# 抖音文案提取服务

从抖音分享链接提取视频文案的 Node.js 后端服务。

## 工作流程

```
用户分享链接 → 解析 _ROUTER_DATA → 获取无水印视频 URL → 百炼 paraformer-v2 转录 → 返回文本
```

参考实现: https://github.com/yzfly/douyin-mcp-server

## 快速开始

### 前置要求

- Node.js 18+

### 安装

```bash
npm install
cp .env.example .env
# 编辑 .env 填入配置
```

### 配置

```env
# 阿里云百炼 API Key (必需)
# 获取地址: https://help.aliyun.com/zh/model-studio/get-api-key
DASHSCOPE_API_KEY=sk-xxxx

# 语音识别模型 (默认 paraformer-v2)
DASHSCOPE_MODEL=paraformer-v2
```

### 运行

```bash
# 开发模式
npm run dev

# 构建并启动
npm run build
npm start
```

## API 接口

### 1. 解析链接

```
POST /api/parse
Body: { "url": "https://v.douyin.com/xxxxx/" }
```

返回视频 ID、标题、无水印 URL

### 2. 下载无水印视频

```
POST /api/download
Body: { "url": "https://v.douyin.com/xxxxx/" }
```

### 3. 提取文案

```
POST /api/transcribe
Body: { "url": "https://v.douyin.com/xxxxx/" }
```

返回识别文本、视频 ID、标题

### 4. 健康检查

```
GET /api/health
```

## 项目结构

```
src/
├── index.ts                     # 入口文件
├── parser/                      # 链接解析 (保留)
│   └── douyin-parser.ts
├── downloader/                  # 视频下载
│   └── video-downloader.ts      # _ROUTER_DATA 解析 + 无水印 URL
├── transcriber/                 # 语音识别
│   ├── dashscope-transcriber.ts # 百炼 paraformer-v2 API
│   └── audio-extractor.ts       # FFmpeg 音频提取 (备用)
├── api/                         # API 层
│   ├── index.ts
│   ├── routes/
│   │   ├── video.ts
│   │   └── transcribe.ts
│   └── middleware/
│       ├── error-handler.ts
│       └── request-logger.ts
└── utils/                       # 工具函数
    └── index.ts
```

## 技术细节

### 视频 URL 提取

参考 [douyin-mcp-server](https://github.com/yzfly/douyin-mcp-server) 的方式:
1. 跟随短链重定向，提取 video_id
2. 访问 `https://www.iesdouyin.com/share/video/{video_id}`
3. 从 `window._ROUTER_DATA` 中解析 `loaderData["video_(id)/page"]["videoInfoRes"]["item_list"][0]["video"]["play_addr"]["url_list"][0]`
4. 将 URL 中的 `playwm` 替换为 `play` 得到无水印地址

### 语音识别

使用阿里云百炼 `paraformer-v2` 模型:
- 直接用视频 URL 调用百炼转录 API，无需下载视频到本地
- 异步提交任务 → 轮询结果 → 获取 transcription_url → 提取文本
- 模型: `paraformer-v2`，支持中英文识别

## 注意事项

- 需要有效的 DASHSCOPE_API_KEY (从阿里云百炼获取)
- 百炼 API 按量计费，请参考 [定价文档](https://help.aliyun.com/zh/model-studio/developer-reference/paraformer)
- 视频 URL 需要公网可访问，百炼服务端会直接抓取
