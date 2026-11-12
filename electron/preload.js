'use strict';

/**
 * preload.js — 主窗口 preload
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
 * 主窗拥有全部能力，因为它是唯一能修改数据的界面。
 * 但它同样不使用通用 invoke(channel, ...)：暴露面就是白名单本身。
 */

const { contextBridge, ipcRenderer, clipboard } = require('electron');

// 透传全部参数：少数通道是多参数的（focus-add-note 的 (text, category)、
// set-float-pos 的 (x, y)）。只转发一个 payload 会让它们静默收不到第二个参数。
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 允许订阅的事件（主进程推送）。不在表内的事件不允许监听。 */
const EVENTS = new Set([
    'activity-logged',
    'bridge-status-changed',
    'config-updated',
    'data-changed',
    'error-message',
    'float-accent',
    'float-monitoring-status',
    'float-theme',
    'float-update',
    'focus-ended',
    'focus-hud',
    'focus-state',
    'focus-theme',
    'log-message',
    'monitoring-status-changed',
    'storage-path-changed',
    'summary-generated'
]);

contextBridge.exposeInMainWorld('worklog', {
  addLog: (...args) => invoke('add-log', ...args),
  addManualRecord: (...args) => invoke('add-manual-record', ...args),
  arhatAddNote: (...args) => invoke('arhat-add-note', ...args),
  arhatGetNotes: (...args) => invoke('arhat-get-notes', ...args),
  arhatGetSessions: (...args) => invoke('arhat-get-sessions', ...args),
  arhatGetStats: (...args) => invoke('arhat-get-stats', ...args),
  checkForUpdates: (...args) => invoke('check-for-updates', ...args),
  clearLogs: (...args) => invoke('clear-logs', ...args),
  convertPlanToFact: (...args) => invoke('convert-plan-to-fact', ...args),
  deleteDisplayRange: (...args) => invoke('delete-display-range', ...args),
  deleteDisplayRecord: (...args) => invoke('delete-display-record', ...args),
  deleteFocusSession: (...args) => invoke('delete-focus-session', ...args),
  deleteLocalPlan: (...args) => invoke('delete-local-plan', ...args),
  didaProjects: (...args) => invoke('dida-projects', ...args),
  didaStatus: (...args) => invoke('dida-status', ...args),
  didaSyncNow: (...args) => invoke('dida-sync-now', ...args),
  dismissAnnotationSuggestion: (...args) => invoke('dismiss-annotation-suggestion', ...args),
  exportData: (...args) => invoke('export-data', ...args),
  exportFullData: (...args) => invoke('export-full-data', ...args),
  findNoteHints: (...args) => invoke('find-note-hints', ...args),
  flushRecorder: (...args) => invoke('flush-recorder', ...args),
  focusAddNote: (...args) => invoke('focus-add-note', ...args),
  focusEnd: (...args) => invoke('focus-end', ...args),
  focusHudExpand: (...args) => invoke('focus-hud-expand', ...args),
  focusPresets: (...args) => invoke('focus-presets', ...args),
  focusSkip: (...args) => invoke('focus-skip', ...args),
  focusStart: (...args) => invoke('focus-start', ...args),
  focusState: (...args) => invoke('focus-state', ...args),
  focusTogglePause: (...args) => invoke('focus-toggle-pause', ...args),
  generateSummary: (...args) => invoke('generate-summary', ...args),
  generateSummaryRange: (...args) => invoke('generate-summary-range', ...args),
  getActivities: (...args) => invoke('get-activities', ...args),
  getAiUsage: (...args) => invoke('get-ai-usage', ...args),
  getAnnotationSuggestions: (...args) => invoke('get-annotation-suggestions', ...args),
  getAppVersion: (...args) => invoke('get-app-version', ...args),
  getAutoLaunch: (...args) => invoke('get-auto-launch', ...args),
  getBridgeStatus: (...args) => invoke('get-bridge-status', ...args),
  getConfig: (...args) => invoke('get-config', ...args),
  getDailyTracked: (...args) => invoke('get-daily-tracked', ...args),
  getDatesWithData: (...args) => invoke('get-dates-with-data', ...args),
  getDayAnalytics: (...args) => invoke('get-day-analytics', ...args),
  getFloatBounds: (...args) => invoke('get-float-bounds', ...args),
  getKnownApps: (...args) => invoke('get-known-apps', ...args),
  getLogs: (...args) => invoke('get-logs', ...args),
  getMonitoringStatus: (...args) => invoke('get-monitoring-status', ...args),
  getProviderPresets: (...args) => invoke('get-provider-presets', ...args),
  getRangeAnalytics: (...args) => invoke('get-range-analytics', ...args),
  getRecorderStatus: (...args) => invoke('get-recorder-status', ...args),
  getStoragePath: (...args) => invoke('get-storage-path', ...args),
  getSummaries: (...args) => invoke('get-summaries', ...args),
  importData: (...args) => invoke('import-data', ...args),
  migrateStorage: (...args) => invoke('migrate-storage', ...args),
  minimizeWindow: (...args) => invoke('minimize-window', ...args),
  openBridgeUrl: (...args) => invoke('open-bridge-url', ...args),
  openLogsFolder: (...args) => invoke('open-logs-folder', ...args),
  previewSnap: (...args) => invoke('preview-snap', ...args),
  recategorizeAppForDay: (...args) => invoke('recategorize-app-for-day', ...args),
  replaceDisplayRanges: (...args) => invoke('replace-display-ranges', ...args),
  saveConfig: (...args) => invoke('save-config', ...args),
  saveFloatWidth: (...args) => invoke('save-float-width', ...args),
  saveLocalPlan: (...args) => invoke('save-local-plan', ...args),
  selectStorageFolder: (...args) => invoke('select-storage-folder', ...args),
  setAutoLaunch: (...args) => invoke('set-auto-launch', ...args),
  setBridgeConfig: (...args) => invoke('set-bridge-config', ...args),
  setFloatPos: (...args) => invoke('set-float-pos', ...args),
  setFloatWidth: (...args) => invoke('set-float-width', ...args),
  showMainWindow: (...args) => invoke('show-main-window', ...args),
  suggestCategories: (...args) => invoke('suggest-categories', ...args),
  testBridge: (...args) => invoke('test-bridge', ...args),
  toggleMonitoring: (...args) => invoke('toggle-monitoring', ...args),
  toggleSnap: (...args) => invoke('toggle-snap', ...args),
  updateDisplayRecord: (...args) => invoke('update-display-record', ...args),
  updateFocusNote: (...args) => invoke('update-focus-note', ...args),
  updateFocusSession: (...args) => invoke('update-focus-session', ...args),

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
  /**
   * 复制一段文本到剪贴板。
   *
   * 为什么不暴露整个 electron.clipboard：那个模块包含**读**能力，
   * 而这里只需要写。能给一个参数就不要给一个模块。
   */
  writeClipboard: (text) => {
    if (typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  },

  /**
   * 请求主进程打开外部链接。
   *
   * 渲染层不直接调 shell.openExternal —— 那等于把「可以打开任意协议」
   * 的能力交给渲染层。这里只递交 URL，是否放行由主进程按白名单判断（B2）。
   */
  openExternal: (...args) => invoke('open-external', ...args)
});
