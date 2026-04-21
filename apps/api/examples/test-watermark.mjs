/**
 * 图片去水印测试脚本
 *
 * 用法:
 * 1. 确保 sharp 已安装: cd packages/core && pnpm install
 * 2. 运行测试: node apps/api/examples/test-watermark.js
 *
 * 处理 images/ 目录下所有 PNG/JPG 图片，裁剪底部 100px 去除 "AI生成" 水印
 */

import { WatermarkRemover } from '@douyin-wenan/core';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function main() {
  const projectRoot = path.resolve(__dirname, '../../..');
  const imagesDir = path.join(projectRoot, 'images');
  const outputDir = path.join(projectRoot, 'tmp');

  if (!fs.existsSync(imagesDir)) {
    log(colors.red, `错误: 图片目录不存在: ${imagesDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = fs
    .readdirSync(imagesDir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort();

  if (files.length === 0) {
    log(colors.yellow, `警告: ${imagesDir} 目录下没有找到图片`);
    process.exit(0);
  }

  log(colors.cyan, '\n═══════════════════════════════════════');
  log(colors.cyan, '图片去水印测试');
  log(colors.cyan, '═══════════════════════════════════════');
  log(colors.gray, `图片目录: ${imagesDir}`);
  log(colors.gray, `输出目录: ${outputDir}`);
  log(colors.gray, `找到 ${files.length} 张图片`);

  const remover = new WatermarkRemover({ tempDir: outputDir });

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    const inputPath = path.join(imagesDir, file);
    const outputFileName = `auto-${file.replace(/\.png$/i, '.jpg')}`;

    log(colors.cyan, `\n处理: ${file}`);
    log(colors.gray, `  输入: ${inputPath}`);

    try {
      const result = await remover.removeByAutoCrop(inputPath, outputFileName);

      log(colors.green, `  成功: ${outputFileName}`);
      log(colors.gray, `  检测到水印高度: ${result.detectedHeight}px`);
      log(colors.gray, `  原大小: ${(result.originalSize / 1024).toFixed(1)} KB`);
      log(colors.gray, `  处理后: ${(result.outputSize / 1024).toFixed(1)} KB`);
      log(colors.gray, `  路径: ${result.outputPath}`);

      successCount++;
    } catch (error) {
      log(colors.red, `  失败: ${error.message}`);
      failCount++;
    }
  }

  log(colors.cyan, '\n═══════════════════════════════════════');
  log(colors.green, `完成: ${successCount} 成功, ${failCount} 失败`);
  log(colors.cyan, '═══════════════════════════════════════\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
