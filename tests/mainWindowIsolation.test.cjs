const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * A4 — 主窗关闭 nodeIntegration、开启 contextIsolation。
 *
 * 这是全项目风险最高的一次改动：主窗承载全部业务界面。
 * 静态检查能覆盖配置与文件完整性，但覆盖不了「适配层在无 Node 环境下
 * 是否真的能用」，所以最后几项把 ipc.mjs 真的跑一遍。
 */

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN = read('electron/main.js');

function prefsOf(marker) {
  const start = MAIN.indexOf(marker);
  assert.ok(start >= 0, `找不到窗口：${marker}`);
  return MAIN.slice(start, MAIN.indexOf('loadFile', start) + 300);
}

test('no window anywhere still enables nodeIntegration', () => {
  assert.equal((MAIN.match(/nodeIntegration:\s*true/g) || []).length, 0,
    '任何窗口都不应再开启 nodeIntegration');
  assert.equal((MAIN.match(/nodeIntegration:\s*false/g) || []).length, 3,
    '三个窗口都应显式关闭');
});

test('every window enables contextIsolation', () => {
  assert.equal((MAIN.match(/contextIsolation:\s*true/g) || []).length, 3);
  assert.equal((MAIN.match(/contextIsolation:\s*false/g) || []).length, 0);
});

test('enableRemoteModule is gone — it has been a no-op since Electron 28', () => {
  // 留着它比删掉更糟：读代码的人会以为远程模块还在被控制。
  assert.equal(/enableRemoteModule/.test(MAIN), false);
});

test('each window loads a preload that exists on disk', () => {
  const expected = [
    ['focusWindow = new BrowserWindow', 'preload-focus.js'],
    ['mainWindow = new BrowserWindow', 'preload.js'],
    ['floatWindow = new BrowserWindow', 'preload-float.js']
  ];
  for (const [marker, file] of expected) {
    const block = prefsOf(marker);
    assert.ok(block.includes(`'${file}'`), `${marker} 应加载 ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, 'electron', file)),
      `${file} 必须真实存在，否则窗口启动时 preload 静默失败`);
  }
});

test('the packaging config ships every preload file', () => {
  // electron/** 覆盖了它们，但这条断言的作用是：如果有人把 files 收窄成
  // 精确清单，打包后的应用会缺 preload，而开发环境一切正常。
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files;
  assert.ok(files.some(p => p === 'electron/**/*' || p.startsWith('electron/preload')),
    `打包配置必须包含 preload 文件，当前：${JSON.stringify(files)}`);
  for (const f of ['preload.js', 'preload-focus.js', 'preload-float.js']) {
    if (!files.some(p => p === 'electron/**/*')) {
      assert.ok(files.includes(`electron/${f}`), `打包配置缺少 ${f}`);
    }
  }
});

test('the main preload covers every channel the Vue files call', () => {
  const reg = require('../electron/ipcRegistry');
  const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const preload = read('electron/preload.js');
  const exposed = new Set([...preload.matchAll(/^\s+([a-zA-Z0-9_]+):\s*\(/gm)].map(m => m[1]));

  const vueFiles = [
    'src/App.vue', 'src/views/TimelineView.vue', 'src/views/SettingsView.vue',
    'src/components/CompareCard.vue', 'src/components/ProductivityOverview.vue',
    'src/components/WeeklyReview.vue'
  ];
  const called = new Set();
  for (const f of vueFiles) {
    for (const m of read(f).matchAll(/ipc\.invoke\('([a-z0-9-]+)'/g)) called.add(m[1]);
  }

  const missing = [...called].filter(c => !exposed.has(camel(c)) && c !== 'open-external');
  assert.deepEqual(missing, [],
    `这些通道主窗调用了但 preload 没暴露，关闭隔离后会直接失败：${missing.join(', ')}`);

  const unregistered = [...called].filter(c => !Object.keys(reg.allChannels()).includes(c));
  assert.deepEqual(unregistered, [], `这些通道不在权限矩阵里：${unregistered.join(', ')}`);
});

test('the main window keeps every channel it needs, and none it does not', () => {
  const reg = require('../electron/ipcRegistry');
  const main = reg.channelsForRole('main');
  // 主窗拥有全部通道（除专注窗与悬浮条各自专用的那些由矩阵排他）
  assert.ok(main.includes('import-data'), '主窗应能导入');
  assert.ok(main.includes('migrate-storage'), '主窗应能迁移存储');
  for (const other of ['focus', 'float']) {
    const theirs = reg.channelsForRole(other).filter(c => !main.includes(c));
    for (const c of theirs) {
      assert.equal(main.includes(c), false, `${c} 是 ${other} 专用，主窗不该有`);
    }
  }
});

// --- 运行时：把适配层放到「没有 Node」的沙箱里跑 ---

/** 把 ESM 的 ipc.mjs 变成能在 vm 里执行的片段 */
function loadAdapter(bridge) {
  let src = read('src/utils/ipc.mjs')
    .replace(/export function /g, 'function ')
    .replace('export const ipc = { invoke };',
      'globalThis.__api = { invoke, on, writeClipboard, openExternal, isBridged };');
  const sandbox = { window: bridge === undefined ? {} : { worklog: bridge }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__api;
}

test('the adapter works in a window that has no require at all', () => {
  // 这就是 A4 之后的真实状态：有 bridge，没有 require。
  const calls = [];
  const api = loadAdapter({
    getConfig: (...a) => { calls.push(['get-config', a]); return Promise.resolve({ ok: true }); },
    saveConfig: (...a) => { calls.push(['save-config', a]); return Promise.resolve(true); },
    writeClipboard: () => true,
    openExternal: (...a) => { calls.push(['open-external', a]); return Promise.resolve(true); },
    on: () => () => {}
  });

  assert.equal(api.isBridged(), true);
  api.invoke('get-config');
  api.invoke('save-config', { theme: 'dark' });
  api.writeClipboard('hello');
  api.openExternal('https://example.com');

  assert.deepEqual(calls[0], ['get-config', [undefined]],
    '不传 payload 时通道收到 undefined，与 Electron 原生的行为一致');
  assert.deepEqual(calls[1], ['save-config', [{ theme: 'dark' }]]);
  assert.deepEqual(calls[2], ['open-external', ['https://example.com']]);
});

test('a missing preload produces a message that names the actual cause', () => {
  // 没有 bridge 也没有 require：说明 preload 没挂上。
  // 原生的 "require is not defined" 会把人引向「代码写错了」这个错误方向。
  const api = loadAdapter(undefined);
  assert.throws(() => api.invoke('get-config'),
    /没有挂载 preload/,
    '错误信息应直接指出 preload 未挂载');
});

test('a channel the role does not have fails loudly, not with undefined', () => {
  const api = loadAdapter({ getConfig: () => Promise.resolve({}) });
  assert.throws(() => api.invoke('migrate-storage', '/tmp/x'),
    /没有调用该通道的权限/);
});

test('the built renderer bundle talks to the bridge and nothing else', () => {
  const assets = path.join(ROOT, 'dist/assets');
  if (!fs.existsSync(assets)) {
    // 没构建过就跳过——CI 里 build 在前，本地偶尔会先跑测试
    return;
  }
  const bundle = fs.readdirSync(assets).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
  assert.ok(bundle.includes('window.worklog'), '产物里应有 bridge 判断');
  // A5 之前这里断言的是「保留 typeof require 的保护」。降级分支删掉之后，
  // 产物里根本不该再有 require('electron')——渲染层已经没有 require 了。
  assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(bundle), false,
    '产物里不应再有 require(electron)，窗口已关闭 nodeIntegration');
});
