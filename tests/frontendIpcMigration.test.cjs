const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A2 — 6 个 Vue 渲染入口迁移到统一 IPC 层。
 *
 * A2 阶段的前提是「窗口还没挂 preload」，所以适配层必须同时支持
 * `window.worklog` 和老的 `require('electron')`。这个双路径是过渡态，
 * 也是最容易出错的地方：写错一处，功能会静默失效而不是报错。
 *
 * 这里验证四件事：
 *   1. 6 个文件都不再直接 require electron
 *   2. 全部调用都走适配层
 *   3. 适配层的降级逻辑正确（有 bridge 用 bridge，没有才回退）
 *   4. 危险能力（clipboard / shell）被收窄
 */

const ROOT = path.resolve(__dirname, '..');
const VUE_FILES = [
  'src/App.vue',
  'src/views/TimelineView.vue',
  'src/views/SettingsView.vue',
  'src/components/CompareCard.vue',
  'src/components/ProductivityOverview.vue',
  'src/components/WeeklyReview.vue'
];

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('none of the six Vue entry points requires electron directly', () => {
  const offenders = [];
  for (const f of VUE_FILES) {
    const src = read(f);
    if (/require\('electron'\)/.test(src)) offenders.push(`${f}: require('electron')`);
    if (/from 'electron'/.test(src)) offenders.push(`${f}: import from electron`);
    if (/\bipcRenderer\b/.test(src)) offenders.push(`${f}: 仍在用 ipcRenderer`);
  }
  assert.deepEqual(offenders, [], `以下位置仍直连 electron：\n${offenders.join('\n')}`);
});

test('all six files import the shared ipc layer', () => {
  const missing = VUE_FILES.filter(f => !/utils\/ipc\.mjs/.test(read(f)));
  assert.deepEqual(missing, [], `这些文件没有引入适配层：${missing.join(', ')}`);
});

test('the import path in each file actually resolves', () => {
  for (const f of VUE_FILES) {
    const src = read(f);
    const m = src.match(/from '([^']*utils\/ipc\.mjs)'/);
    assert.ok(m, `${f} 应 import ipc.mjs`);
    const rel = m[1];
    const resolved = path.resolve(path.dirname(path.join(ROOT, f)), rel);
    assert.ok(fs.existsSync(resolved), `${f} 的 import 路径解析不到：${rel} → ${resolved}`);
  }
});

test('the adapter has exactly one path now, and it is the bridge', () => {
  // A2 时这里断言的是「先 bridge 再回退 require」。A5 删掉了回退：
  // 三个窗口都关了 nodeIntegration，`require` 已经不存在，
  // 留着那条分支只会让人以为还有第二条路。
  const src = read('src/utils/ipc.mjs');
  assert.match(src, /window\.worklog/, '应读 preload 暴露的桥');
  assert.equal(/require\(/.test(src), false, '不应再有 require');
});

test('the adapter throws when the bridge exists but lacks the method', () => {
  const src = read('src/utils/ipc.mjs');
  assert.match(src, /throw new Error\(`当前窗口没有调用该通道的权限/,
    'bridge 存在但方法缺失时必须抛错，静默 undefined 会变成难查的「没反应」');
});

test('the adapter does not expose a generic invoke to components', () => {
  // 组件拿到的是 ipc.invoke(channel, payload)，这是过渡期的形状；
  // 但适配层内部必须校验方法是否在白名单里（见上一条）。
  const src = read('src/utils/ipc.mjs');
  assert.match(src, /export const ipc = \{ invoke \}/);
});

test('clipboard access is narrowed to writing text only', () => {
  const src = read('src/utils/ipc.mjs');
  assert.match(src, /writeClipboard/, '应只暴露写剪贴板');
  assert.equal(/readText/.test(src), false, '不应暴露读剪贴板');
  // 组件里只能调 writeClipboard，不能碰 electron 的 clipboard 模块。
  // 注意要排除 navigator.clipboard —— 那是浏览器 API，不是 Electron 能力，
  // 把它算作违规会逼着代码改用主进程，反而多绕一圈。
  for (const f of VUE_FILES) {
    const src = read(f).replace(/navigator\.clipboard/g, '');
    assert.equal(/\bclipboard\./.test(src), false, `${f} 不应直接使用 electron 的 clipboard`);
  }
});

test('opening external links goes through the main process', () => {
  const src = read('src/utils/ipc.mjs');
  const fn = src.slice(src.indexOf('export function openExternal'));
  // 有 bridge 时必须走通道，不能直接调 shell
  assert.match(fn, /bridge\(\)\.openExternal|window\.worklog\.openExternal/,
    'openExternal 应经由 preload 交给主进程，由主进程做白名单校验');

  for (const f of VUE_FILES) {
    assert.equal(/\bshell\.openExternal/.test(read(f)), false,
      `${f} 不应直接调用 shell.openExternal`);
  }
});

test('the on() adapter keeps the (event, payload) signature App.vue relies on', () => {
  const src = read('src/utils/ipc.mjs');
  const fn = src.slice(src.indexOf('export function on'), src.indexOf('export function writeClipboard'));
  assert.match(fn, /handler\(null,\s*payload\)/,
    'App.vue 的 handler 签名是 (event, payload)，bridge 路径必须补齐第一个参数');
});

test('subscriptions return an unsubscribe function', () => {
  const src = read('src/utils/ipc.mjs');
  const fn = src.slice(src.indexOf('export function on'), src.indexOf('export function writeClipboard'));
  assert.match(fn, /bridge\(\)\.on/, '应返回 preload 给的取消函数');
});

test('App.vue stores unsubscribe handles instead of removing by reference', () => {
  const src = read('src/App.vue');
  assert.match(src, /this\._unsubscribes = Object\.entries/, '应保存取消函数');
  assert.match(src, /this\._unsubscribes\.forEach/, '卸载时逐个调用');
  assert.equal(/ipcRenderer\.removeListener/.test(src), false);
});

test('no Vue file still calls the removed openEvent/offEvent helpers', () => {
  // 替换脚本一度产生过这两个名字，它们并不存在
  for (const f of VUE_FILES) {
    const src = read(f);
    assert.equal(/\boffEvent\(/.test(src), false, `${f} 引用了不存在的 offEvent`);
    if (f !== 'src/App.vue') {
      assert.equal(/\bonEvent\(/.test(src), false, `${f} 引用了不存在的 onEvent`);
    }
  }
});

test('the count of migrated invoke calls is plausible', () => {
  // 迁移前 App.vue 58 处、TimelineView 15 处、其余 6 处，共 79 处
  let total = 0;
  for (const f of VUE_FILES) {
    total += (read(f).match(/ipc\.invoke\(/g) || []).length;
  }
  assert.ok(total >= 75, `迁移的调用点偏少（${total}），可能有遗漏`);
});

test('the adapter file itself does not import electron at top level', () => {
  const src = read('src/utils/ipc.mjs');
  // require 必须出现在函数内部，不能顶层执行——
  // A3b/A4 之后窗口没有 nodeIntegration，顶层 require 会直接崩
  const lines = src.split('\n');
  const topLevelRequire = lines.findIndex(l => /^const .*require\('electron'\)/.test(l));
  assert.equal(topLevelRequire, -1, 'electron 的 require 不能写在顶层');
});
