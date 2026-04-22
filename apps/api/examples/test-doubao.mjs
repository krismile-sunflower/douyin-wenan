import { ImageService } from '@douyin-wenan/core';
const svc = new ImageService({ tempDir: 'tmp' });
try {
  const info = await svc.getAlbumInfo('https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/3b18c309d4a947d494b8e139e42c7319.jpeg~tplv-a9rns2rl98-image_pre_watermark_1_5b.png?lk3s=8e244e95&rcl=20260421111315993443E331BD812CA88D&rrcfp=e875b5a5&x-expires=2092101197&x-signature=tZcK6c157nJQf0%2BHEZtQJBOHCjM%3D');
  console.log(`找到 ${info.imageCount} 张图片，开始下载...`);
  for (let i = 0; i < info.images.length; i++) {
    const img = info.images[i];
    const fileName = `doubao_${info.albumId}_${i + 1}.jpg`;
    const result = await svc.downloadImage(img.url, fileName);
    console.log(`  [${i + 1}/${info.imageCount}] ${fileName}  ${(result.fileSize / 1024).toFixed(1)} KB`);
  }
  console.log('下载完成');
} catch (e) {
  console.error('失败:', e.message);
}
