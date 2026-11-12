'use strict';

/**
 * 本地桥接服务的来源策略。
 *
 * 先把一件事说清楚：**CORS 不是身份验证。**
 *
 *   CORS 是浏览器执行同源策略的机制，它只约束「浏览器里的脚本能不能读响应」。
 *   它对 curl、脚本、任何非浏览器客户端完全无效——那些请求根本不看 CORS 头。
 *
 *   所以 CORS 收紧只能减少「浏览器端被跨站读取」，真正的认证必须靠 Token。
 *   这句话写在这里，是因为很容易有人在某天看到「CORS 已经设好了」
 *   就以为这个服务安全了。
 *
 * 三层叠加，缺一不可：
 *   · 绑定 127.0.0.1  → 挡住局域网
 *   · Origin 校验     → 挡住浏览器跨站读取
 *   · Token           → 真正的身份认证
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** 默认允许的来源端口：常见开发服务器 + 空（默认 80） */
const DEFAULT_ALLOWED_PORTS = new Set(['', '80', '3000', '5173', '5174', '8080', '8000']);

/**
 * 判断一个 Origin 是否可信。
 *
 * 必须用 URL 解析后逐项比对，不能用字符串包含或前缀判断：
 *   origin.includes('localhost')      → http://evil-localhost.com 也会通过
 *   origin.startsWith('http://127.')  → http://127.0.0.1.evil.com 也会通过
 *
 * @param {string|undefined} origin
 * @param {object} [options]
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkOrigin(origin, options) {
  const opts = options || {};
  const allowedPorts = opts.allowedPorts || DEFAULT_ALLOWED_PORTS;

  // 没有 Origin 头：非浏览器客户端（curl 等）。
  // 这里不做 CORS 判断——但也绝不意味着放行，Token 校验仍然必须通过。
  if (origin === undefined || origin === null || origin === '') {
    return { ok: true, anonymous: true };
  }

  if (origin === 'null') {
    // 沙箱 iframe / 某些重定向会给出字符串 "null"，不可信
    return { ok: false, reason: 'null-origin' };
  }

  let url;
  try {
    url = new URL(origin);
  } catch (_) {
    return { ok: false, reason: 'unparsable' };
  }

  if (url.protocol !== 'http:') {
    return { ok: false, reason: 'protocol' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials' };
  }
  // hostname 是精确相等，不是包含——这是本模块的关键
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: 'not-loopback' };
  }
  // 带路径的 Origin 不合法（浏览器不会这么发，出现就说明是伪造的）
  if (url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, reason: 'malformed' };
  }
  if (!allowedPorts.has(url.port)) {
    return { ok: false, reason: 'port' };
  }

  return { ok: true };
}

/**
 * 生成 CORS 响应头。
 *
 * 拒绝时返回 `Access-Control-Allow-Origin: null`（不写头也一样），
 * 但**不改变 HTTP 状态码**——状态码是给请求方的，CORS 头是给浏览器的。
 * 混在一起会让 curl 调试时看到莫名其妙的 403。
 */
function headersFor(origin, options) {
  const verdict = checkOrigin(origin, options);
  const base = {
    'Access-Control-Allow-Headers': 'Authorization, X-WorkLog-Token, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin'
  };
  if (verdict.ok && origin) {
    base['Access-Control-Allow-Origin'] = origin;
  }
  return { headers: base, verdict };
}

module.exports = {
  checkOrigin,
  headersFor,
  LOOPBACK_HOSTS,
  DEFAULT_ALLOWED_PORTS
};
