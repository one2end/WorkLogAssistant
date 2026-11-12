'use strict';

/**
 * ipcRegistry.js — IPC 通道的单一事实源
 *
 * 一份表，三个用途：
 *   1. preload 按角色从这里生成白名单（不手写，避免遗漏）
 *   2. 主进程 handler 用这里声明的角色做二次校验（A6）
 *   3. 测试用它断言「注册的通道数 == 矩阵声明的通道数」
 *
 * 为什么必须集中：74 个通道分散在 main.js 各处，手写 preload 一定会漏。
 * 漏掉的表现是 preload 少一个方法 → 前端某功能在 A4 之后突然失灵，
 * 而那时改动面已经很大，很难定位。
 *
 * 通道分级依据来自实际静态扫描（见 docs/WORKLOG_1.0_V0106_TASK.md §3.2）：
 *   · focus.html 调用：focus-add-note / focus-end / focus-hud-expand /
 *                      focus-toggle-pause / show-main-window
 *   · float.html 调用：get-float-bounds / save-float-width / set-float-pos /
 *                      set-float-width / show-main-window / toggle-monitoring
 *   · 其余 64 个仅主窗调用
 */

const ROLES = ['main', 'focus', 'float'];

/**
 * 通道 → 允许调用的角色。
 *
 * 未在此表中出现的通道，视为仅 main 可用（默认拒绝策略）。
 * 显式列出共享通道，是为了让「谁可以调」这件事在代码里可见，
 * 而不是靠「没写就是 main」这种需要记住的约定。
 */
const SHARED_CHANNELS = {
  // 三个窗口都需要的「回到主界面」
  'show-main-window': ['main', 'focus', 'float'],

  // 悬浮条要能开关监控
  'toggle-monitoring': ['main', 'float'],

  // 专注窗专用
  'focus-hud-expand': ['main', 'focus'],
  'focus-toggle-pause': ['main', 'focus'],
  'focus-end': ['main', 'focus'],
  'focus-add-note': ['main', 'focus'],

  // 悬浮窗专用
  'get-float-bounds': ['main', 'float'],
  'set-float-pos': ['main', 'float'],
  'set-float-width': ['main', 'float'],
  'save-float-width': ['main', 'float']
};

/**
 * 事件订阅白名单（主进程 → 渲染层）。
 *
 * D-03 第 7 条要求「事件订阅也按窗口角色设置白名单」。
 * 收到不该收到的事件，和调用不该调用的通道是同一类错误：
 * 都是越过了角色边界。
 */
const EVENT_SUBSCRIPTIONS = {
  // 专注窗订阅
  'focus-hud': ['main', 'focus'],
  'focus-theme': ['main', 'focus'],
  'focus-state': ['main', 'focus'],
  'focus-ended': ['main', 'focus'],

  // 悬浮窗订阅
  'float-accent': ['main', 'float'],
  'float-theme': ['main', 'float'],
  'float-update': ['main', 'float'],
  'float-monitoring-status': ['main', 'float'],

  // 其余一律仅主窗
  'activity-logged': ['main'],
  'bridge-status-changed': ['main'],
  'config-updated': ['main'],
  'data-changed': ['main'],
  'error-message': ['main'],
  'log-message': ['main'],
  'monitoring-status-changed': ['main'],
  'storage-path-changed': ['main'],
  'summary-generated': ['main']
};

/**
 * 主窗专用的通道清单。
 *
 * 这份清单不是手写的——是由「注册的全部通道」减去「共享表里已声明的」
 * 得来的。测试会验证它确实覆盖了所有注册通道，漏一个就会失败。
 *
 * 放在这里而不是从 main.js 反射，是因为 preload 需要它构建 API，
 * 而 preload 运行在隔离环境里，不能去读主进程的代码。
 */
