'use strict';

/**
 * 外部链接白名单 —— 渲染层不能决定打开什么。
 *
 * 为什么不能简单规定「只允许 https」：
 *   桥接页是 http://127.0.0.1:<动态端口>。端口每次启动都不同，
 *   协议永远是 http。一刀切禁掉 http 等于废掉「打开桥接页」这个功能。
 *
 * 所以规则是两类：
 *   · 本机桥接地址：http + 127.0.0.1/localhost + **当前实际监听的端口**，精确匹配
 *   · 其他链接：只允许 https
 *
 * 端口由主进程提供，不从渲染层传。前端传端口等于让渲染层决定白名单。
 */

const crypto = require('crypto');

/** 本机可接受的主机名（精确相等，不做包含判断） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 判断一个 URL 是否允许被打开。
 *
 * @param {string} raw 渲染层递交的地址
 * @param {object} ctx
 * @param {number|null} ctx.localPort 当前桥接服务监听的端口
 * @returns {{ ok: boolean, reason?: string }}
 */
function check(raw, ctx) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'empty' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return { ok: false, reason: 'unparsable' };
  }

  // 带凭据的地址一律拒绝：https://user:pass@host 常被用来伪装真实主机
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials' };
  }

  if (url.protocol === 'https:') {
    return { ok: true };
  }

  if (url.protocol !== 'http:') {
    // file: / javascript: / data: / vbscript: 等
    return { ok: false, reason: 'protocol' };
  }

  // http 只允许本机桥接的精确地址
  const port = ctx && ctx.localPort;
  if (!port) return { ok: false, reason: 'no-bridge' };
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: 'not-loopback' };
  if (url.port !== String(port)) return { ok: false, reason: 'wrong-port' };

  return { ok: true };
}

/**
 * 一次性票据（one-time code）。
 *
 * 为什么需要：桥接 Token 是长期凭据，拼在 URL 查询串里会留下这些痕迹：
 *   · 浏览器历史（用户下次输 127.0.0.1 时可能从联想里弹出来）
 *   · Referer（桥接页一旦引用外部资源就带出去）
 *   · 用户截图反馈问题时一并泄漏
 *   · 浏览器扩展可读当前 URL
 *
 * 改成一次性票据后，漏出去的都是一次性废码：60 秒有效、用过即删、
 * 绑定端口。长期 Token 不再出现在任何 URL 里。
 */
const DEFAULT_TTL_MS = 60 * 1000;

class TicketStore {
  constructor(options) {
    const opts = options || {};
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.nodes = new Map();
    this.now = opts.now || (() => Date.now());
  }

  /** 发一张票据，绑定端口 */
  issue(port) {
    const code = crypto.randomBytes(32).toString('base64url');
    this.nodes.set(code, { port, expiresAt: this.now() + this.ttlMs });
    this._sweep();
    return code;
  }

  /**
   * 兑换。成功即作废（single-use）。
   *
   * @returns {{ ok: boolean, port?: number, reason?: string }}
   */
  redeem(code, port) {
    if (typeof code !== 'string' || code === '') return { ok: false, reason: 'missing' };
    const entry = this.nodes.get(code);
    if (!entry) return { ok: false, reason: 'unknown' };
    if (this.now() > entry.expiresAt) {
      this.nodes.delete(code);
      return { ok: false, reason: 'expired' };
    }
    // 端口必须对得上：票据从一个端口发出，不能拿到另一个端口去换
    if (port !== undefined && entry.port !== port) {
      this.nodes.delete(code);
      return { ok: false, reason: 'wrong-port' };
    }
    this.nodes.delete(code);
    return { ok: true, port: entry.port };
  }

  /** 清理过期票据，避免长期运行时 Map 只增不减 */
  _sweep() {
    const now = this.now();
    for (const [code, entry] of this.nodes) {
      if (now > entry.expiresAt) this.nodes.delete(code);
    }
  }

  get size() {
    return this.nodes.size;
  }
}

module.exports = {
  check,
  TicketStore,
  LOOPBACK_HOSTS,
  DEFAULT_TTL_MS
};
