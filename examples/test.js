/**
 * 抖音文案提取服务 - 接口测试脚本
 * 
 * 用法:
 * 1. 确保服务已启动: npm run dev
 * 2. 设置环境变量: DASHSCOPE_API_KEY=sk-xxxx
 * 3. 运行测试: node test.js
 */
import 'dotenv/config';

// 测试配置
const BASE_URL = 'http://localhost:3000';

// 测试用的抖音分享文本 (替换为你自己的)
const TEST_SHARE_TEXT = '3.33 复制打开抖音，看看【徐大队老面包子官方号的作品】# 包子手法 # 老面小笼包 # 成都包子 # 老... https://v.douyin.com/efvO2fplgMc/ z@g.oD Jic:/ 12/30 ';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

async function testEndpoint(name, endpoint, body) {
  log(colors.cyan, `\n═══════════════════════════════════════`);
  log(colors.cyan, `🧪 测试: ${name}`);
  log(colors.cyan, `═══════════════════════════════════════`);
  log(colors.gray, `POST ${BASE_URL}${endpoint}`);
  log(colors.gray, `Body: ${JSON.stringify(body, null, 2)}`);

  try {
    const startTime = Date.now();
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const duration = Date.now() - startTime;
    const data = await response.json();

    if (response.ok && data.success) {
      log(colors.green, `✅ 成功 (${duration}ms)`);
      log(colors.gray, JSON.stringify(data, null, 2));
      return data;
    } else {
      log(colors.red, `❌ 失败 (${duration}ms)`);
      log(colors.red, JSON.stringify(data, null, 2));
      return null;
    }
  } catch (error) {
    log(colors.red, `❌ 请求异常: ${error.message}`);
    return null;
  }
}

async function runTests() {
  log(colors.yellow, '\n🚀 开始测试抖音文案提取服务...\n');

  // 检查环境变量
  if (!process.env.DASHSCOPE_API_KEY) {
    log(colors.red, '⚠️  警告: 未设置 DASHSCOPE_API_KEY 环境变量');
    log(colors.red, '    文案提取功能将不可用');
    log(colors.gray, '    设置方法: DASHSCOPE_API_KEY=sk-xxxx node test.js');
  }

  // 测试 1: 解析链接
  const parseResult = await testEndpoint('解析链接', '/api/parse', {
    url: TEST_SHARE_TEXT,
  });

  // 测试 2: 下载视频
  const downloadResult = await testEndpoint('下载无水印视频', '/api/download', {
    url: TEST_SHARE_TEXT,
  });

  // 测试 3: 提取文案 (需要 API Key)
  if (process.env.DASHSCOPE_API_KEY) {
    const transcribeResult = await testEndpoint('提取文案', '/api/transcribe', {
      url: TEST_SHARE_TEXT,
    });

    if (transcribeResult?.data?.text) {
      log(colors.green, '\n📝 提取的文案内容:');
      log(colors.green, '─'.repeat(50));
      console.log(transcribeResult.data.text);
      log(colors.green, '─'.repeat(50));
    }
  } else {
    log(colors.yellow, '\n⏭️  跳过文案提取 (缺少 DASHSCOPE_API_KEY)');
  }

  // 测试 4: 健康检查
  log(colors.cyan, `\n═══════════════════════════════════════`);
  log(colors.cyan, `🏥 测试: 健康检查`);
  log(colors.cyan, `═══════════════════════════════════════`);
  try {
    const response = await fetch(`${BASE_URL}/api/health`);
    const data = await response.json();
    log(colors.green, `✅ 服务运行中`);
    log(colors.gray, JSON.stringify(data, null, 2));
  } catch (error) {
    log(colors.red, `❌ 服务未启动或不可达: ${error.message}`);
  }

  log(colors.yellow, '\n🏁 测试完成\n');
}

// 运行测试
runTests().catch(console.error);
