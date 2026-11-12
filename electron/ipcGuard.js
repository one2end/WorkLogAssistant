'use strict';

/**
 * IPC 来源校验 —— 让权限矩阵真正生效。
 *
 * 为什么需要它：
 *   下面三件事单独看都合理，合在一起就出现了一个缺口：
 *     · 渲染层只能调 preload 暴露的方法（A1-A5 已做）
 *     · 但 ipcMain 对「谁发来的」一无所知
 *     · 而 webContents 之间可以互相 send
 *   结果是：悬浮条那个窗口如果被注入了外部内容，它照样能调
 *   ipcRenderer.invoke('migrate-storage')——只要它能拿到 ipcRenderer。
 *   preload 挡住了「拿不到的方法」，主进程还得挡住「不该来的窗口」。
 *
 * 两道锁的分工：
 *   preload  → 渲染层「能调哪些方法」
 *   这一层   → 主进程「接受谁发来的调用」
 *
 * 默认拒绝。没在矩阵里声明的通道，非主窗一律拒绝。
 * 默认允许的做法在加新通道时是安全的假象：忘了登记也照常工作，
 * 于是永远不会有人想起来去登记。
 */

const reg = require('./ipcRegistry');

/**
 * 从 webContents 推断角色。
 *
 * 用引用相等判断，不用 URL 或标题——那些都可以被页面内容影响。
 * 主进程持有三个窗口的引用，这是唯一可靠的依据。
 */
function roleOf(event, windows) {
  const sender = event && event.sender;
  if (!sender) return null;
  if (windows.main && sender === windows.main.webContents) return 'main';
  if (windows.focus && sender === windows.focus.webContents) return 'focus';
  if (windows.float && sender === windows.float.webContents) return 'float';
  return null;
}

/**
 * 判断某个角色能否调用某通道。
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function check(role, channel) {
  if (!role) {
    return { ok: false, reason: 'unknown-sender' };
  }
  const allowed = reg.channelsForRole(role);
  if (allowed.includes(channel)) return { ok: true };
  return { ok: false, reason: 'not-in-role' };
}

/**
 * 把角色校验装到现有 ipcMain 上。
 *
 * 为什么用包装而不是在每个 handler 里加一行：
 *   74 个 handler 各加一行，就是 74 处可能漏、可能写错的地方，
 *   而漏掉的那一个不会报错，只会一直开着。
 *   包装一次，注册表就是唯一的事实源。
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {() => object} getWindows 返回 { main, focus, float } 的取值函数
 *   （窗口会被销毁重建，所以必须每次现取，不能传对象进来）
 * @param {object} [options]
 * @param {Function} [options.onDenied] 被拒绝时的回调（写日志用）
 */
function install(ipcMain, getWindows, options) {
  const opts = options || {};
  const report = typeof opts.onDenied === 'function' ? opts.onDenied : () => {};
  const originalHandle = ipcMain.handle.bind(ipcMain);

  ipcMain.handle = function patchedHandle(channel, listener) {
    return originalHandle(channel, function guarded(event, ...args) {
      const role = roleOf(event, getWindows() || {});
      const verdict = check(role, channel);
      if (!verdict.ok) {
        // 不抛异常：抛出去会在渲染层变成一个看不懂的 rejected promise。
        // 返回结构化结果，并且记一条日志——越权是值得知道的事，
        // 不是应该被静默吞掉的噪音。
        report({ channel, role, reason: verdict.reason });
        return { ok: false, code: 'IPC_FORBIDDEN', channel, reason: verdict.reason };
      }
      return listener(event, ...args);
    });
  };

  return () => {
    // 卸载：恢复原始 handle（测试里用）
    ipcMain.handle = originalHandle;
  };
}

module.exports = {
  install,
  roleOf,
  check
};
