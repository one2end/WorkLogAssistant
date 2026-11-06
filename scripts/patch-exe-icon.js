'use strict';

/**
 * patch-exe-icon.js — 把 build/icon.ico 打进已打包的 exe
 *
 * 为什么需要这一步：
 *   electron-builder 的 win.icon 依赖 rcedit，而 rcedit 来自它要下载的 winCodeSign 包。
 *   这个包里带 macOS 的 dylib 软链，在没开「开发者模式」的 Windows 上 7z 建不了软链，
 *   整包解压失败 → 打包直接报错。把 signAndEditExecutable 关掉能绕过，
 *   代价是 exe 保留 Electron 默认图标（任务栏、开始菜单、文件属性里都是原子图标）。
 *
 *   所以这里在打包完成后，自己调 rcedit 补这一步。
 *
 * 用法：
 *   node scripts/patch-exe-icon.js <输出目录>      递归给目录下所有 exe 打图标
 *   node scripts/patch-exe-icon.js --template      给 node_modules/electron/dist/electron.exe 打图标
 *                                                  （推荐：之后每次打包都自带，NSIS 安装包也跟着对）
 *   node scripts/patch-exe-icon.js --template --check   只检查是否已打
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const TEMPLATE_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

/** 在 electron-builder 的缓存里找 rcedit */
function findRcedit() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  if (!fs.existsSync(cacheRoot)) return null;

  const candidates = [];
  for (const entry of fs.readdirSync(cacheRoot)) {
    for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
      const p = path.join(cacheRoot, entry, name);
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  // 优先 x64
  candidates.sort((a, b) => (a.includes('x64') ? -1 : 1) - (b.includes('x64') ? -1 : 1));
  return candidates[0] || null;
}

/** 检查 exe 里是否已经包含我们的图标数据 */
function hasOurIcon(exePath) {
  try {
    const ico = fs.readFileSync(ICON);
    const exe = fs.readFileSync(exePath);
    const count = ico.readUInt16LE(4);
    let hits = 0;
    for (let i = 0; i < count; i++) {
      const b = 6 + i * 16;
      const len = ico.readUInt32LE(b + 8);
      const off = ico.readUInt32LE(b + 12);
      if (exe.indexOf(ico.slice(off, off + len)) >= 0) hits++;
    }
    return hits === count ? 'all' : hits > 0 ? 'partial' : 'none';
  } catch (e) {
    return 'error';
  }
}

function collectExe(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectExe(full, acc);
    } else if (entry.name.toLowerCase().endsWith('.exe')) {
      // 跳过卸载程序，它们有自己的图标
      if (/uninstall/i.test(entry.name)) continue;
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  if (!fs.existsSync(ICON)) {
    console.error(`缺少图标源文件: ${ICON}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const useTemplate = args.includes('--template');
  const checkOnly = args.includes('--check');

  // --- 模式一：给 Electron 模板 exe 打图标 ---
  if (useTemplate) {
    if (!fs.existsSync(TEMPLATE_EXE)) {
      console.error(`找不到 Electron 模板: ${TEMPLATE_EXE}`);
      console.error('先执行 npm install');
      process.exit(1);
    }

    const state = hasOurIcon(TEMPLATE_EXE);
    if (state === 'all') {
      console.log(`模板已包含图标，跳过: ${path.relative(ROOT, TEMPLATE_EXE)}`);
      return;
    }
    if (checkOnly) {
      console.log(`模板图标状态: ${state}`);
      process.exit(state === 'all' ? 0 : 1);
    }

    const rcedit = findRcedit();
    if (!rcedit) {
      printNoRcedit();
      process.exit(2);
    }

    console.log(`rcedit: ${rcedit}`);
    try {
      execFileSync(rcedit, [TEMPLATE_EXE, '--set-icon', ICON], { stdio: 'pipe' });
      console.log(`已写入 Electron 模板: ${path.relative(ROOT, TEMPLATE_EXE)}`);
      console.log('之后每次打包都会自带这个图标，不需要再跑这一步。');
    } catch (error) {
      const msg = (error.stderr && error.stderr.toString().trim()) || error.message;
      console.error(`写入失败: ${msg}`);
      process.exit(1);
    }
    return;
  }

  // --- 模式二：给打包输出目录里的所有 exe 打图标 ---
  const outDirArg = args[0] || 'release-icon';
  const OUT_DIR = path.isAbsolute(outDirArg) ? outDirArg : path.join(ROOT, outDirArg);

  if (!fs.existsSync(OUT_DIR)) {
    console.error(`输出目录不存在: ${OUT_DIR}`);
    console.error('先执行 electron-builder，或用 npm run build:win');
    process.exit(1);
  }

  const rcedit = findRcedit();

  const exes = collectExe(OUT_DIR, []);
  if (exes.length === 0) {
    console.error(`在 ${OUT_DIR} 下没有找到 exe`);
    process.exit(1);
  }

  // 全都有图标就不需要 rcedit（比如已经给 Electron 模板打过）
  const pending = exes.filter(exe => hasOurIcon(exe) !== 'all');
  for (const exe of exes) {
    if (!pending.includes(exe)) {
      console.log(`  已有图标，跳过  ${path.relative(OUT_DIR, exe)}`);
    }
  }
  if (pending.length === 0) {
    console.log(`\n完成：${exes.length} 个 exe 均已带图标`);
    return;
  }

  if (!rcedit) {
    printNoRcedit();
    process.exit(2);
  }
  console.log(`rcedit: ${rcedit}`);

  let ok = exes.length - pending.length;
  for (const exe of pending) {
    const rel = path.relative(OUT_DIR, exe);
    try {
      execFileSync(rcedit, [exe, '--set-icon', ICON], { stdio: 'pipe' });
      console.log(`  已写入图标  ${rel}`);
      ok++;
    } catch (error) {
      const msg = (error.stderr && error.stderr.toString().trim()) || error.message;
      console.error(`  失败  ${rel}\n        ${msg}`);
    }
  }

  console.log(`\n完成：${ok}/${exes.length} 个 exe`);
  if (ok < exes.length) process.exit(1);
}

function printNoRcedit() {
  console.error('找不到 rcedit。三种方式任选其一：');
  console.error('  1) 开启 Windows 开发者模式，然后设 signAndEditExecutable: true 正常打包');
  console.error('  2) 以管理员身份运行一次 electron-builder（rcedit 会随 winCodeSign 解压出来）');
  console.error('  3) 手动下载 rcedit 放到 electron-builder 的 winCodeSign 缓存目录下');
}

main();
