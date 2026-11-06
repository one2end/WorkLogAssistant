'use strict';

/**
 * build-icons.js — 从 build/icon.svg 生成各尺寸 PNG 和 Windows .ico
 *
 * 为什么用 Electron 而不是图像库：
 *   项目里没有 sharp/canvas，系统也没有 ImageMagick。
 *   Electron 本身就是个 Chromium，直接把 SVG 渲染成位图最省事，
 *   而且每个尺寸都是从矢量重新渲染的，不是从大图缩下来的，小尺寸更锐利。
 *
 * 用法：npm run icons
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const SVG_PATH = path.join(BUILD_DIR, 'icon.svg');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MASTER = 1024;

function svgPage(svg, size) {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
  svg{display:block;width:${size}px;height:${size}px}
</style></head>
<body>${svg}</body>
</html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function renderPng(win, svg, size, outPath) {
  win.setContentSize(size, size);
  await win.loadURL(svgPage(svg, size));
  // 等两帧，确保渐变和描边都画完
  await new Promise(r => setTimeout(r, 220));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const png = image.toPNG({ scaleFactor: 1 });

  // 校验：尺寸对不对、四角是否透明
  const check = nativeImage.createFromBuffer(png);
  const actual = check.getSize();
  const bmp = check.toBitmap();
  const cornerAlpha = bmp.length >= 4 ? bmp[3] : -1;

  fs.writeFileSync(outPath, png);
  return {
    size,
    okSize: actual.width === size && actual.height === size,
    actual: `${actual.width}x${actual.height}`,
    cornerAlpha,
    bytes: png.length
  };
}

/** 组装 ICO（Vista+ 支持 PNG 压缩条目，这里直接用 PNG 负载） */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;

  entries.forEach((entry, i) => {
    const base = i * 16;
    // 256 在目录里用 0 表示
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    dir.writeUInt8(0, base + 2);          // color palette
    dir.writeUInt8(0, base + 3);          // reserved
    dir.writeUInt16LE(1, base + 4);       // color planes
    dir.writeUInt16LE(32, base + 6);      // bits per pixel
    dir.writeUInt32LE(entry.buf.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.buf.length;
  });

  return Buffer.concat([header, dir, ...entries.map(e => e.buf)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(SVG_PATH)) {
    console.error('缺少 build/icon.svg');
    app.quit();
    return;
  }
  const svg = fs.readFileSync(SVG_PATH, 'utf8');

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      // 离屏渲染：不依赖显示器，构建脚本可以无窗口跑
      offscreen: true
    }
  });

  const results = [];

  // 主图 1024
  const masterPath = path.join(BUILD_DIR, 'icon.png');
  results.push(await renderPng(win, svg, MASTER, masterPath));

  // 托盘专用：32px，Electron 缩到 16 逻辑像素时比从 1024 缩更锐
  const trayPath = path.join(BUILD_DIR, 'tray.png');
  results.push(await renderPng(win, svg, 32, trayPath));

  // 各尺寸
  const iconEntries = [];
  for (const size of SIZES) {
    const out = path.join(BUILD_DIR, `icon-${size}.png`);
    const r = await renderPng(win, svg, size, out);
    results.push(r);
    iconEntries.push({ size, buf: fs.readFileSync(out) });
  }

  // ico
  const icoPath = path.join(BUILD_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, buildIco(iconEntries));

  // 报告
  console.log('\n尺寸  实际      角透明  字节');
  for (const r of results) {
    const flag = r.okSize ? ' ' : '!';
    console.log(`${flag}${String(r.size).padStart(4)}  ${r.actual.padEnd(9)} ${String(r.cornerAlpha).padStart(6)}  ${r.bytes}`);
  }
  console.log(`\nicon.ico  ${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB · ${SIZES.length} 个尺寸`);
  console.log(`icon.png  ${(fs.statSync(masterPath).size / 1024).toFixed(1)} KB · ${MASTER}px`);
  console.log(`tray.png  ${(fs.statSync(trayPath).size / 1024).toFixed(1)} KB · 32px`);

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error('生成失败:', error);
  app.quit();
});
