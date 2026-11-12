const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A3a — 两个独立 HTML 窗口改用 preload API。
 *
 * 这两步的顺序不能颠倒。先把调用迁到 window.worklog，再关 nodeIntegration；
 * 反过来做，页面会在关掉的那一刻变成一块白板，而且错误信息只说
 * 「ipcRenderer is not defined」，不指向真正的原因。
 *
 * 这里验证的是「可以安全关掉 nodeIntegration」的前提条件：
 *   · 有 bridge 时不碰 require
 *   · require 不在顶层（否则关掉之后整个脚本一行都不执行）
 *   · 调用的每个通道都在该角色的白名单里（否则关掉之后逐个报错）
 */

const ROOT = path.resolve(__dirname, '..');
const reg = require('../electron/ipcRegistry');

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGES = [
  { file: 'electron/focus.html', role: 'focus', preload: 'electron/preload-focus.js' },
  { file: 'electron/float.html', role: 'float', preload: 'electron/preload-float.js' }
];

test('both standalone windows look for the bridge before anything else', () => {
  for (const { file } of PAGES) {
    const src = read(file);
    assert.match(src, /window\.worklog/, `${file} 应先检查 window.worklog`);
  }
});

test('require is never at the top level of either page', () => {
  for (const { file } of PAGES) {
    const src = read(file);
    const scriptStart = src.indexOf('<script>');
    const scriptEnd = src.lastIndexOf('</script>');
    const script = src.slice(scriptStart, scriptEnd);
    const lines = script.split('\n');
    // 顶格（无缩进）的 const ... require( 就是顶层 require
    const topLevel = lines.findIndex((l, i) => {
      const isRequire = /^\s*const\s+.*require\('electron'\)/.test(l);
      const indented = /^\s{2,}/.test(l);
      return isRequire && !indented;
    });
    assert.equal(topLevel, -1,
      `${file} 里有顶层 require('electron')，关闭 nodeIntegration 后脚本会整段不执行`);
  }
});

test('the bridge path throws when the window asks for a channel it does not have', () => {
  for (const { file } of PAGES) {
    const src = read(file);
    assert.match(src, /没有调用此通道的权限/,
      `${file} 在能力缺失时必须报错，静默 undefined 会变成「点了没反应」`);
  }
});

test('every channel the pages call exists in that role whitelist', () => {
  for (const { file, role } of PAGES) {
    const src = read(file);
    const channels = [...src.matchAll(/\.invoke\('([a-z0-9-]+)'/g)].map(m => m[1]);
    const allowed = new Set(reg.channelsForRole(role));
    const missing = [...new Set(channels)].filter(c => !allowed.has(c));
    assert.deepEqual(missing, [],
      `${file} 调用了 ${role} 角色没有的通道：${missing.join(', ')}`);
  }
});

test('every event the pages subscribe to exists in that role event list', () => {
  for (const { file, role } of PAGES) {
    const src = read(file);
    const events = [...src.matchAll(/\.on\('([a-z0-9-]+)'/g)].map(m => m[1]);
    const allowed = new Set(reg.eventsForRole(role));
    const missing = [...new Set(events)].filter(e => !allowed.has(e));
    assert.deepEqual(missing, [],
      `${file} 订阅了 ${role} 角色不可见的事件：${missing.join(', ')}`);
  }
});

test('the two role preloads expose exactly their own channel sets', () => {
  for (const { role, preload } of PAGES) {
    const src = read(preload);
    const exposed = [...src.matchAll(/^\s+([a-zA-Z0-9_]+):\s*\([^)]*\)\s*=>\s*invoke\('([a-z0-9-]+)'/gm)]
      .map(m => m[2]);
    assert.deepEqual(exposed.sort(), reg.channelsForRole(role).sort(),
      `${preload} 的通道必须与 ${role} 角色的白名单完全一致`);
  }
});

test('the auxiliary preloads cannot reach data-reading channels', () => {
  // 这是权限矩阵的实际意义：就算小窗被注入了外部内容，
  // 它也读不到活动记录、改不了配置。
  const forbidden = ['get-activities', 'save-config', 'import-data', 'migrate-storage'];
  for (const { role, preload } of PAGES) {
    const src = read(preload);
    for (const ch of forbidden) {
      assert.equal(src.includes(`invoke('${ch}'`), false,
        `${preload} 不应暴露 ${ch}`);
    }
    assert.ok(reg.channelsForRole(role).length <= 8,
      `${role} 的能力应保持最小，当前 ${reg.channelsForRole(role).length} 个通道`);
  }
});

test('multi-argument channels keep all their arguments', () => {
  // focus-add-note 实际是 (text, category)，set-float-pos 是 (x, y)。
  // 单参数转发会让第二个参数静默丢失。
  for (const { preload } of PAGES) {
    const src = read(preload);
    assert.match(src, /\(\.\.\.args\)\s*=>\s*invoke\('['a-z0-9-]+',\s*\.\.\.args\)/,
      `${preload} 应透传全部参数`);
  }
});

test('nodeIntegration is still on — A3a only prepares the migration', () => {
  const main = read('electron/main.js');
  // 关掉这件事发生在 A3b，本阶段不做
  const count = (main.match(/nodeIntegration:\s*true/g) || []).length;
  assert.equal(count, 3, 'A3a 阶段三个窗口都应仍开启 nodeIntegration');
});

test('the preload files are in sync with the registry', () => {
  // 注册表改了但没跑生成器，preload 就会少一个方法，
  // 而症状要等到关闭隔离之后才出现。让它在测试里就失败。
  const { execFileSync } = require('node:child_process');
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen-preload.js'), '--check'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    assert.fail(`preload 与注册表不同步，请运行 node scripts/gen-preload.js\n${error.stderr || error.stdout}`);
  }
  assert.match(out, /同步/);
});
