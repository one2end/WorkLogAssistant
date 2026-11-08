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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function jsonRes(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, X-WorkLog-Token, Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function textRes(res, status, text, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/markdown; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, X-WorkLog-Token, Content-Type',
    'Cache-Control': 'no-store'
  });
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
    this.basePort = options.port || DEFAULT_PORT;
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

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-WorkLog-Token, Content-Type',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }

    if (req.method !== 'GET') {
      return jsonRes(res, 405, { error: 'method_not_allowed', message: '仅支持 GET' });
    }

    const dataDir = this.getDataDir();
    if (!dataDir) {
      return jsonRes(res, 500, { error: 'no_data_dir', message: '尚未确定数据目录' });
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
      });
    }

    if (!this._authorized(req, query)) {
      return jsonRes(res, 401, {
        error: 'unauthorized',
        message: '需要 token。用 Authorization: Bearer <token> 或 ?token=<token>'
      });
    }

    const detail = ['compact', 'normal', 'full'].includes(query.detail) ? query.detail : 'normal';
    const format = query.format === 'json' ? 'json' : 'md';

    try {
      // 根路径：给人看的说明页
      if (pathname === '/') {
        return textRes(res, 200, this._landingHtml(dataDir), 'text/html; charset=utf-8');
      }

      if (pathname === '/openapi.json') {
        return jsonRes(res, 200, this._openApiSpec());
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
        });
      }

      // 单日报告
      if (pathname === '/api/report/day' || pathname === '/api/day') {
        const date = DATE_RE.test(query.date || '') ? query.date : todayStr();
        const report = analytics.buildDayReport(dataDir, date, this.getConfig().analysis);
        if (format === 'json') return jsonRes(res, 200, report);
        return textRes(res, 200, analytics.renderDayMarkdown(report, detail));
      }

      // 区间报告
      if (pathname === '/api/report/range' || pathname === '/api/range') {
        const to = DATE_RE.test(query.to || '') ? query.to : todayStr();
        const from = DATE_RE.test(query.from || '') ? query.from : shiftDate(to, -6);
        if (from > to) {
          return jsonRes(res, 400, { error: 'bad_range', message: 'from 必须早于或等于 to' });
        }
        const report = analytics.buildRangeReport(dataDir, from, to, { detail, ...(this.getConfig().analysis || {}) });
        if (format === 'json') return jsonRes(res, 200, report);
        return textRes(res, 200, analytics.renderRangeMarkdown(report, detail));
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
        });
      }

      // 关键词检索
      if (pathname === '/api/search') {
        const q = String(query.q || query.query || '').trim();
        if (!q) {
          return jsonRes(res, 400, { error: 'missing_query', message: '需要 q 参数' });
        }
        const to = DATE_RE.test(query.to || '') ? query.to : todayStr();
        const from = DATE_RE.test(query.from || '') ? query.from : shiftDate(to, -6);
        return jsonRes(res, 200, analytics.searchActivities(dataDir, q, from, to));
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
        });
      }

      return jsonRes(res, 404, {
        error: 'not_found',
        message: `未知路径 ${pathname}`,
        hint: '访问 / 查看可用端点'
      });
    } catch (error) {
      this.lastError = error.message;
      return jsonRes(res, 500, { error: 'internal_error', message: error.message });
    }
  }

  // -- 说明页 / OpenAPI --------------------------------------------------

  _landingHtml(dataDir) {
    const base = `http://127.0.0.1:${this.port}`;
    const t = this.token;
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
      `<tr><td><a href="${base}${p}&token=${t}">${p}</a></td><td>${d}</td></tr>`
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
</style></head><body>
<h1>WorkLog Assistant 本地接口</h1>
<div class="sub">数据目录：<code>${dataDir}</code></div>
<p>Token：<code class="token">${t}</code>（放 <code>Authorization: Bearer &lt;token&gt;</code> 或 <code>?token=</code>）</p>
<h2>端点</h2>
<table>${rows}</table>
<h2>curl 示例</h2>
<pre>curl -H "Authorization: Bearer ${t}" \\
  "${base}/api/report/day?date=${todayStr()}"</pre>
<h2>detail 三档</h2>
<p style="font-size:13px;color:#999">compact 只要汇总；normal 含应用时长与时间线；full 含全部会话明细。</p>
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
            try { jsonRes(res, 500, { error: 'internal_error', message: error.message }); } catch (e) { /* noop */ }
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
          this.server = server;
          this.port = port;
          this.startedAt = Date.now();
          this.lastError = null;
          resolve({ ok: true, port, url: `http://127.0.0.1:${port}` });
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
