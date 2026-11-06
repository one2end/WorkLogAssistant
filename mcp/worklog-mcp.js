#!/usr/bin/env node
'use strict';

/**
 * worklog-mcp.js — WorkLog Assistant 的 MCP Server（stdio）
 *
 * 独立进程，直接读磁盘上的活动数据，不要求桌面应用正在运行。
 * 只读，不修改任何文件。
 *
 * 数据目录解析顺序：
 *   1) 命令行 --data <dir>
 *   2) 环境变量 WORKLOG_DATA_DIR
 *   3) WorkLog Assistant 的 config.json 中 storage.customPath
 *   4) 平台默认的 userData/Data
 *
 * 协议：JSON-RPC 2.0，按行分隔（stdout 只允许输出协议消息）。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 加载共享的聚合模块。
 * 打包后 mcp/ 与 electron/analytics.js 会被 asarUnpack 到 app.asar.unpacked，
 * 这里做一次兜底，避免路径解析失败。
 */
function loadAnalytics() {
  const candidates = [
    path.join(__dirname, '..', 'electron', 'analytics.js'),
    path.join(__dirname, '..', 'app.asar.unpacked', 'electron', 'analytics.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'electron', 'analytics.js')
  ];
  let lastError = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('无法加载 analytics.js，请确认 mcp/ 与 electron/ 目录完整');
}

const analytics = loadAnalytics();

const SERVER_NAME = 'worklog-assistant';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// 数据目录解析
// ---------------------------------------------------------------------------

function appDataRoots() {
  const home = os.homedir();
  const roots = [];
  const appNames = ['worklog-assistant', 'WorkLog Assistant'];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const n of appNames) roots.push(path.join(appData, n));
  } else if (process.platform === 'darwin') {
    for (const n of appNames) roots.push(path.join(home, 'Library', 'Application Support', n));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const n of appNames) roots.push(path.join(xdg, n));
  }
  // 兼容旧版直接把 Data 放在用户主目录下的情况
  for (const n of appNames) roots.push(path.join(home, n));
  return roots;
}

function readConfigFrom(root) {
  try {
    const p = path.join(root, 'config.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function resolveDataDir(cliDataDir) {
  const candidates = [];

  if (cliDataDir) candidates.push(cliDataDir);
  if (process.env.WORKLOG_DATA_DIR) candidates.push(process.env.WORKLOG_DATA_DIR);

  for (const root of appDataRoots()) {
    const cfg = readConfigFrom(root);
    if (cfg && cfg.storage && cfg.storage.customPath) {
      candidates.push(cfg.storage.customPath);
      candidates.push(path.join(cfg.storage.customPath, 'Data'));
    }
    candidates.push(path.join(root, 'Data'));
    candidates.push(root);
  }

  // 逐个人工校验，优先返回真的含 activities 的
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, 'activities'))) return c;
    } catch (e) { /* noop */ }
  }
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

function dateOrToday(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
  return analytics.toDateStr(new Date());
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return analytics.toDateStr(d);
}

