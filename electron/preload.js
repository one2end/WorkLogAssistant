'use strict';

/**
 * preload.js — 主窗口 preload
 *
 * 为什么不用一个通用的 invoke(channel, ...)：
 *   那等于把「能调哪些通道」交给渲染层决定，隔离就白做了。
 *   这里每个通道一个具名方法，暴露面就是白名单本身。
 *   想知道这个窗口能做什么，读这个文件就够了。
 *
 * 为什么按角色分文件而不是运行时判断：
 *   角色推断错一次就是权限错配，而这种错误不会报错，
 *   只会让某个窗口悄悄多出不该有的能力。
 *
 * 通道清单由 electron/ipcRegistry.js 生成，不手写——
 * 手写一定会漏，而漏掉的表现是某个功能在切换之后突然失灵。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

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
  addLog: (payload) => invoke('add-log', payload),
  addManualRecord: (payload) => invoke('add-manual-record', payload),
  arhatAddNote: (payload) => invoke('arhat-add-note', payload),
  arhatGetNotes: (payload) => invoke('arhat-get-notes', payload),
  arhatGetSessions: (payload) => invoke('arhat-get-sessions', payload),
  arhatGetStats: (payload) => invoke('arhat-get-stats', payload),
  checkForUpdates: (payload) => invoke('check-for-updates', payload),
  clearLogs: (payload) => invoke('clear-logs', payload),
  convertPlanToFact: (payload) => invoke('convert-plan-to-fact', payload),
  deleteDisplayRange: (payload) => invoke('delete-display-range', payload),
  deleteDisplayRecord: (payload) => invoke('delete-display-record', payload),
  deleteFocusSession: (payload) => invoke('delete-focus-session', payload),
  deleteLocalPlan: (payload) => invoke('delete-local-plan', payload),
  didaProjects: (payload) => invoke('dida-projects', payload),
  didaStatus: (payload) => invoke('dida-status', payload),
  didaSyncNow: (payload) => invoke('dida-sync-now', payload),
  dismissAnnotationSuggestion: (payload) => invoke('dismiss-annotation-suggestion', payload),
  exportData: (payload) => invoke('export-data', payload),
  exportFullData: (payload) => invoke('export-full-data', payload),
  findNoteHints: (payload) => invoke('find-note-hints', payload),
  flushRecorder: (payload) => invoke('flush-recorder', payload),
  focusAddNote: (payload) => invoke('focus-add-note', payload),
  focusEnd: (payload) => invoke('focus-end', payload),
  focusHudExpand: (payload) => invoke('focus-hud-expand', payload),
  focusPresets: (payload) => invoke('focus-presets', payload),
  focusSkip: (payload) => invoke('focus-skip', payload),
  focusStart: (payload) => invoke('focus-start', payload),
  focusState: (payload) => invoke('focus-state', payload),
  focusTogglePause: (payload) => invoke('focus-toggle-pause', payload),
  generateSummary: (payload) => invoke('generate-summary', payload),
  generateSummaryRange: (payload) => invoke('generate-summary-range', payload),
  getActivities: (payload) => invoke('get-activities', payload),
  getAiUsage: (payload) => invoke('get-ai-usage', payload),
  getAnnotationSuggestions: (payload) => invoke('get-annotation-suggestions', payload),
  getAppVersion: (payload) => invoke('get-app-version', payload),
  getAutoLaunch: (payload) => invoke('get-auto-launch', payload),
  getBridgeStatus: (payload) => invoke('get-bridge-status', payload),
  getConfig: (payload) => invoke('get-config', payload),
  getDailyTracked: (payload) => invoke('get-daily-tracked', payload),
  getDatesWithData: (payload) => invoke('get-dates-with-data', payload),
  getDayAnalytics: (payload) => invoke('get-day-analytics', payload),
  getFloatBounds: (payload) => invoke('get-float-bounds', payload),
  getKnownApps: (payload) => invoke('get-known-apps', payload),
  getLogs: (payload) => invoke('get-logs', payload),
  getMonitoringStatus: (payload) => invoke('get-monitoring-status', payload),
  getProviderPresets: (payload) => invoke('get-provider-presets', payload),
  getRangeAnalytics: (payload) => invoke('get-range-analytics', payload),
  getRecorderStatus: (payload) => invoke('get-recorder-status', payload),
  getStoragePath: (payload) => invoke('get-storage-path', payload),
  getSummaries: (payload) => invoke('get-summaries', payload),
  importData: (payload) => invoke('import-data', payload),
  migrateStorage: (payload) => invoke('migrate-storage', payload),
  minimizeWindow: (payload) => invoke('minimize-window', payload),
  openBridgeUrl: (payload) => invoke('open-bridge-url', payload),
  openLogsFolder: (payload) => invoke('open-logs-folder', payload),
  previewSnap: (payload) => invoke('preview-snap', payload),
  recategorizeAppForDay: (payload) => invoke('recategorize-app-for-day', payload),
  replaceDisplayRanges: (payload) => invoke('replace-display-ranges', payload),
  saveConfig: (payload) => invoke('save-config', payload),
  saveFloatWidth: (payload) => invoke('save-float-width', payload),
  saveLocalPlan: (payload) => invoke('save-local-plan', payload),
  selectStorageFolder: (payload) => invoke('select-storage-folder', payload),
  setAutoLaunch: (payload) => invoke('set-auto-launch', payload),
  setBridgeConfig: (payload) => invoke('set-bridge-config', payload),
  setFloatPos: (payload) => invoke('set-float-pos', payload),
  setFloatWidth: (payload) => invoke('set-float-width', payload),
  showMainWindow: (payload) => invoke('show-main-window', payload),
  suggestCategories: (payload) => invoke('suggest-categories', payload),
  testBridge: (payload) => invoke('test-bridge', payload),
  toggleMonitoring: (payload) => invoke('toggle-monitoring', payload),
  toggleSnap: (payload) => invoke('toggle-snap', payload),
  updateDisplayRecord: (payload) => invoke('update-display-record', payload),
  updateFocusNote: (payload) => invoke('update-focus-note', payload),
  updateFocusSession: (payload) => invoke('update-focus-session', payload),

  /**
   * 订阅主进程推送。
   * 返回取消订阅函数；调用方应在组件卸载时调用它，
   * 否则重复打开窗口会累积监听器。
   */
  on: (eventName, handler) => {
    if (!EVENTS.has(eventName)) {
      throw new Error('不允许订阅该事件: ' + eventName);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  }
});