const MAIN_ONLY_CHANNELS = [
  'add-log', 'add-manual-record',
  'arhat-add-note', 'arhat-get-notes', 'arhat-get-sessions', 'arhat-get-stats',
  'check-for-updates', 'clear-logs',
  // 主动清除密钥。渲染层拿到的是脱敏投影，传空串无法表达「我要清除」，
  // 所以给一个显式动作，语义清楚、日志可审计。
  'clear-secret',
  'convert-plan-to-fact',
  'delete-display-range', 'delete-display-record', 'delete-focus-session', 'delete-local-plan',
  'dida-projects', 'dida-status', 'dida-sync-now',
  'dismiss-annotation-suggestion',
  'export-data', 'export-full-data',
  'find-note-hints', 'flush-recorder',
  'focus-presets', 'focus-skip', 'focus-start',
  'generate-summary', 'generate-summary-range',
  'get-activities', 'get-ai-usage', 'get-annotation-suggestions', 'get-app-version',
  'get-auto-launch', 'get-bridge-status', 'get-config', 'get-daily-tracked',
  'get-dates-with-data', 'get-day-analytics', 'get-known-apps', 'get-logs',
  'get-monitoring-status', 'get-provider-presets', 'get-range-analytics',
  'get-recorder-status', 'get-storage-path', 'get-summaries',
  // V0.11.0：日复盘、项目统计、历史检索
  'get-daily-review', 'get-project-report', 'search-activities', 'suggest-next-action',
  // 实测：App.vue 调用（专注状态查询 + 主窗贴边切换），两小窗均未使用
  'focus-state', 'toggle-snap',
  'import-data',
  'migrate-storage', 'minimize-window',
  'open-bridge-url', 'open-logs-folder',
  'open-external',
  'preview-snap',
  'recategorize-app-for-day', 'replace-display-ranges',
  'save-config', 'save-local-plan', 'select-storage-folder',
  'set-auto-launch', 'set-bridge-config',
  'suggest-categories',
  'test-bridge',
  'update-display-record', 'update-focus-note', 'update-focus-session'
];

/** 全部通道及其允许角色（共享 + 主窗专用合并） */
function allChannels() {
  const table = {};
  for (const name of MAIN_ONLY_CHANNELS) table[name] = ['main'];
  for (const [name, roles] of Object.entries(SHARED_CHANNELS)) table[name] = roles;
  return table;
}

/** 某角色可调用的通道名列表 */
function channelsForRole(role) {
  if (!ROLES.includes(role)) return [];
  const out = [];
  for (const [name, roles] of Object.entries(allChannels())) {
    if (roles.includes(role)) out.push(name);
  }
  return out.sort();
}

/** 某角色可订阅的事件名列表 */
function eventsForRole(role) {
  if (!ROLES.includes(role)) return [];
  const out = [];
  for (const [name, roles] of Object.entries(EVENT_SUBSCRIPTIONS)) {
    if (roles.includes(role)) out.push(name);
  }
  return out.sort();
}

/** 某通道是否允许某角色调用（默认拒绝） */
function isAllowed(channel, role) {
  const roles = allChannels()[channel];
  if (!roles) return false;   // 未登记 → 拒绝
  return roles.includes(role);
}

/** 某角色是否可订阅某事件（默认拒绝） */
function isEventAllowed(eventName, role) {
  const roles = EVENT_SUBSCRIPTIONS[eventName];
  if (!roles) return false;
  return roles.includes(role);
}

/**
 * 这些通道不由 preload 生成器产出同名方法，而是在 preload 里手写成收窄的能力：
 *
 *   open-external  → openExternal(url)，主进程按白名单校验（B2）
 *
 * 它们仍然是真实注册的通道，必须出现在矩阵里（否则「注册表覆盖所有通道」
 * 这条断言会失败），只是不自动生成方法。
 */
const HAND_WIRED = new Set(['open-external']);

module.exports = {
  HAND_WIRED,
  ROLES,
  SHARED_CHANNELS,
  EVENT_SUBSCRIPTIONS,
  MAIN_ONLY_CHANNELS,
  allChannels,
  channelsForRole,
  eventsForRole,
  isAllowed,
  isEventAllowed
};