const TOOLS = [
  {
    name: 'worklog_list_dates',
    description: '列出这台电脑上有工作时间记录的日期，并给出连续可用的日期范围。当用户说「最近」「上周」「这个月」而你不确定具体哪天有数据时，先调这个。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '只返回最近 N 天，默认 30' }
      }
    }
  },
  {
    name: 'worklog_day_report',
    description: '获取某一天完整的电脑使用报告：有效工时、分类时长、应用时长排行、窗口标题、时间线、以及用户手记的杂念/待办。这是回答「我今天/某天做了什么、时间花在哪」的首选工具。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        detail: {
          type: 'string',
          enum: ['compact', 'normal', 'full'],
          description: 'compact 只要汇总；normal 含应用时长与时间线（默认）；full 含全部会话明细'
        }
      }
    }
  },
  {
    name: 'worklog_range_report',
    description: '获取一段时间的使用概览：每日有效时长对比、分类占比、跨天应用累计排行。用于周报、月度复盘、趋势判断。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD，默认今天' },
        days: { type: 'integer', description: '若未给 from，则取最近 N 天，默认 7' },
        detail: { type: 'string', enum: ['compact', 'normal', 'full'] }
      }
    }
  },
  {
    name: 'worklog_app_ranking',
    description: '只取应用/分类的时长排行（JSON），不含时间线与窗口标题。适合做占比计算、图表数据准备，token 开销最小。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        to: { type: 'string', description: 'YYYY-MM-DD，默认与 from 相同' },
        limit: { type: 'integer', description: '返回前 N 个应用，默认 20' }
      }
    }
  },
  {
    name: 'worklog_search',
    description: '按应用名或窗口标题关键词，在指定日期范围内检索历史活动。用于回答「我上次处理 XX 客户/项目是什么时候」「我多久没打开 XX 了」。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词，匹配应用名或窗口标题，例如 邮e联、商户、wps' },
        from: { type: 'string', description: 'YYYY-MM-DD，默认 7 天前' },
        to: { type: 'string', description: 'YYYY-MM-DD，默认今天' }
      },
      required: ['keyword']
    }
  },
  {
    name: 'worklog_timeline',
    description: '取某天的时间线：按应用连续停留折叠后的片段，可按开始/结束时间窗过滤、按最短时长过滤。用于还原「某个时段到底在干什么」。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        from_time: { type: 'string', description: 'HH:mm，例如 09:00' },
        to_time: { type: 'string', description: 'HH:mm，例如 12:00' },
        min_minutes: { type: 'integer', description: '只保留不短于 N 分钟的片段，默认 0' }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

function hmToMinutes(hm) {
  if (typeof hm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function makeHandlers(dataDir) {
  function requireDataDir() {
    if (!dataDir) {
      throw new Error('找不到 WorkLog 数据目录。请用 --data <目录> 指定，或在 WorkLog Assistant 设置里确认存储路径。');
    }
  }

  return {
    worklog_list_dates(args) {
      requireDataDir();
      const dates = analytics.listDates(dataDir);
      const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 30, 3650));
      const shown = dates.slice(-limit);
      const lines = [];
      lines.push(`共 ${dates.length} 天有记录，最早 ${dates[0] || '-'}，最近 ${dates[dates.length - 1] || '-'}。`);
      lines.push('');
      lines.push(`最近 ${shown.length} 天：`);
      lines.push(shown.join('、'));
      return lines.join('\n');
    },

    worklog_day_report(args) {
      requireDataDir();
      const date = dateOrToday(args.date);
      const detail = ['compact', 'normal', 'full'].includes(args.detail) ? args.detail : 'normal';
      const report = analytics.buildDayReport(dataDir, date);
      return analytics.renderDayMarkdown(report, detail);
    },

    worklog_range_report(args) {
      requireDataDir();
      const to = dateOrToday(args.to);
      const days = Math.max(1, Math.min(parseInt(args.days, 10) || 7, 366));
      const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from || '') ? args.from : shiftDate(to, -(days - 1));
      if (from > to) throw new Error('from 必须早于或等于 to');
      const detail = ['compact', 'normal', 'full'].includes(args.detail) ? args.detail : 'normal';
      const report = analytics.buildRangeReport(dataDir, from, to, { detail });
      return analytics.renderRangeMarkdown(report, detail);
    },

    worklog_app_ranking(args) {
      requireDataDir();
      const from = dateOrToday(args.from);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to || '') ? args.to : from;
      const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 20, 500));
      const report = analytics.buildRangeReport(dataDir, from, to);

      const payload = {
        from,
        to,
        activeDays: report.stats.activeDayCount,
        totalTrackedMs: report.stats.trackedMs,
        totalTrackedHuman: analytics.formatDuration(report.stats.trackedMs),
        categories: report.categories.map(c => ({
          name: c.name,
          human: analytics.formatDuration(c.durationMs),
          percent: Math.round(c.percent * 100)
        })),
        apps: report.apps.slice(0, limit).map(a => ({
          app: a.processName,
          category: a.category,
          human: analytics.formatDuration(a.durationMs),
          percent: Math.round(a.percent * 100),
          days: a.dayCount
        }))
      };
      return JSON.stringify(payload, null, 2);
    },

    worklog_search(args) {
      requireDataDir();
      const keyword = String(args.keyword || '').trim();
      if (!keyword) throw new Error('keyword 不能为空');
      const to = dateOrToday(args.to);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from || '') ? args.from : shiftDate(to, -6);
      const result = analytics.searchActivities(dataDir, keyword, from, to);

      const lines = [];
      lines.push(`检索「${keyword}」 ${from} ~ ${to}：命中 ${result.hitCount} 条，累计 ${analytics.formatDuration(result.totalDurationMs)}。`);
      lines.push('');
      if (result.hits.length === 0) {
        lines.push('没有匹配记录。');
        return lines.join('\n');
      }
      // 按天聚合
      const byDay = new Map();
      for (const h of result.hits) {
        const cur = byDay.get(h.date) || { count: 0, ms: 0, titles: new Set(), apps: new Set() };
        cur.count += 1;
        cur.ms += h.durationMs;
        if (h.title) cur.titles.add(h.title);
        cur.apps.add(h.app);
        byDay.set(h.date, cur);
      }
      lines.push('| 日期 | 命中 | 累计时长 | 应用 | 示例窗口 |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const [date, v] of Array.from(byDay.entries()).sort()) {
        const titles = Array.from(v.titles).slice(0, 2).join(' / ').replace(/\|/g, '/');
        lines.push(`| ${date} | ${v.count} | ${analytics.formatDuration(v.ms)} | ${Array.from(v.apps).join('、')} | ${titles} |`);
      }
      return lines.join('\n');
    },

    worklog_timeline(args) {
      requireDataDir();
      const date = dateOrToday(args.date);
      const report = analytics.buildDayReport(dataDir, date);
      if (!report.sessions.length) return `${date} 没有活动记录。`;

      const startMin = hmToMinutes(args.from_time);
      const endMin = hmToMinutes(args.to_time);
      const minMs = Math.max(0, (parseInt(args.min_minutes, 10) || 0) * 60000);

      const lines = [];
      lines.push(`# ${date} 时间线`);
      lines.push('');
      if (report.dataNotes.length) {
        lines.push(`数据提示：${report.dataNotes.join('；')}`);
        lines.push('');
      }

      let shown = 0;
      for (const s of report.sessions) {
        const d = new Date(s.start);
        const dayMin = d.getHours() * 60 + d.getMinutes();
        if (startMin !== null && dayMin < startMin) continue;
        if (endMin !== null && dayMin > endMin) continue;
        if (s.durationMs < minMs) continue;
        shown += 1;
        const mark = s.uncertain ? ' *(时长不确定)*' : '';
        const title = s.titles.length ? ` · ${s.titles.slice(0, 3).join(' / ')}` : '';
        lines.push(`- ${analytics.toHm(s.start)}–${analytics.toHm(s.end)}　${analytics.formatDuration(s.durationMs)}　${s.app}［${s.category}］${title}${mark}`);
      }

      if (shown === 0) {
        lines.push('该条件下没有片段。');
      } else {
        lines.push('');
        lines.push(`共 ${shown} 段，有效 ${analytics.formatDuration(report.stats.trackedMs)}。`);
      }
      return lines.join('\n');
    }
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC 传输
// ---------------------------------------------------------------------------

