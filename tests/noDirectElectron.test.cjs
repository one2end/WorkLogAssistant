const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A5 — 移除全部 8 个渲染入口的 require('electron')。
 *
 * 这不是清理癖好。三个窗口的 nodeIntegration 都已经关闭，
 * `require` 在渲染层根本不存在。留着一条走不通的降级分支，
 * 代价是下一个人会以为「主进程调用还有第二种办法」，
 * 然后在排查一个与它无关的问题时被这句话带偏。
 *
 * 覆盖 8 个入口：6 个 Vue 文件 + 2 个独立 HTML。
 */

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const VUE_ENTRIES = [
  'src/App.vue',
  'src/views/TimelineView.vue',
  'src/views/SettingsView.vue',
  'src/components/CompareCard.vue',
  'src/components/ProductivityOverview.vue',
  'src/components/WeeklyReview.vue'
];
const HTML_ENTRIES = ['electron/focus.html', 'electron/float.html'];
const ALL = [...VUE_ENTRIES, ...HTML_ENTRIES];

test('no render entry point requires electron', () => {
  const offenders = [];
  for (const f of ALL) {
    const src = read(f);
    if (/require\(\s*['"]electron['"]\s*\)/.test(src)) offenders.push(`${f}: require('electron')`);
    if (/from\s+['"]electron['"]/.test(src)) offenders.push(`${f}: import from 'electron'`);
  }
  assert.deepEqual(offenders, [],
    `关闭 nodeIntegration 后这些写法全部会抛错：\n${offenders.join('\n')}`);
});

test('the shared adapter has no fallback left either', () => {
  const src = read('src/utils/ipc.mjs');
  assert.equal(/require\(/.test(src), false,
    '适配层不应再有 require；唯一的通路是 preload');
});

test('every entry has exactly one route to the main process', () => {
  // Vue 文件走 import 的适配层；HTML 页面自带一份极小的适配器。
  for (const f of VUE_ENTRIES) {
    const src = read(f);
    assert.match(src, /utils\/ipc\.mjs/, `${f} 应引入统一适配层`);
  }
  for (const f of HTML_ENTRIES) {
    const src = read(f);
    assert.match(src, /window\.worklog/, `${f} 应使用 window.worklog`);
  }
});

test('no entry point touches a Node global it no longer has', () => {
  const forbidden = [
    ['__dirname', /__dirname/],
    ['__filename', /__filename/],
    ['process.env', /process\.env/],
    ['Buffer', /\bBuffer\./],
    ['global.', /\bglobal\./]
  ];
  const offenders = [];
  for (const f of ALL) {
    const src = read(f);
    for (const [name, re] of forbidden) {
      if (re.test(src)) offenders.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [],
    `这些在渲染层已不存在：\n${offenders.join('\n')}`);
});

test('the adapter refuses to work without a preload, with a clear reason', () => {
  const src = read('src/utils/ipc.mjs');
  assert.match(src, /没有挂载 preload/,
    'preload 缺失时必须说明真实原因，而不是抛 ReferenceError');
});

test('the page adapters refuse too, and say which window failed', () => {
  assert.match(read('electron/focus.html'), /专注窗口没有挂载 preload/);
  assert.match(read('electron/float.html'), /悬浮条没有挂载 preload/);
});

test('no negative assertion on ipcRenderer was left behind in the adapter', () => {
  // 早前版本里有一段 `return ipcRenderer` 的降级，删的时候容易残留一半
  const src = read('src/utils/ipc.mjs');
  assert.equal(/ipcRenderer/.test(src), false,
    '适配层不应残留 ipcRenderer 引用');
});
