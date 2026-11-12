'use strict';

/**
 * apiServer.js — 本地 HTTP 接口
 *
 * 只绑定 127.0.0.1，仅允许 GET，必须携带 token。
 * 目的是让外部 AI / 脚本 / 快捷指令能读到已经聚合好的工时数据。
 *
 * 默认端口 47821，被占用时自动向后顺延。
 */

const http = require('http');
const crypto = require('crypto');
const url = require('url');
const analytics = require('./analytics');

const DEFAULT_PORT = 47821;
const MAX_PORT_TRIES = 20;

const corsPolicy = require('./corsPolicy');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 写 JSON 响应。
 *
 * `origin` 由调用方从请求头取来，交给 corsPolicy 决定是否回写
 * Access-Control-Allow-Origin。以前固定写 '*'——那等于告诉浏览器
 * 「任何站点都可以读这个响应」。
 *
 * 提醒：CORS 只对浏览器有效。curl 不看这些头，认证靠 Token。
 */
function jsonRes(res, status, payload, origin) {
  const body = JSON.stringify(payload, null, 2);
  const { headers } = corsPolicy.headersFor(origin);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, headers));
  res.end(body);
}

function textRes(res, status, text, contentType, origin) {
  const { headers } = corsPolicy.headersFor(origin);
  res.writeHead(status, Object.assign({
    'Content-Type': contentType || 'text/markdown; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  }, headers));
  res.end(text);
}

function todayStr() {
  return analytics.toDateStr(new Date());
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return analytics.toDateStr(d);
}

/** 路由表：把 URL 映射到 handler，handler 返回 { status, body, contentType } */
class ApiServer {
  constructor(options) {
    this.getDataDir = options.getDataDir;
    this.getConfig = options.getConfig || (() => ({}));
    this.token = options.token || generateToken();
    // 一次性票据库由主进程注入。没有它时 /auth/exchange 会拒绝，
    // 而不是退化成「任何码都能换」。
    this.ticketStore = options.ticketStore || null;
    // 0 是合法值（让系统分配端口）。用 || 会把 0 当成「没给」，
    // 于是每次都落在默认端口上——多实例或测试并行时会互相抢端口，
    // 表现为随机的 ECONNRESET，与真正的端口冲突长得一模一样。
    this.basePort = options.port === undefined || options.port === null
      ? DEFAULT_PORT
      : options.port;
    this.port = null;
    this.server = null;
    this.startedAt = null;
    this.lastError = null;
  }

  getToken() {
    return this.token;
  }

  setToken(token) {
    this.token = token || generateToken();
    return this.token;
  }

  isRunning() {
    return !!(this.server && this.server.listening);
  }

  getStatus() {
    return {
      running: this.isRunning(),
      port: this.port,
      basePort: this.basePort,
      token: this.token,
      url: this.isRunning() ? `http://127.0.0.1:${this.port}` : null,
      startedAt: this.startedAt,
      lastError: this.lastError
    };
  }

  // -- 鉴权 --------------------------------------------------------------

  /**
   * 用一次性票据换长期 Token。
   *
   * 请求：POST /auth/exchange  { "otc": "<一次性码>" }
   * 响应：{ ok: true, token: "..." }
   *
   * 票据由主进程在打开桥接页时签发，60 秒有效、绑定端口、用过即删。
   * 这样 URL 里不带长期凭据——漏出去的只是一次性废码。
   */
  _handleExchange(req, res, origin) {
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      // 防止有人用超大 body 打满内存
      if (body.length > 4096) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('error', () => {
      if (!aborted) jsonRes(res, 400, { ok: false, error: 'bad_request' }, origin);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (_) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_json' }, origin);
      }

      const store = this.ticketStore;
      if (!store) {
        return jsonRes(res, 500, { ok: false, error: 'exchange_unavailable' }, origin);
      }

      const result = store.redeem(payload.otc, this.port);
      if (!result.ok) {
        // 不区分「不存在」「过期」「用过了」：对外只报一种失败，
        // 免得把「这个码曾经存在」也变成信息。
        return jsonRes(res, 401, { ok: false, error: 'invalid_ticket' }, origin);
      }

      return jsonRes(res, 200, { ok: true, token: this.token }, origin);
    });
  }

  _authorized(req, query) {
    const auth = req.headers['authorization'] || '';
    let provided = '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      provided = auth.slice(7).trim();
    } else if (req.headers['x-worklog-token']) {
      provided = String(req.headers['x-worklog-token']).trim();
    } else if (query.token) {
      provided = String(query.token).trim();
    }
    if (!provided || provided.length !== this.token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(this.token));
    } catch (e) {
      return false;
    }
  }

  // -- 路由 --------------------------------------------------------------

  _handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    const query = parsed.query || {};
    // Origin 只用来看「浏览器允不允许读」，不是身份，也不是访问控制
    const origin = req.headers.origin;

    if (req.method === 'OPTIONS') {
      const { headers } = corsPolicy.headersFor(origin);
      res.writeHead(204, headers);
      return res.end();
    }

    // 一次性票据换长期 Token。
    // 这是在 URL 里传凭据的替代方案：漏出去的只有 60 秒有效、用完即废的码。
    if (pathname === '/auth/exchange' && req.method === 'POST') {
      return this._handleExchange(req, res, origin);
    }

    if (req.method !== 'GET') {
      return jsonRes(res, 405, { error: 'method_not_allowed', message: '仅支持 GET' }, origin);
    }

    const dataDir = this.getDataDir();
    if (!dataDir) {
      return jsonRes(res, 500, { error: 'no_data_dir', message: '尚未确定数据目录' }, origin);
    }

    // /health 不需要 token，便于探活
    if (pathname === '/health') {
      let dateCount = 0;
      try { dateCount = analytics.listDates(dataDir).length; } catch (e) { /* ignore */ }
      return jsonRes(res, 200, {
        ok: true,
        service: 'worklog-assistant',
        version: this.getConfig().version || null,
        dataDir,
        dateCount,
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0
      }, origin);
    }

    if (!this._authorized(req, query)) {
      return jsonRes(res, 401, {
        error: 'unauthorized',
        message: '需要 token。用 Authorization: Bearer <token> 或 ?token=<token>'
      }, origin);
    }

    const detail = ['compact', 'normal', 'full'].includes(query.detail) ? query.detail : 'normal';
    const format = query.format === 'json' ? 'json' : 'md';

    try {
      // 根路径：给人看的说明页
      if (pathname === '/') {
        return textRes(res, 200, this._landingHtml(dataDir), 'text/html; charset=utf-8', origin);
      }

      if (pathname === '/openapi.json') {
        return jsonRes(res, 200, this._openApiSpec(), origin);
      }

      // 有数据的日期列表
      if (pathname === '/api/dates') {
        const dates = analytics.listDates(dataDir);
        const limit = Math.min(parseInt(query.limit, 10) || 0, 1000);
        const list = limit > 0 ? dates.slice(-limit) : dates;
        return jsonRes(res, 200, {
          count: dates.length,
          first: dates[0] || null,
          last: dates[dates.length - 1] || null,
          dates: list
        }, origin);
      }

      // 单日报告
      if (pathname === '/api/report/day' || pathname === '/api/day') {
        const date = DATE_RE.test(query.date || '') ? query.date : todayStr();
        const report = analytics.buildDayReport(dataDir, date, this.getConfig().analysis);
        if (format === 'json') return jsonRes(res, 200, report, origin);
        return textRes(res, 200, analytics.renderDayMarkdown(report, detail), undefined, origin);
      }

      // 区间报告
      if (pathname === '/api/report/range' || pathname === '/api/range') {
        const to = DATE_RE.test(query.to || '') ? query.to : todayStr();
        const from = DATE_RE.test(query.from || '') ? query.from : shiftDate(to, -6);
        if (from > to) {
          return jsonRes(res, 400, { error: 'bad_range', message: 'from 必须早于或等于 to' }, origin);
        }
        const report = analytics.buildRangeReport(dataDir, from, to, { detail, ...(this.getConfig().analysis || {}) });
        if (format === 'json') return jsonRes(res, 200, report, origin);
        return textRes(res, 200, analytics.renderRangeMarkdown(report, detail), undefined, origin);
      }

      // 纯应用排行
      if (pathname === '/api/apps') {
        const to = DATE_RE.test(query.to || '') ? query.to : todayStr();
        const from = DATE_RE.test(query.from || '') ? query.from : to;
        const report = analytics.buildRangeReport(dataDir, from, to, { detail, ...(this.getConfig().analysis || {}) });
        return jsonRes(res, 200, {
          from, to,
          totalMs: report.stats.trackedMs,
          apps: report.apps,
          categories: report.categories
        }, origin);
      }

      // 关键词检索
      if (pathname === '/api/search') {
        const q = String(query.q || query.query || '').trim();
        if (!q) {
          return jsonRes(res, 400, { error: 'missing_query', message: '需要 q 参数' }, origin);
        }
        const to = DATE_RE.test(query.to || '') ? query.to : todayStr();
        const from = DATE_RE.test(query.from || '') ? query.from : shiftDate(to, -6);
        return jsonRes(res, 200, analytics.searchActivities(dataDir, q, from, to), origin);
      }

      // 某天已生成的 AI 摘要（应用内 summarizer 产出的）
      if (pathname === '/api/summaries') {
        const fs = require('fs');
        const path = require('path');
        const date = DATE_RE.test(query.date || '') ? query.date : todayStr();
        const file = path.join(dataDir, 'summaries', `${date}.json`);
        let items = [];
        try {
          if (fs.existsSync(file)) {
            items = JSON.parse(fs.readFileSync(file, 'utf8'));
          }
        } catch (e) { /* ignore */ }
        return jsonRes(res, 200, {
          date,
          count: Array.isArray(items) ? items.length : 0,
          summaries: (Array.isArray(items) ? items : []).map(s => ({
            timestamp: s.timestamp,
            startTime: s.startTime,
            endTime: s.endTime,
            activityCount: s.activityCount,
            summary: s.summary
          }))
        }, origin);
      }

      return jsonRes(res, 404, {
        error: 'not_found',
        message: `未知路径 ${pathname}`,
        hint: '访问 / 查看可用端点'
      }, origin);
    } catch (error) {
      this.lastError = error.message;
      return jsonRes(res, 500, { error: 'internal_error', message: error.message }, origin);
    }
  }

  // -- 说明页 / OpenAPI --------------------------------------------------

  /**
   * 落地页。
   *
   * A2 版本把 Token 直接印在页面上、写进每个示例链接里。
   * 那意味着只要这个页面被截图、被同步、被浏览器缓存，
   * 长期凭据就跟着走了。
   *
   * 现在页面不主动包含 Token：它从 URL 的 ?otc= 取一次性码，
   * 换成真 Token 后存进 sessionStorage（关掉标签页即失效），
   * 再拿它渲染示例。URL 里只留一个 60 秒有效、用过即废的码。
   */
  _landingHtml(dataDir) {
    const base = `http://127.0.0.1:${this.port}`;
    const endpoints = [
      ['/health', '探活（免 token）'],
      ['/api/dates', '有记录的日期'],
      ['/api/report/day?date=2026-03-30&detail=normal', '单日报告（Markdown）'],
      ['/api/report/day?date=2026-03-30&format=json', '单日报告（JSON）'],
      ['/api/report/range?from=2026-03-23&to=2026-03-30', '区间报告'],
      ['/api/apps?from=2026-03-23&to=2026-03-30', '应用时长排行'],
      ['/api/search?q=邮e联&from=2026-03-23', '关键词检索'],
      ['/api/summaries?date=2026-03-30', '应用内已生成的 AI 摘要']
    ];
    const rows = endpoints.map(([p, d]) =>
      `<tr><td><a data-path="${p}" href="#">${p}</a></td><td>${d}</td></tr>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>WorkLog Assistant 本地接口</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;background:#0d0d0d;color:#e6e6e6;
       max-width:860px;margin:0 auto;padding:32px 24px;line-height:1.7}
  h1{font-size:20px;font-weight:600;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:24px}
  code,pre{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
  code{background:#1c1c1c;padding:2px 6px;border-radius:4px;color:#7ec8a9}
  pre{background:#161616;border:1px solid #262626;border-radius:8px;padding:14px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  td{border-bottom:1px solid #202020;padding:7px 8px;font-size:13px;vertical-align:top}
  td:last-child{color:#999}
  a{color:#6ea8fe;text-decoration:none}
  a:hover{text-decoration:underline}
  h2{font-size:14px;font-weight:600;margin:28px 0 8px;color:#bbb}
  .token{color:#e0a458}
  .warn{background:#2a1d0d;border:1px solid #4a3418;border-radius:8px;padding:12px 14px;
        font-size:13px;color:#e0b070;margin:16px 0}
</style></head><body>
<h1>WorkLog Assistant 本地接口</h1>
<div class="sub">数据目录：<code>${dataDir}</code></div>

<div id="state" class="warn">正在用一次性码换取 Token…</div>

<p>Token：<code class="token" id="tok">（未取到）</code>
   <span style="color:#888;font-size:12.5px">放 <code>Authorization: Bearer &lt;token&gt;</code></span></p>

<h2>端点</h2>
<table>${rows}</table>

<h2>curl 示例</h2>
<pre id="curl">curl -H "Authorization: Bearer &lt;token&gt;" \\
  "${base}/api/report/day?date=2026-03-30"</pre>

<h2>detail 三档</h2>
<p style="font-size:13px;color:#999">compact 只要汇总；normal 含应用时长与时间线；full 含全部会话明细。</p>

<script>
(function () {
  // 一次性码来自 URL，换到 Token 后立刻从地址栏抹掉，
  // 避免它随历史记录/截图/Referer 一起流出去。
  var url = new URL(location.href);
  var otc = url.searchParams.get('otc');
  if (otc) {
    url.searchParams.delete('otc');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  var stored = sessionStorage.getItem('worklog-token');
  if (!otc && !stored) {
    document.getElementById('state').textContent =
      '这个页面需要从应用内打开（会带一次性码）。直接访问看不到 Token。';
    return;
  }

  function ready(token) {
    sessionStorage.setItem('worklog-token', token);
    document.getElementById('tok').textContent = token;
    document.getElementById('state').style.display = 'none';
    document.getElementById('curl').textContent =
      'curl -H "Authorization: Bearer ' + token + '" \\\\n  "' + location.origin + '/api/report/day?date=2026-03-30"';
    return token;
  }

  function link(token, path) {
    return fetch(path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token))
      .then(function () { return path; });
  }

  document.querySelectorAll('a[data-path]').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      var token = sessionStorage.getItem('worklog-token');
      if (!token) return;
      var path = a.getAttribute('data-path');
      // 本地页面内跳转，token 只在这一个请求里出现
      location.href = path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
    });
  });

  if (otc) {
    fetch('/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otc: otc })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.token) { ready(d.token); }
        else {
          document.getElementById('state').textContent =
            '一次性码已失效（有效期 60 秒且只能用一次）。请从应用内重新打开。';
        }
      })
      .catch(function () {
        document.getElementById('state').textContent = '换取 Token 失败，请从应用内重新打开。';
      });
  } else if (stored) {
    ready(stored);
  }
})();
</script>
</body></html>`;
  }

  _openApiSpec() {
    return {
      openapi: '3.0.3',
      info: {
        title: 'WorkLog Assistant Local API',
        version: '1.0.0',
        description: '读取本机工作活动记录并生成聚合报告。所有接口需 Bearer token。'
      },
      servers: [{ url: `http://127.0.0.1:${this.port}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      security: [{ bearerAuth: [] }],
      paths: {
        '/health': { get: { summary: '探活', security: [], responses: { 200: { description: 'OK' } } } },
        '/api/dates': {
          get: {
            summary: '有活动记录的日期列表',
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
            responses: { 200: { description: '日期数组' } }
          }
        },
        '/api/report/day': {
          get: {
            summary: '单日报告',
            parameters: [
              { name: 'date', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD，默认今天' },
              { name: 'detail', in: 'query', schema: { type: 'string', enum: ['compact', 'normal', 'full'] } },
              { name: 'format', in: 'query', schema: { type: 'string', enum: ['md', 'json'] } }
            ],
            responses: { 200: { description: '报告' } }
          }
        },
        '/api/report/range': {
          get: {
            summary: '区间报告',
            parameters: [
              { name: 'from', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD' },
              { name: 'to', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD' },
              { name: 'detail', in: 'query', schema: { type: 'string', enum: ['compact', 'normal', 'full'] } },
              { name: 'format', in: 'query', schema: { type: 'string', enum: ['md', 'json'] } }
            ],
            responses: { 200: { description: '报告' } }
          }
        },
        '/api/apps': {
          get: {
            summary: '应用时长排行',
            parameters: [
              { name: 'from', in: 'query', schema: { type: 'string' } },
              { name: 'to', in: 'query', schema: { type: 'string' } }
            ],
            responses: { 200: { description: '排行' } }
          }
        },
        '/api/search': {
          get: {
            summary: '按应用名或窗口标题关键词检索',
            parameters: [
              { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'from', in: 'query', schema: { type: 'string' } },
              { name: 'to', in: 'query', schema: { type: 'string' } }
            ],
            responses: { 200: { description: '命中记录' } }
          }
        },
        '/api/summaries': {
          get: {
            summary: '应用内已生成的 AI 摘要',
            parameters: [{ name: 'date', in: 'query', schema: { type: 'string' } }],
            responses: { 200: { description: '摘要列表' } }
          }
        }
      }
    };
  }

  // -- 生命周期 ----------------------------------------------------------

  start() {
    return new Promise((resolve) => {
      const attempt = (port, tries) => {
        const server = http.createServer((req, res) => {
          try {
            this._handle(req, res);
          } catch (error) {
            this.lastError = error.message;
            try {
              jsonRes(res, 500, { error: 'internal_error', message: error.message }, req.headers.origin);
            } catch (e) { /* 响应已经开始写了，无法再改状态码 */ }
          }
        });

        server.on('error', (error) => {
          if (error.code === 'EADDRINUSE' && tries < MAX_PORT_TRIES) {
            return attempt(port + 1, tries + 1);
          }
          this.lastError = `${error.code || 'ERROR'}: ${error.message}`;
          this.server = null;
          this.port = null;
          resolve({ ok: false, error: this.lastError });
        });

        server.listen(port, '127.0.0.1', () => {
          // 用 address().port 而不是传入的 port：传 0 时系统会分配一个，
          // 记成 0 会让票据的端口绑定校验永远失败（0 !== 实际端口）。
          const actual = server.address() && server.address().port;
          this.server = server;
          this.port = actual || port;
          this.startedAt = Date.now();
          this.lastError = null;
          resolve({ ok: true, port: this.port, url: `http://127.0.0.1:${this.port}` });
        });
      };

      attempt(this.basePort, 0);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve({ ok: true });
      const s = this.server;
      this.server = null;
      this.port = null;
      this.startedAt = null;
      s.close(() => resolve({ ok: true }));
    });
  }
}

module.exports = { ApiServer, generateToken, DEFAULT_PORT };
