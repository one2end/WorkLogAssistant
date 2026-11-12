const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reg = require('../electron/ipcRegistry');

/**
 * A1 — IPC 通道注册表与 preload 契约。
 *
 * 这一层测的不是「代码有没有写完」，而是三件事必须同时为真：
 *   1. 注册表覆盖 main.js 实际注册的**每一个**通道，一个不漏
 *   2. preload 暴露的方法数 == 该角色的通道数，不多不少
 *   3. 没有任何「通用 invoke」把白名单变成摆设
 *
 * 第 1 条尤其重要：手写 74 个通道一定会漏。漏掉的表现不是报错，
 * 而是 A4 关掉隔离之后某个功能突然失灵——那时改动面已经很大了。
 * 实际开发中就漏了 focus-state 与 toggle-snap 两个，是这条断言抓出来的。
 */

const MAIN_JS = path.resolve(__dirname, '../electron/main.js');

/** 从 main.js 源码里取出实际注册的通道名 */
function registeredChannels() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const re = /ipcMain\.(?:handle|on)\(\s*'([a-zA-Z0-9_-]+)'/g;
  const set = new Set();
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return [...set].sort();
}

const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

test('the registry covers every channel main.js actually registers', () => {
  const actual = registeredChannels();
  const declared = Object.keys(reg.allChannels()).sort();

  const missing = actual.filter(c => !declared.includes(c));
  const extra = declared.filter(c => !actual.includes(c));

  assert.deepEqual(missing, [], `注册表缺少这些已注册通道：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `注册表声明了并不存在的通道：${extra.join(', ')}`);
  assert.equal(declared.length, actual.length);
});

test('the channel count matches what the plan documents: 75', () => {
  // 74 是 V0.10.6 规划时的实测值。A2 为渲染层新增了 open-external ——
  // 渲染层需要打开链接，但不能直接把 shell 交出去，所以加一个由主进程
  // 做白名单校验的通道。总数因此是 75，任务书与矩阵同步更新。
  assert.equal(Object.keys(reg.allChannels()).length, 75,
    '通道总数变化时必须同步更新任务书与矩阵，否则文档会悄悄过期');
});

test('every role resolves to a concrete channel list', () => {
  for (const role of reg.ROLES) {
    const list = reg.channelsForRole(role);
    assert.ok(list.length > 0, `${role} 应有可用通道`);
    assert.equal(new Set(list).size, list.length, `${role} 的通道列表不应有重复`);
  }
});

test('main can reach every channel, since it is the full-featured window', () => {
  const all = Object.keys(reg.allChannels()).sort();
  assert.deepEqual(reg.channelsForRole('main'), all);
});

test('focus and float only see their own channels plus the shared ones', () => {
  const focus = reg.channelsForRole('focus');
  const float = reg.channelsForRole('float');

  assert.deepEqual(focus, [
    'focus-add-note', 'focus-end', 'focus-hud-expand', 'focus-toggle-pause', 'show-main-window'
  ].sort());

  assert.deepEqual(float, [
    'get-float-bounds', 'save-float-width', 'set-float-pos', 'set-float-width',
    'show-main-window', 'toggle-monitoring'
  ].sort());
});

test('no auxiliary window can reach data-mutating channels', () => {
  const dangerous = [
    'add-manual-record', 'save-config', 'import-data', 'migrate-storage',
    'clear-logs', 'export-full-data', 'delete-display-record', 'generate-summary'
  ];
  for (const ch of dangerous) {
    assert.equal(reg.isAllowed(ch, 'focus'), false, `focus 不应能调用 ${ch}`);
    assert.equal(reg.isAllowed(ch, 'float'), false, `float 不应能调用 ${ch}`);
  }
});

test('an unregistered channel is denied by default', () => {
  assert.equal(reg.isAllowed('totally-made-up-channel', 'main'), false,
    '未登记的通道必须拒绝，而不是放行');
  assert.equal(reg.isAllowed('', 'main'), false);
  assert.equal(reg.isAllowed(null, 'main'), false);
});

test('an unknown role gets nothing', () => {
  for (const role of ['god', 'admin', '', null, undefined, 'MAIN']) {
    assert.deepEqual(reg.channelsForRole(role), [], `角色 ${JSON.stringify(role)} 不应有通道`);
    assert.deepEqual(reg.eventsForRole(role), []);
  }
});

test('the preload exposes exactly the main-role channel set', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  // 参数名不固定（payload / url / config …）。按名字匹配会漏掉后来加的通道，
  // 而漏掉的表现是「preload 少一个方法」，直到 A4 某个功能失灵才发现。
  // 方法一律写成 (...args) => invoke('channel', ...args)：少数通道是多参数的，
  // 单参数签名会把第二个参数悄悄丢掉。
  const exposed = [...src.matchAll(/^\s+([a-zA-Z0-9_]+):\s*\([^)]*\)\s*=>\s*invoke\('([a-z0-9-]+)'/gm)]
    .map(m => m[2]);

  const expected = reg.channelsForRole('main');
  assert.deepEqual(exposed.sort(), expected.sort(),
    `preload 暴露的通道必须与 matrix 完全一致`);
  assert.equal(new Set(exposed).size, exposed.length, 'preload 不应重复暴露同一通道');
});

test('the preload exposes no generic invoke escape hatch', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');

  // 允许内部定义一个 invoke 辅助函数，但不允许把它暴露到 window 上
  const exposedBlock = src.slice(src.indexOf('exposeInMainWorld'));
  assert.equal(/invoke\s*:\s*/.test(exposedBlock), false,
    '不能把 invoke 本身暴露给渲染层，否则白名单形同虚设');
  assert.equal(/channels\s*:\s*/.test(exposedBlock), false,
    '不应向渲染层暴露完整通道清单');
  assert.equal(/ipcRenderer\s*:\s*/.test(exposedBlock), false,
    '不能直接暴露 ipcRenderer');
});

test('the preload does not expose __channels or any self-inspection hook', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  assert.equal(src.includes('__channels'), false);
  assert.equal(src.includes('__'), false, '不暴露任何双下划线内部接口');
});

test('event subscriptions are whitelisted per role', () => {
  assert.deepEqual(reg.eventsForRole('focus'),
    ['focus-ended', 'focus-hud', 'focus-state', 'focus-theme'].sort());
  assert.deepEqual(reg.eventsForRole('float'),
    ['float-accent', 'float-monitoring-status', 'float-theme', 'float-update'].sort());

  // 数据变更类事件不该被小窗收到
  for (const ev of ['data-changed', 'config-updated', 'summary-generated']) {
    assert.equal(reg.isEventAllowed(ev, 'focus'), false, `focus 不应订阅 ${ev}`);
    assert.equal(reg.isEventAllowed(ev, 'float'), false, `float 不应订阅 ${ev}`);
  }
});

test('an unregistered event is denied by default', () => {
  assert.equal(reg.isEventAllowed('made-up-event', 'main'), false);
  assert.equal(reg.isEventAllowed('', 'main'), false);
});

test('the preload guards subscriptions at runtime', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  assert.match(src, /if \(!EVENTS\.has\(eventName\)\)/, '订阅前必须校验白名单');
  assert.match(src, /throw new Error/, '非白名单事件应抛错而不是静默忽略');
});

test('the preload returns an unsubscribe function', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  assert.match(src, /return \(\) => ipcRenderer\.removeListener/,
    '订阅必须可取消，否则重复开窗会累积监听器');
});

test('method names derived from channels are unique and collision-free', () => {
  const seen = new Map();
  for (const ch of Object.keys(reg.allChannels())) {
    const method = camel(ch);
    assert.equal(seen.has(method), false,
      `通道 ${ch} 与 ${seen.get(method)} 折成同名方法 ${method}`);
    seen.set(method, ch);
  }
});

test('the preload requires electron but nothing else', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/preload.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepEqual(requires, ['electron'],
    'preload 运行在受限环境，不应依赖其他模块');
});

test('the preload is not yet wired into any window (A1 only stages it)', () => {
  const mainSrc = fs.readFileSync(MAIN_JS, 'utf8');
  assert.equal(/preload:\s*path\.join/.test(mainSrc), false,
    'A1 只新增文件，不启用；启用发生在 A3b/A4');
});
