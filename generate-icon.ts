/**
 * 生成应用图标的脚本
 * 由于 Expo 环境限制，这里使用占位符
 * 实际的图标应该通过 generate 工具生成
 */

import * as fs from 'fs';
import * as path from 'path';

// 创建 assets/images 目录
const imagesDir = path.join(__dirname, 'assets', 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

console.log('Assets directory created at:', imagesDir);
console.log('Please use the generate tool to create app icons');
