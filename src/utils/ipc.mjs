/**
 * ipc.mjs — 渲染层调用主进程的唯一入口
 *
 * 三个窗口都已关闭 nodeIntegration（A3b/A4），渲染层不再有 `require`。
 * 唯一的通路是 preload 通过 contextBridge 暴露的 `window.worklog`。
 *
 * 这一层保留的原因不是兼容，而是两点：
 *   1. 组件不直接依赖全局对象，测试里可以替换它
 *   2. 通道名到方法名的映射只写一次，而不是每个调用点各写一次
 *
 * 有一件事这里刻意不做：**不提供通用 invoke 的兜底**。
 * preload 里没有的方法就是没有——直接抛错。静默返回 undefined
 * 会变成「点了没反应」，那种 bug 的排查成本远高于一次明确的异常。
 */

/* eslint-disable no-undef */

/**
 * 取 preload 暴露的桥。
 *
 * 没有桥时直接抛错而不是返回空对象：那意味着 preload 没挂上，
 * 是打包或窗口配置的问题，不是调用写错了。把话说清楚。
 */
function bridge() {
  const api = typeof window !== 'undefined' ? window.worklog : null;
  if (!api) {
    throw new Error(
      '当前窗口没有挂载 preload，无法调用主进程。' +
      '这通常意味着窗口配置里的 preload 路径不对或 preload 加载失败。'
    );
  }
  return api;
}

/** 通道名 → preload 方法名（kebab → camel） */
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
  const api = bridge();
  const method = toMethodName(channel);
  const fn = api[method];
  if (typeof fn !== 'function') {
    // 这个窗口的角色白名单里没有该方法：调用方要的能力不该给它。
    throw new Error(`当前窗口没有调用该通道的权限: ${channel}`);
  }
  return fn(payload);
}

/**
 * 订阅主进程推送，返回取消订阅函数。
 *
 * preload 的 on 传的是纯 payload，而 App.vue 里既有的 handler 签名是
 * (event, payload)。这里补一个占位的 event，让两种签名都能用——
 * 否则依赖两个参数的 handler 会静默拿到错位的数据。
 */
export function on(eventName, handler) {
  return bridge().on(eventName, (payload) => handler(null, payload));
}

/**
 * 复制文本到剪贴板。
 *
 * 只暴露写能力：electron.clipboard 还能读，而这里不需要读。
 */
export function writeClipboard(text) {
  return bridge().writeClipboard(text);
}

/**
 * 打开外部链接。
 *
 * 渲染层不决定打开什么——只把 URL 交出去，由主进程按白名单校验（B2）。
 */
export function openExternal(url) {
  return bridge().openExternal(url);
}

/** 供测试与诊断：当前窗口是否已挂载 preload */
export function isBridged() {
  try {
    bridge();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 组件用的统一入口。
 *
 * 保留 `ipc.invoke(...)` 这种形状，是为了让组件迁移只改一行 import，
 * 而不是把几十处调用逐个改名。少一次机械改动就少一次引入错误的机会。
 */
export const ipc = { invoke };
