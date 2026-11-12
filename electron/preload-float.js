'use strict';

/**
 * preload-float.js — 悬浮条 preload
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
 * 悬浮条只做三件事：显示状态、拖动自己、开关录制。它拿不到活动数据，
 * 也改不了配置——这正是「最小能力」的意思。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 透传全部参数：少数通道是多参数的（focus-add-note 的 (text, category)、
// set-float-pos 的 (x, y)）。只转发一个 payload 会让它们静默收不到第二个参数。
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 允许订阅的事件（主进程推送）。不在表内的事件不允许监听。 */
const EVENTS = new Set([
    'float-accent',
    'float-monitoring-status',
    'float-theme',
    'float-update'
]);

contextBridge.exposeInMainWorld('worklog', {
  getFloatBounds: (...args) => invoke('get-float-bounds', ...args),
  saveFloatWidth: (...args) => invoke('save-float-width', ...args),
  setFloatPos: (...args) => invoke('set-float-pos', ...args),
  setFloatWidth: (...args) => invoke('set-float-width', ...args),
  showMainWindow: (...args) => invoke('show-main-window', ...args),
  toggleMonitoring: (...args) => invoke('toggle-monitoring', ...args),

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
