const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const reg = require('../electron/ipcRegistry');
const ipcGuard = require('../electron/ipcGuard');

/**
 * A6 — 按角色校验 IPC 来源。
 *
 * 这一层存在的理由值得写下来：preload 限制了渲染层「能调哪些方法」，
 * 但主进程对「谁发来的」一无所知。两者之间的缺口是真的——
 * 只要某个窗口拿得到 ipcRenderer，它就能调任何已注册的通道。
 *
 * 测试分三块：
 *   1. 角色识别正确（按 webContents 引用，不按 URL/标题）
 *   2. 矩阵判定正确，且默认拒绝
 *   3. 包装真的生效（用一个假的 ipcMain 跑一遍）
 */

/** 造一个假 ipcMain，行为与 Electron 的足够接近 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    on() {},
    async invokeAs(sender, channel, ...args) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`没有这个通道: ${channel}`);
      return h({ sender }, ...args);
    }
  };
}

const fakeWindow = contents => ({ webContents: contents });

test('a role is recognised by window reference, never by URL or title', () => {
  const windows = {
    main: fakeWindow({ id: 'w-main' }),
    focus: fakeWindow({ id: 'w-focus' }),
    float: fakeWindow({ id: 'w-float' })
  };
  assert.equal(ipcGuard.roleOf({ sender: windows.main.webContents }, windows), 'main');
  assert.equal(ipcGuard.roleOf({ sender: windows.focus.webContents }, windows), 'focus');
  assert.equal(ipcGuard.roleOf({ sender: windows.float.webContents }, windows), 'float');
});

test('an unknown sender has no role at all', () => {
  const windows = { main: fakeWindow({ id: 'w-main' }) };
  assert.equal(ipcGuard.roleOf({ sender: { id: 'stranger' } }, windows), null);
  assert.equal(ipcGuard.roleOf({}, windows), null);
  assert.equal(ipcGuard.roleOf(null, windows), null);
});

test('a window that no longer exists does not grant a role', () => {
  // 窗口销毁后引用变成 null，此时任何 sender 都不该被认成它
  const windows = { main: null, focus: fakeWindow({ id: 'w-focus' }) };
  assert.equal(ipcGuard.roleOf({ sender: { id: 'w-main' } }, windows), null);
});

test('the main window can call every channel in its role', () => {
  for (const ch of reg.channelsForRole('main')) {
    assert.deepEqual(ipcGuard.check('main', ch), { ok: true }, `主窗应可调 ${ch}`);
  }
});

test('the auxiliary windows cannot reach data-writing channels', () => {
  const forbidden = [
    'save-config', 'import-data', 'migrate-storage', 'clear-logs',
    'delete-display-record', 'add-manual-record', 'export-data'
  ];
  for (const role of ['focus', 'float']) {
    for (const ch of forbidden) {
      const verdict = ipcGuard.check(role, ch);
      assert.equal(verdict.ok, false, `${role} 不应能调 ${ch}`);
      assert.equal(verdict.reason, 'not-in-role');
    }
  }
});

test('focus can do focus things and float can do float things', () => {
  for (const ch of ['focus-end', 'focus-add-note', 'focus-toggle-pause', 'focus-hud-expand']) {
    assert.equal(ipcGuard.check('focus', ch).ok, true, `专注窗应可调 ${ch}`);
  }
  for (const ch of ['get-float-bounds', 'set-float-pos', 'save-float-width', 'set-float-width']) {
    assert.equal(ipcGuard.check('float', ch).ok, true, `悬浮条应可调 ${ch}`);
  }
});

test('focus cannot use float channels and vice versa', () => {
  assert.equal(ipcGuard.check('focus', 'set-float-pos').ok, false);
  assert.equal(ipcGuard.check('float', 'focus-end').ok, false);
});

test('an unrecognised sender is denied by default', () => {
  const verdict = ipcGuard.check(null, 'get-config');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unknown-sender');
});

test('a channel nobody declared is denied for every non-main role', () => {
  // 默认拒绝的意义就在这里：将来新增一个通道但忘了登记，
  // 小窗仍然拿不到它，而不是悄悄对所有窗口开放。
  const ghost = 'some-channel-added-next-year';
  assert.equal(ipcGuard.check('focus', ghost).ok, false);
  assert.equal(ipcGuard.check('float', ghost).ok, false);
});

test('the wrapper lets an allowed call through untouched', async () => {
  const ipc = fakeIpcMain();
  const windows = { main: fakeWindow({ id: 'w-main' }), focus: null, float: null };
  ipcGuard.install(ipc, () => windows);

  ipc.handle('get-config', () => ({ theme: 'dark' }));
  const result = await ipc.invokeAs(windows.main.webContents, 'get-config');
  assert.deepEqual(result, { theme: 'dark' });
});

test('the wrapper blocks a disallowed call with a structured answer', async () => {
  const ipc = fakeIpcMain();
  const windows = {
    main: fakeWindow({ id: 'w-main' }),
    focus: fakeWindow({ id: 'w-focus' })
  };
  const denials = [];
  ipcGuard.install(ipc, () => windows, { onDenied: d => denials.push(d) });

  let called = false;
  ipc.handle('migrate-storage', () => { called = true; return { ok: true }; });

  const result = await ipc.invokeAs(windows.focus.webContents, 'migrate-storage', '/tmp/x');
  assert.equal(called, false, '业务逻辑根本不该被执行');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IPC_FORBIDDEN');
  assert.equal(result.channel, 'migrate-storage');
  assert.equal(denials.length, 1, '拒绝应被记录，而不是静默吞掉');
  assert.equal(denials[0].role, 'focus');
});

test('a disallowed call does not throw — it answers', async () => {
  // 抛出去会在渲染层变成一个 rejected promise，错误信息是
  // "Error invoking remote method" —— 看不出是被权限挡了还是代码坏了
  const ipc = fakeIpcMain();
  const windows = { focus: fakeWindow({ id: 'w-focus' }) };
  ipcGuard.install(ipc, () => windows);
  ipc.handle('save-config', () => true);

  await assert.doesNotReject(async () => {
    const r = await ipc.invokeAs(windows.focus.webContents, 'save-config', {});
    assert.equal(r.code, 'IPC_FORBIDDEN');
  });
});

test('installing twice does not double-wrap', () => {
  // 每次 install 都会替换 ipcMain.handle。若包了两层，
  // 第一次的拒绝逻辑会先跑一遍，日志里就会出现两条相同的拒绝。
  const ipc = fakeIpcMain();
  const restore = ipcGuard.install(ipc, () => ({}));
  restore();
  const before = ipc.handle;
  ipcGuard.install(ipc, () => ({}));
  assert.notEqual(ipc.handle, before, '卸载后重新安装应得到新的包装');
});

test('every registered channel has a role that can reach it', () => {
  // 一个通道如果谁都不该调，那它本身就该被删掉
  for (const ch of Object.keys(reg.allChannels())) {
    const reachable = reg.ROLES.some(r => reg.channelsForRole(r).includes(ch));
    assert.ok(reachable, `${ch} 没有任何角色能调，应当删除`);
  }
});
