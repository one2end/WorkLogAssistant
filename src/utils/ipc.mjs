/**
 * ipc.mjs — 渲染层调用主进程的统一入口
 *
 * 为什么需要这一层：
 *   现在是个过渡态。preload 已经存在（A1），但窗口还没挂上去（A3b/A4），
 *   所以这期间既要能走新的 `window.worklog`，也要能回退到老的 `require`。
 *
 *   如果让每个组件自己写 `window.worklog ? ... : require('electron')`，
 *   那 6 个文件里会出现 6 份略有不一致的判断，A5 删回退时也容易漏。
 *   集中在这里，A5 只需要删掉 `legacy()` 这一个函数。
 *
 * A5 之后这个文件会瘦成一层薄封装，只做「方法名映射」，
 * 但保留它仍有价值：组件不再直接依赖 window 上的全局对象，便于测试。
 */

/* eslint-disable no-undef */

/** preload 是否已挂载（A3b/A4 之后恒为 true） */
function hasBridge() {
  return typeof window !== 'undefined' && !!window.worklog;
}

/**
 * 拿老的 ipcRenderer（仅过渡期使用）。
 * 用 require 而不是 import，因为 electron 只能从 CommonJS 拿。
 */
function legacy() {
  // 主窗与两个小窗都已关闭 nodeIntegration，`require` 在渲染层不再存在。
  // 走到这里说明 preload 没挂上，而不是「调用写错了」——
  // 直接 throw 一个看不懂的 ReferenceError 会让人查错方向。
  if (typeof require !== 'function') {
    throw new Error(
      '当前窗口没有挂载 preload，无法调用主进程。' +
      '这通常意味着窗口配置里的 preload 路径不对或 preload 加载失败。'
    );
  }
  // eslint-disable-next-line global-require
  return require('electron');
}

/**
 * 按通道名调用。方法名映射与 preload 保持一致：kebab → camel。
 *
 * 注意：这个函数**不是**给组件用的通用 invoke。
 * 它存在的唯一理由是过渡期要兼容 `require`，
 * A5 之后它会被删掉，组件改用具名方法。
 */
function toMethodName(channel) {
  return channel.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 调用主进程通道。
 *
 * @param {string} channel kebab-case 通道名
 * @param {*} [payload]
 * @returns {Promise<*>}
 */
export function invoke(channel, payload) {
  if (hasBridge()) {
    const method = toMethodName(channel);
    const fn = window.worklog[method];
    if (typeof fn !== 'function') {
      // preload 的白名单里没有这个方法：说明调用方要的能力不该给它。
      // 明确抛错而不是静默返回 undefined，否则会变成难查的「没反应」。
      throw new Error(`当前窗口没有调用该通道的权限: ${channel}`);
    }
    return fn(payload);
  }
  // 过渡期：窗口还没挂 preload，走老的 ipcRenderer
  return legacy().ipcRenderer.invoke(channel, payload);
}

/**
 * 订阅主进程推送，返回取消订阅函数。
 *
 * 统一成返回函数的形式：老的 ipcRenderer.on 不返回任何东西，
 * 组件容易忘记 removeListener，重复挂载时会累积监听器。
 */
export function on(eventName, handler) {
  if (hasBridge()) {
    // preload 的 on 传的是纯 payload，而 App.vue 里既有的 handler 签名是
    // (event, payload)。这里补一个占位的 event，让两种签名都能用——
    // 否则 61 处调用中依赖 (event, payload) 的那些会静默拿到错误参数。
    return window.worklog.on(eventName, (payload) => handler(null, payload));
  }
  const { ipcRenderer } = legacy();
  ipcRenderer.on(eventName, handler);
  return () => ipcRenderer.removeListener(eventName, handler);
}

/**
 * 复制文本到剪贴板。
 *
 * 为什么不直接暴露 electron.clipboard：那是整个剪贴板模块，
 * 包含读能力。这里只需要「写一段文本」，收窄到刚好够用。
 */
export function writeClipboard(text) {
  if (hasBridge() && typeof window.worklog.writeClipboard === 'function') {
    return window.worklog.writeClipboard(text);
  }
  return legacy().clipboard.writeText(text);
}

/**
 * 打开外部链接。
 *
 * 渲染层不决定打开什么——只把 URL 交给主进程，由主进程按白名单校验（B2）。
 * 直接暴露 shell.openExternal 等于把「能打开任意协议」的能力交给渲染层。
 */
export function openExternal(url) {
  if (hasBridge() && typeof window.worklog.openExternal === 'function') {
    return window.worklog.openExternal(url);
  }
  return legacy().shell.openExternal(url);
}

/** 供测试与诊断：当前是否已走 preload */
export function isBridged() {
  return hasBridge();
}

/**
 * 组件用的统一入口。
 *
 * 保留 `ipc.invoke(...)` 这种形状，是为了让 6 个文件的迁移只改一行 import，
 * 而不是把几十处调用逐个改名。方法名不必"更好看"——
 * 少一次机械改动就少一次引入错误的机会。
 */
export const ipc = { invoke };
