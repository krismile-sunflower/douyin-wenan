import { WatermarkRemover } from '@douyin-wenan/core';

const r = new WatermarkRemover({ tempDir: 'tmp' });
try {
  console.log('Testing removeByLaMa...');
  const result = await r.removeByLaMa('images/01-cover-horoscope.png', 'test-lama-01.jpg');
  console.log('SUCCESS:', result.outputPath);
  console.log('Detected region:', result.detectedRegion.position, result.detectedRegion.confidence);
} catch(e) {
  console.error('LaMa ERROR:', e.message);
  if (e.stderr) console.error('stderr:', e.stderr);
  if (e.stdout) console.error('stdout:', e.stdout);
}
