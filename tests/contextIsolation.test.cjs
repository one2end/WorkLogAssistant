const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A3b — 两个小窗关闭 nodeIntegration、开启 contextIsolation。
 *
 * 这是本项目第一次真正收紧能力。测试分三块：
 *   1. 配置正确（三个开关 + preload 挂上）
 *   2. 页面在无 Node 环境下能活（没有顶层 require、没有 __dirname 之类）
 *   3. 主窗**还没有**被改（A4 才动，失败时可单独回退）
 */

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 抓出某个 BrowserWindow 的 webPreferences 块 */
function webPrefsOf(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到窗口定义：${marker}`);
  const block = source.slice(start, source.indexOf('loadFile', start) + 200);
  return block;
}

test('the focus window has Node off, isolation on, and its own preload', () => {
  const block = webPrefsOf(read('electron/main.js'), 'focusWindow = new BrowserWindow');
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /sandbox:\s*true/);
  assert.match(block, /preload:\s*path\.join\(__dirname,\s*'preload-focus\.js'\)/);
});

test('the float window has Node off, isolation on, and its own preload', () => {
  const block = webPrefsOf(read('electron/main.js'), 'floatWindow = new BrowserWindow');
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /sandbox:\s*true/);
  assert.match(block, /preload:\s*path\.join\(__dirname,\s*'preload-float\.js'\)/);
});

test('the auxiliary windows do not share one preload', () => {
  // 共用一个 preload 就得在运行时判断角色；判错就是能力错配，且不会报错
  const focus = webPrefsOf(read('electron/main.js'), 'focusWindow = new BrowserWindow');
  const float = webPrefsOf(read('electron/main.js'), 'floatWindow = new BrowserWindow');
  assert.match(focus, /preload-focus\.js/);
  assert.match(float, /preload-float\.js/);
  assert.equal(/preload-focus/.test(float), false);
});

test('the main window was closed last, and is closed too', () => {
  // A3b 时这条断言的是「主窗还没动」。A4 把它也关了，
  // 断言随之更新——阶段顺序本身就是验收标准的一部分：
  // 先小窗后主窗，任何一步出问题都能只回退那一组。
  const block = webPrefsOf(read('electron/main.js'), 'mainWindow = new BrowserWindow');
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/);
});

test('sandboxed preloads only require electron', () => {
  // sandbox: true 的 preload 只能 require electron 与少量内置模块。
  // 多 require 一个会在运行时静默失败，表现为「window.worklog 是 undefined」。
  for (const f of ['electron/preload-focus.js', 'electron/preload-float.js']) {
    const src = read(f);
    const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
    assert.deepEqual(requires, ['electron'], `${f} 只能 require electron`);
  }
});

test('the auxiliary pages do not depend on Node globals at module level', () => {
  // 这些在 nodeIntegration 关闭后都不存在。页面里若用到，会在加载瞬间抛错。
  const nodeGlobals = ['__dirname', '__filename', 'process.env', 'Buffer.'];
  for (const f of ['electron/focus.html', 'electron/float.html']) {
    const src = read(f);
    const script = src.slice(src.indexOf('<script>'), src.lastIndexOf('</script>'));
    for (const g of nodeGlobals) {
      assert.equal(script.includes(g), false, `${f} 不应使用 ${g}`);
    }
  }
});

test('both pages use the bridge, and only the bridge', () => {
  // A3a 时这条断言的是「先判断 bridge 再回退 require」。A5 删掉了回退：
  // 窗口已经没有 nodeIntegration，那条路走不通，留着只会误导。
  for (const f of ['electron/focus.html', 'electron/float.html']) {
    const src = read(f);
    assert.match(src, /window\.worklog/, `${f} 应使用 window.worklog`);
    assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(src), false,
      `${f} 不应再有 require`);
  }
});

test('the page adapters actually forward arguments and refuse what they lack', () => {
  // 静态检查看不出「多参数是否被丢掉」「越权是否真被拒」。
  // 这里用 vm 把适配层片段真的跑起来，喂一个假的 bridge 观察行为。
  const vm = require('node:vm');

  const runAdapter = (file) => {
    const src = read(file);
    const script = src.slice(src.indexOf('<script>') + 8, src.lastIndexOf('</script>'));
    const adapter = script.slice(0, script.indexOf('})();') + 5);

    const calls = [];
    const mk = name => (...args) => { calls.push([name, args]); return Promise.resolve(); };
    const bridge = {
      focusEnd: mk('focus-end'),
      focusAddNote: mk('focus-add-note'),
      setFloatPos: mk('set-float-pos'),
      on: (name) => { calls.push(['on', [name]]); return () => {}; }
    };

    const sandbox = { window: { worklog: bridge }, console };
    vm.createContext(sandbox);
    vm.runInContext(adapter, sandbox);
    vm.runInContext('globalThis.__ipc = ipc;', sandbox);
    return { ipc: sandbox.__ipc, calls };
  };

  const focus = runAdapter('electron/focus.html');
  focus.ipc.invoke('focus-add-note', '一段备注', 'random');
  const noteCall = focus.calls.find(c => c[0] === 'focus-add-note');
  assert.deepEqual(noteCall[1], ['一段备注', 'random'],
    '第二个参数（分类）必须原样送达，否则备注永远没有分类');

  const float = runAdapter('electron/float.html');
  float.ipc.invoke('set-float-pos', 100, 200);
  const posCall = float.calls.find(c => c[0] === 'set-float-pos');
  assert.deepEqual(posCall[1], [100, 200], '坐标的两个分量都不能丢');

  for (const page of [focus, float]) {
    assert.throws(() => page.ipc.invoke('save-config', {}),
      /没有调用此通道的权限/,
      '越权调用必须抛错，静默失败会变成「点了没反应」');
  }
});

test('the adapter fails with its own message when the preload is missing', () => {
  // 若 preload 没挂上：window.worklog 不存在，require 也不存在。
  // 应当是我们自己写的那句话，而不是一个指向错误方向的 ReferenceError。
  const vm = require('node:vm');
  for (const file of ['electron/focus.html', 'electron/float.html']) {
    const src = read(file);
    const script = src.slice(src.indexOf('<script>') + 8, src.lastIndexOf('</script>'));
    const adapter = script.slice(0, script.indexOf('})();') + 5);

    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    assert.throws(() => vm.runInContext(adapter, sandbox),
      /没有挂载 preload/,
      `${file} 应给出明确原因`);
  }
});
