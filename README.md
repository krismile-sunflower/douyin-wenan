# 抖音工具服务

从抖音分享链接提取视频文案、解析图集下载无水印图片的 Node.js 后端服务（monorepo 架构）。

## 功能概览

| 模块 | 功能 |
|------|------|
| [文案提取](docs/transcribe.md) | 解析分享链接 → 获取无水印视频 → 语音转写 → 返回文本 |
| [图片服务](docs/image.md) | 解析抖音图集/豆包对话链接 → 提取无水印原始图片 → 下载；本地图片像素修复去水印 |

## 项目结构

```
.
├── packages/
│   └── core/                    # 核心库（可独立发布）
│       ├── src/transcribe/      # 文案提取模块（parser/downloader/transcriber）
│       ├── src/image/           # 图片服务模块（解析下载/去水印）
│       └── src/utils/           # 工具函数
├── apps/
│   └── api/                     # Express REST API 服务
│       └── src/api/routes/      # 路由（video/transcribe/image）
├── docs/                        # 功能文档
├── package.json                 # workspaces 根配置
└── pnpm-workspace.yaml          # pnpm workspace 配置
```

## 快速开始

### 前置要求

- Node.js 18+
- pnpm

### 安装

```bash
pnpm install
cp .env.example .env
# 编辑 .env 填入配置
```

### 配置

```env
# 阿里云百炼 API Key (文案提取必需)
# 获取地址: https://help.aliyun.com/zh/model-studio/get-api-key
DASHSCOPE_API_KEY=sk-xxxx

# 语音识别模型 (默认 paraformer-v2)
DASHSCOPE_MODEL=paraformer-v2

# 服务配置
PORT=3000
NODE_ENV=development
TEMP_DIR=./tmp
```

### 运行

```bash
# 开发模式（热重载）
pnpm dev

# 构建所有包
pnpm build

# 启动生产服务
pnpm start
```

## API 概览

### 文案提取

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/parse` | 解析视频链接，返回视频信息 |
| POST | `/api/download` | 下载无水印视频 |
| DELETE | `/api/download/:fileName` | 删除视频文件 |
| POST | `/api/transcribe` | 提取视频文案 |

### 图片服务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/image/parse` | 解析抖音图集或豆包对话链接，返回无水印图片列表 |
| POST | `/api/image/download` | 下载单张图片（支持 HTTP URL 和本地路径） |
| POST | `/api/image/remove-watermark` | 去除本地图片水印（autoCrop / inpaint / smart / crop / api） |
| DELETE | `/api/image/download/:fileName` | 删除图片文件 |

### 通用

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |

详见 [docs/transcribe.md](docs/transcribe.md) 和 [docs/image.md](docs/image.md)。

## 技术细节

### 视频/图集 URL 提取

参考 [douyin-mcp-server](https://github.com/yzfly/douyin-mcp-server):
1. 跟随短链重定向，提取 ID
2. 访问 `https://www.iesdouyin.com/share/video/{id}`
3. 从 `window._ROUTER_DATA` 中解析信息
4. 视频 URL 将 `playwm` 替换为 `play` 得到无水印地址
5. 图片 URL 替换模板参数得到高清无水印地址

### 语音识别

使用阿里云百炼 `paraformer-v2` 模型，直接用视频 URL 调用转录 API，异步提交 → 轮询结果 → 提取文本。

## 注意事项

- 文案提取需要有效的 `DASHSCOPE_API_KEY`（从阿里云百炼获取）
- 百炼 API 按量计费，参考 [定价文档](https://help.aliyun.com/zh/model-studio/developer-reference/paraformer)
- 视频 URL 需要公网可访问，百炼服务端会直接抓取
- 裁剪去水印依赖 `sharp`，首次安装会自动编译