let buffer = '';

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: '2.0', id, error: err });
}

function logStderr(msg) {
  try {
    process.stderr.write(`[worklog-mcp] ${msg}\n`);
  } catch (e) { /* noop */ }
}

function main() {
  // 解析命令行
  const argv = process.argv.slice(2);
  let cliDataDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' && argv[i + 1]) {
      cliDataDir = argv[++i];
    } else if (a.startsWith('--data=')) {
      cliDataDir = a.slice(7);
    }
  }

  const dataDir = resolveDataDir(cliDataDir);
  logStderr(`data dir = ${dataDir}`);
  if (dataDir) {
    const dates = analytics.listDates(dataDir);
    logStderr(`found ${dates.length} day(s) of data`);
  }

  const handlers = makeHandlers(dataDir);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      handleMessage(line, handlers);
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

function handleMessage(line, handlers) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return replyError(null, -32700, 'Parse error');
  }

  if (Array.isArray(msg)) {
    // 批量请求
    const out = msg.map(m => processOne(m, handlers)).filter(Boolean);
    if (out.length) send(out);
    return;
  }

  const res = processOne(msg, handlers);
  if (res) send(res);
}

function processOne(msg, handlers) {
  const { id, method, params } = msg || {};

  // 通知（无 id）不需要响应
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: '这是本机 WorkLog Assistant 的工作时间数据。回答时间相关问题前，先用 worklog_list_dates 确认哪些日期有数据，再取具体报告。所有时长由窗口切换记录推断，超过 10 分钟的空档会被标记为不确定。'
        }
      };
    }

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const fn = handlers[name];
      if (typeof fn !== 'function') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        };
      }
      try {
        const text = fn(args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(text) }] }
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `调用失败：${error.message}` }],
            isError: true
          }
        };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
  }
}

process.on('uncaughtException', (err) => {
  logStderr('uncaught: ' + err.message);
});
process.stdout.on('error', () => process.exit(0));

main();
