'use strict';

/**
 * preload-focus.js — 专注窗口 preload
 *
 * 由 scripts/gen-preload.js 从 electron/ipcRegistry.js 生成，请勿手改。
 * 要加通道，改注册表，再重新生成本文件。
 *
 * 为什么不用一个通用的 invoke(channel, ...)：
 *   那等于把「能调哪些通道」交给渲染层决定，隔离就白做了。
 *   这里每个通道一个具名方法，暴露面就是白名单本身。
 *
 * 为什么按角色分文件而不是运行时判断：
 *   角色推断错一次就是权限错配，而这种错误不会报错，
 *   只会让某个窗口悄悄多出不该有的能力。
 *
 * 专注窗只需要控制专注会话、订阅专注状态。它不该能读写活动记录、
 * 改配置或迁移数据——一个只负责倒计时的窗口没有理由拥有这些能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 透传全部参数：少数通道是多参数的（focus-add-note 的 (text, category)、
// set-float-pos 的 (x, y)）。只转发一个 payload 会让它们静默收不到第二个参数。
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 允许订阅的事件（主进程推送）。不在表内的事件不允许监听。 */
const EVENTS = new Set([
    'focus-ended',
    'focus-hud',
    'focus-state',
    'focus-theme'
]);

contextBridge.exposeInMainWorld('worklog', {
  focusAddNote: (...args) => invoke('focus-add-note', ...args),
  focusEnd: (...args) => invoke('focus-end', ...args),
  focusHudExpand: (...args) => invoke('focus-hud-expand', ...args),
  focusTogglePause: (...args) => invoke('focus-toggle-pause', ...args),
  showMainWindow: (...args) => invoke('show-main-window', ...args),

  /**
   * 订阅主进程推送。返回取消订阅函数；调用方应在卸载时调用它，
   * 否则重复打开窗口会累积监听器。
   */
  on: (eventName, handler) => {
    if (!EVENTS.has(eventName)) {
      throw new Error('不允许订阅该事件: ' + eventName);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  },
});
