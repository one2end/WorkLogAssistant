'use strict';

/**
 * analytics.js — 活动数据聚合与 AI 报告生成
 *
 * 设计约束：
 * 1) 不依赖 electron，任何 Node 进程（含独立 MCP server）都能 require
 * 2) 只读，不写任何文件
 * 3) 输出面向 token 预算优化，detail 三档：compact / normal / full
 *
 * 核心思路：原始数据只在窗口切换时落一条裸时间戳，没有 duration。
 * 这里用「相邻记录的时间差」反推每条记录的停留时长，再按应用折叠成会话。
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 常量与默认参数
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  // 采样间隔（毫秒）。仅用于给「当日最后一条」这类无后继记录兜底
  sampleGapMs: 60 * 1000,
  // 单段停留时长封顶。超过则视为离座/未采集，避免一晚挂机刷出 10 小时
  maxSegmentMs: 20 * 60 * 1000,
  // 相邻记录间隔超过此值，判定为数据空档（离座、休眠、应用未运行）
  idleGapMs: 10 * 60 * 1000,
  // 时间线中默认隐藏的短会话阈值
  minSessionMs: 60 * 1000,
  // 每个应用最多展示多少个窗口标题
  maxTitlesPerApp: 6
};

/**
 * 分类规则：按优先级从上到下匹配 processName，再匹配 windowTitle。
 * 全部小写比较，用户可在 config.analysis.categoryRules 覆盖。
 */
const DEFAULT_CATEGORY_RULES = [
  {
    // 锁屏 / 登录界面：计入「离座」，但不计入有效工时
    name: '空闲离座',
    excludeFromTotal: true,
    apps: ['lockapp', 'logonui', 'screensaver', 'windowsdefaultlock', 'loginscreen'],
    titles: ['默认锁屏界面', '锁屏界面', '登录界面']
  },
  {
    name: '沟通协作',
    apps: ['wxwork', 'wework', 'weixin', 'wechat', 'wechatappex', 'qq', 'dingtalk', 'feishu', 'lark',
      'slack', 'telegram', 'discord', 'zoom', 'wemeet', 'tencentmeeting', 'mail', 'outlook',
      'thunderbird'],
    titles: ['企业微信', '邮e联', '钉钉', '飞书', '微信']
  },
  {
    name: 'AI 助手',
    apps: ['pake-gemini', 'pake-chatgpt', 'pake-claude', 'pake-deepseek', 'pake-grok',
      'chatgpt', 'chatbox', 'cherry', 'kimi', 'doubao', 'deepseek', 'grok', 'copilot',
      'perplexity', 'workbuddy', 'qclaw'],
    titles: ['gemini', 'chatgpt', 'claude', 'deepseek', '豆包', 'kimi', '通义', '文心', 'grok']
  },
  {
    name: '开发编码',
    apps: ['code', 'codium', 'cursor', 'trae', 'windsurf', 'idea', 'pycharm', 'webstorm', 'goland',
      'clion', 'sublime_text', 'notepad++', 'vim', 'nvim', 'windowsterminal', 'powershell', 'pwsh',
      'cmd', 'mintty', 'git-bash', 'bash', 'docker desktop', 'navicat', 'dbeaver', 'sqlyog',
      'postman', 'apifox', 'hbuilderx', 'devenv', 'ssms', 'mysqlworkbench', 'xshell', 'xftp',
      'putty', 'finalshell'],
    titles: ['visual studio', 'localhost:', '127.0.0.1', 'git ', 'npm ', 'docker']
  },
  {
    name: '文档写作',
    apps: ['winword', 'wps', 'et', 'excel', 'powerpnt', 'wpp', 'keynote', 'pages', 'numbers',
      'typora', 'obsidian', 'notion', 'onenote', 'acrobat', 'acrord32', 'foxitreader',
      'sumatrapdf', 'xmind', 'mindmaster', 'visio'],
    titles: ['.doc', '.docx', '.xlsx', '.pptx', '.pdf', '.md', '腾讯文档', '金山文档']
  },
  {
    name: '任务与效率',
    apps: ['ticktick', 'uptimer', 'utools', 'listary', 'powertoys', 'todoist', 'toggl'],
    titles: ['滴答清单']
  },
  {
    name: '浏览检索',
    apps: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'safari', '360se', '360chrome',
      'qqbrowser', 'sogouexplorer', 'maxthon', 'vieb', 'comet', 'arc'],
    titles: []
  },
  {
    name: '影音娱乐',
    apps: ['potplayermini64', 'potplayer', 'vlc', 'mpc-hc64', 'mpv', 'netflix', 'spotify',
      'cloudmusic', 'qqmusic', 'kugou', 'bilibili', 'iqiyi', 'youku', 'steam',
      'epicgameslauncher', 'wegame'],
    titles: ['bilibili', 'youtube', '网易云音乐', '哔哩哔哩']
  },
  {
    name: '文件系统',
    apps: ['explorer', 'everything', 'totalcmd'],
    titles: []
  },
  {
    name: '系统工具',
    apps: ['searchhost', 'regedit', 'taskmgr', 'snippingtool', 'shellexperiencehost',
      'applicationframehost', 'startmenuexperiencehost'],
    titles: []
  }
];

const FALLBACK_CATEGORY = '其他';

/**
 * 记录器自身不应该被统计进去（开发模式进程名是 electron，打包后是 WorkLog Assistant）。
 * 在这里统一过滤，原始数据仍然保留在磁盘上可追溯。
 */
const DEFAULT_IGNORED_APPS = [
  'electron',
  'worklog assistant',
  'worklog-assistant',
  'worklogassistant'
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD */
function toDateStr(input) {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区 HH:mm */
function toHm(input) {
  const d = input instanceof Date ? input : new Date(input);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 毫秒 → 人类可读时长 */
function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 数据源解析
// ---------------------------------------------------------------------------

/**
 * 在多个候选根目录中找出真正含 activities 的那个。
 * 兼容：旧版 <userData>/Data、以及用户自定义的同步盘路径。
 */
function resolveDataDir(candidates) {
  const list = (candidates || []).filter(Boolean);
  for (const dir of list) {
    if (isDir(path.join(dir, 'activities'))) return dir;
    if (isDir(path.join(dir, 'Data', 'activities'))) return path.join(dir, 'Data');
  }
  return list[0] || null;
}

/** 列出有活动数据的日期（升序）。json 为旧版/导入数据，jsonl 为录制器追加数据。 */
function listDates(dataDir) {
  const dir = path.join(dataDir, 'activities');
  try {
    const set = new Set();
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.(json|jsonl)$/.exec(f);
      if (m) set.add(m[1]);
    }
    return Array.from(set).sort();
  } catch (e) {
    return [];
  }
}

/**
 * 读某天原始记录。
 * JSONL 片段自带 dur，是精确值；旧版 JSON 只有裸时间戳，需要后续推断。
 */
function readDayRaw(dataDir, dateStr) {
  const items = [];

  const legacy = safeReadJson(path.join(dataDir, 'activities', `${dateStr}.json`), []);
  if (Array.isArray(legacy)) items.push(...legacy);

  const jsonlPath = path.join(dataDir, 'activities', `${dateStr}.jsonl`);
  try {
    if (fs.existsSync(jsonlPath)) {
      const raw = fs.readFileSync(jsonlPath, 'utf8');
      let i = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          if (!rec || !rec.t) continue;
          items.push({
            id: `${rec.t}#${i++}`,
            timestamp: rec.t,
            processName: rec.app,
            windowTitle: rec.title || '',
            platform: rec.platform,
            durationMs: typeof rec.dur === 'number' ? rec.dur : undefined,
            kind: rec.kind === 'idle' ? 'idle' : 'active',
            source: rec.source === 'manual' ? 'manual' : 'auto',
            category: rec.cat || undefined
          });
        } catch (e) { /* 单行损坏跳过 */ }
      }
    }
  } catch (e) { /* ignore */ }

  items.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return items;
}

function readRangeRaw(dataDir, from, to) {
  const all = [];
  const dates = listDates(dataDir).filter(d => d >= from && d <= to);
  for (const d of dates) {
    readDayRaw(dataDir, d).forEach(a => {
      // 给每条打上来源日期，便于跨天聚合
      all.push(a);
    });
  }
  return all;
}

function readArhatNotes(dataDir, dateStr) {
  const items = safeReadJson(path.join(dataDir, 'arhat', 'notes', `${dateStr}.json`), []);
  return Array.isArray(items) ? items : [];
}

function readArhatSessions(dataDir, dateStr) {
  const items = safeReadJson(path.join(dataDir, 'arhat', 'sessions', `${dateStr}.json`), []);
  return Array.isArray(items) ? items : [];
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

function buildClassifier(rules) {
  const active = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_CATEGORY_RULES;
  const compiled = active.map(rule => ({
    name: rule.name,
    excludeFromTotal: !!rule.excludeFromTotal,
    apps: (rule.apps || []).map(s => String(s).toLowerCase()).filter(Boolean),
    titles: (rule.titles || []).map(s => String(s).toLowerCase()).filter(Boolean)
  }));

  const excluded = new Set(
    compiled.filter(r => r.excludeFromTotal).map(r => r.name)
  );

  /**
   * 短键（<4 字符，如 et / wps / cmd / qq）只允许精确匹配，
   * 否则会误伤——例如 'et' 会命中 'pake-getnote'、'arc' 会命中 'SearchHost'。
   */
  function matchesApp(app, key) {
    if (!key) return false;
    if (app === key) return true;
    if (key.length < 4) return false;
    return app.includes(key);
  }

  function classify(processName, windowTitle) {
    const app = String(processName || '').toLowerCase().replace(/\.exe$/, '');
    const title = String(windowTitle || '').toLowerCase();

    for (const rule of compiled) {
      if (rule.apps.some(k => matchesApp(app, k))) return rule.name;
    }
    for (const rule of compiled) {
      if (rule.titles.some(k => title.includes(k))) return rule.name;
    }
    return FALLBACK_CATEGORY;
  }

  classify.isExcluded = (category) => excluded.has(category);
  return classify;
}

// ---------------------------------------------------------------------------
// 核心：时长推断 + 会话折叠
// ---------------------------------------------------------------------------

/**
 * 把原始记录标准化为原子事件，并按时间排序。
 * 自动丢弃异常记录（无时间戳 / 无法解析）。
 */
function normalizeRaw(rawItems, classify, ignoreSet) {
  const atoms = [];
  const ignored = ignoreSet || new Set(DEFAULT_IGNORED_APPS);

  for (const item of rawItems) {
    if (!item || !item.timestamp) continue;
    const t = new Date(item.timestamp);
    const ms = t.getTime();
    if (!Number.isFinite(ms)) continue;
    const app = String(item.processName || 'unknown').trim() || 'unknown';

    // 跳过记录器自身
    if (ignored.has(app.toLowerCase())) continue;

    const title = String(item.windowTitle || '').trim();
    const hasExplicitDur = typeof item.durationMs === 'number' && item.durationMs > 0;
    atoms.push({
      ms,
      app,
      title,
      category: item.category || classify(app, title),
      kind: item.kind === 'idle' ? 'idle' : 'active',
      source: item.source === 'manual' ? 'manual' : 'auto',
      // 录制器写入的片段自带精确时长；旧数据这里为 undefined，走时间差推断
      durationMs: hasExplicitDur ? item.durationMs : undefined,
      durationExact: hasExplicitDur
    });
  }
  atoms.sort((a, b) => a.ms - b.ms);
  return atoms;
}

/** 把配置里的忽略清单转成小写 Set */
function buildIgnoreSet(rules) {
  const list = Array.isArray(rules) && rules.length ? rules : DEFAULT_IGNORED_APPS;
  return new Set(list.map(s => String(s).toLowerCase()));
}

/**
 * 推断每条原子的停留时长。
 * - 正常情况下：时长 = 下一条时间戳 - 本条时间戳
 * - 间隔超过 idleGapMs：按 maxSegmentMs 封顶，并标记为不确定
 * - 当日最后一条：用采样间隔兜底
 */
function inferDurations(atoms, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const gaps = [];

  for (let i = 0; i < atoms.length; i++) {
    const cur = atoms[i];

    // 录制器写入的精确片段直接用，不做推断
    if (cur.durationMs > 0) {
      cur.durationExact = true;
      continue;
    }

    const next = atoms[i + 1];

    if (!next) {
      cur.durationMs = Math.min(opts.sampleGapMs, opts.maxSegmentMs);
      cur.durationExact = false;
      cur.gapMs = null;
      continue;
    }

    const gap = next.ms - cur.ms;
    cur.gapMs = gap;

    if (gap <= 0) {
      cur.durationMs = opts.sampleGapMs;
      cur.durationExact = false;
      continue;
    }

    if (gap > opts.idleGapMs) {
      // 数据空档：无法判断是真的停留还是人不在
      cur.durationMs = Math.min(opts.maxSegmentMs, gap);
      cur.durationExact = false;
      gaps.push({ fromMs: cur.ms, toMs: next.ms, gapMs: gap, app: cur.app });
    } else {
      cur.durationMs = gap;
      cur.durationExact = true;
      if (gap > opts.idleGapMs * 0.6) {
        gaps.push({ fromMs: cur.ms, toMs: next.ms, gapMs: gap, app: cur.app });
      }
    }
  }

  return { gaps };
}

/**
 * 按「同一应用 + 相邻」折叠会话。标题变化不打断会话，只累积标题集合。
 * 这样一天 300 条裸记录通常能折叠到 40~80 段，token 成本降一个数量级。
 */
function foldSessions(atoms, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const sessions = [];

  for (const atom of atoms) {
    if (atom.durationMs <= 0) continue;
    const last = sessions[sessions.length - 1];

    const mergeable = last
      && last.app === atom.app
      && (atom.ms - last.endMs) <= Math.max(opts.sampleGapMs * 2, 120000);

    if (mergeable) {
      last.endMs = atom.ms + Math.max(atom.durationMs, 0);
      last.durationMs = last.endMs - last.startMs;
      last.recordCount += 1;
      if (atom.source === 'manual') last.manualCount += 1;
      if (atom.title && !last.titles.includes(atom.title)) {
        last.titles.push(atom.title);
      }
      if (atom.durationExact === false) last.hasUncertainty = true;
    } else {
      sessions.push({
        app: atom.app,
        category: atom.category,
        startMs: atom.ms,
        endMs: atom.ms + atom.durationMs,
        durationMs: atom.durationMs,
        recordCount: 1,
        manualCount: atom.source === 'manual' ? 1 : 0,
        titles: atom.title ? [atom.title] : [],
        hasUncertainty: atom.durationExact === false
      });
    }
  }

  return sessions.filter(s => s.durationMs > 0);
}

// ---------------------------------------------------------------------------
// 统计聚合
// ---------------------------------------------------------------------------

function aggregate(sessions) {
  const appMap = new Map();
  const catMap = new Map();
  let totalMs = 0;

  for (const s of sessions) {
    totalMs += s.durationMs;

    let app = appMap.get(s.app);
    if (!app) {
      app = {
        processName: s.app,
        category: s.category,
        durationMs: 0,
        sessionCount: 0,
        firstMs: s.startMs,
        lastMs: s.endMs,
        titles: []
      };
      appMap.set(s.app, app);
    }
    app.durationMs += s.durationMs;
    app.sessionCount += 1;
    app.firstMs = Math.min(app.firstMs, s.startMs);
    app.lastMs = Math.max(app.lastMs, s.endMs);
    app.category = s.category;
    for (const t of s.titles) {
      if (t && !app.titles.includes(t)) app.titles.push(t);
    }

    let cat = catMap.get(s.category);
    if (!cat) {
      cat = { name: s.category, durationMs: 0, apps: new Set(), sessionCount: 0 };
      catMap.set(s.category, cat);
    }
    cat.durationMs += s.durationMs;
    cat.apps.add(s.app);
    cat.sessionCount += 1;
  }

  const apps = Array.from(appMap.values())
    .map(a => ({
      ...a,
      percent: totalMs > 0 ? a.durationMs / totalMs : 0,
      titles: a.titles.slice(0, DEFAULT_OPTIONS.maxTitlesPerApp)
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  const categories = Array.from(catMap.values())
    .map(c => ({
      name: c.name,
      durationMs: c.durationMs,
      percent: totalMs > 0 ? c.durationMs / totalMs : 0,
      sessionCount: c.sessionCount,
      apps: Array.from(c.apps)
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return { totalMs, apps, categories };
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}

// ---------------------------------------------------------------------------
// 对外：单日报告
// ---------------------------------------------------------------------------

function buildDayReport(dataDir, dateStr, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const classify = buildClassifier(opts.categoryRules);

  const raw = readDayRaw(dataDir, dateStr);
  const atoms = normalizeRaw(raw, classify, buildIgnoreSet(opts.ignoredApps));

  // 录制器会把空闲段单独写成 kind=idle 的片段，直接累计
  const idleAtoms = atoms.filter(a => a.kind === 'idle');
  const workAtoms = atoms.filter(a => a.kind !== 'idle');

  let idleMs = 0;
  let idleSessionCount = 0;
  for (const a of idleAtoms) {
    const d = Number.isFinite(a.durationMs) ? a.durationMs : 0;
    if (d <= 0) continue;
    idleMs += d;
    idleSessionCount += 1;
  }

  const { gaps } = inferDurations(workAtoms, opts);
  const allSessions = foldSessions(workAtoms, opts);

  // 旧数据里锁屏会被记成普通活动，这里也归入「离座」
  const sessions = [];
  for (const s of allSessions) {
    if (classify.isExcluded(s.category)) {
      idleMs += s.durationMs;
      idleSessionCount += 1;
    } else {
      sessions.push(s);
    }
  }

  const { totalMs, apps, categories } = aggregate(sessions);

  const firstMs = atoms.length ? atoms[0].ms : null;
  const lastEndMs = atoms.length
    ? Math.max(...atoms.map(a => a.ms + (Number.isFinite(a.durationMs) ? a.durationMs : 0)))
    : null;
  const spanMs = (firstMs && lastEndMs) ? Math.max(0, lastEndMs - firstMs) : 0;

  const notes = readArhatNotes(dataDir, dateStr);
  const arhatSessions = readArhatSessions(dataDir, dateStr);

  const dataNotes = [];
  if (raw.length === 0) {
    dataNotes.push('当日无任何记录');
  }
  const bigGaps = gaps.filter(g => g.gapMs > opts.idleGapMs);
  if (bigGaps.length > 0) {
    dataNotes.push(`存在 ${bigGaps.length} 处超过 ${Math.round(opts.idleGapMs / 60000)} 分钟的空档（离座、休眠或应用未运行），此时长不可信`);
  }
  if (spanMs > 0 && totalMs / spanMs < 0.35) {
    dataNotes.push(`有效记录仅占区间跨度的 ${pct(totalMs / spanMs)}，实际在岗时间可能更长`);
  }

  return {
    kind: 'day',
    date: dateStr,
    generatedAt: new Date().toISOString(),
    stats: {
      recordCount: atoms.length,
      sessionCount: sessions.length,
      uniqueApps: apps.length,
      trackedMs: totalMs,
      idleMs,
      idleSessionCount,
      spanMs,
      coverage: spanMs > 0 ? totalMs / spanMs : 0,
      firstAt: firstMs ? new Date(firstMs).toISOString() : null,
      lastAt: lastEndMs ? new Date(lastEndMs).toISOString() : null,
      bigGapCount: bigGaps.length
    },
    categories,
    apps,
    sessions: sessions.map(s => ({
      start: new Date(s.startMs).toISOString(),
      end: new Date(s.endMs).toISOString(),
      app: s.app,
      category: s.category,
      durationMs: s.durationMs,
      titles: s.titles.slice(0, 4),
      uncertain: s.hasUncertainty,
      manual: s.manualCount > 0 && s.manualCount === s.recordCount
    })),
    focus: {
      arhatSessions: arhatSessions.map(s => ({
        start: s.startTime,
        end: s.endTime,
        durationMs: s.durationMs,
        focusText: s.focusText,
        notesCount: s.notesCount
      })),
      notes: notes.map(n => ({
        time: n.timestamp,
        text: n.text,
        category: n.category
      }))
    },
    dataNotes
  };
}

// ---------------------------------------------------------------------------
// 对外：区间报告
// ---------------------------------------------------------------------------

function buildRangeReport(dataDir, from, to, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const dates = listDates(dataDir).filter(d => d >= from && d <= to);
  const perDay = dates.map(d => {
    const r = buildDayReport(dataDir, d, opts);
    return {
      date: d,
      trackedMs: r.stats.trackedMs,
      spanMs: r.stats.spanMs,
      recordCount: r.stats.recordCount,
      uniqueApps: r.stats.uniqueApps,
      topApps: r.apps.slice(0, 5).map(a => ({ app: a.processName, durationMs: a.durationMs })),
      topCategories: r.categories.map(c => ({ name: c.name, durationMs: c.durationMs }))
    };
  });

  // 汇总各应用
  const appTotals = new Map();
  const catTotals = new Map();
  let grandTotal = 0;

  for (const day of perDay) {
    const report = buildDayReport(dataDir, day.date, opts);
    grandTotal += report.stats.trackedMs;
    for (const a of report.apps) {
      const cur = appTotals.get(a.processName) || { processName: a.processName, category: a.category, durationMs: 0, days: new Set() };
      cur.durationMs += a.durationMs;
      cur.days.add(day.date);
      appTotals.set(a.processName, cur);
    }
    for (const c of report.categories) {
      const cur = catTotals.get(c.name) || { name: c.name, durationMs: 0 };
      cur.durationMs += c.durationMs;
      catTotals.set(c.name, cur);
    }
  }

  const activeDays = perDay.filter(d => d.trackedMs > 0).length;

  return {
    kind: 'range',
    from,
    to,
    generatedAt: new Date().toISOString(),
    stats: {
      dayCount: perDay.length,
      activeDayCount: activeDays,
      trackedMs: grandTotal,
      avgPerActiveDayMs: activeDays > 0 ? grandTotal / activeDays : 0,
      totalRecordCount: perDay.reduce((s, d) => s + d.recordCount, 0)
    },
    days: perDay,
    apps: Array.from(appTotals.values())
      .map(a => ({
        processName: a.processName,
        category: a.category,
        durationMs: a.durationMs,
        percent: grandTotal > 0 ? a.durationMs / grandTotal : 0,
        dayCount: a.days.size
      }))
      .sort((a, b) => b.durationMs - a.durationMs),
    categories: Array.from(catTotals.values())
      .map(c => ({
        name: c.name,
        durationMs: c.durationMs,
        percent: grandTotal > 0 ? c.durationMs / grandTotal : 0
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
  };
}

// ---------------------------------------------------------------------------
// 轻量：逐日「有效时长」(供前端热力图使用)
//
// 口径必须与 buildDayReport().stats.trackedMs 完全一致：该值经过
// normalizeRaw（丢弃忽略应用/非法时间戳）、idle 段分离、inferDurations
// （gap 封顶与末条兜底）、foldSessions、锁屏排除与 aggregate。
// 不要为了「更快」改成累加 jsonl 的 dur 字段——那会把 idle / 忽略应用 /
// 锁屏都算进去，还会漏掉旧版 .json，导致热力图与首屏核心数字对不上。
// 相比 buildRangeReport 对每天算两次，这里每天最多算一次，且跳过无数据/未来日。
// ---------------------------------------------------------------------------
function buildDailyTrackedMs(dataDir, from, to, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const available = new Set(listDates(dataDir));
  const todayStr = toDateStr(new Date());
  const out = [];

  // 统一规范化为本地 YYYY-MM-DD，调用方传字符串或 Date 都能工作
  const cursor = new Date(`${toDateStr(from)}T00:00:00`);
  const end = new Date(`${toDateStr(to)}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return out;

  while (cursor <= end) {
    const dateStr = toDateStr(cursor);
    if (dateStr > todayStr || !available.has(dateStr)) {
      out.push({ date: dateStr, trackedMs: 0 });
    } else {
      try {
        const report = buildDayReport(dataDir, dateStr, opts);
        out.push({ date: dateStr, trackedMs: report.stats.trackedMs });
      } catch (e) {
        out.push({ date: dateStr, trackedMs: 0 });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 对外：搜索
// ---------------------------------------------------------------------------

function searchActivities(dataDir, keyword, from, to, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const classify = buildClassifier(opts.categoryRules);
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return { keyword, hits: [], totalDurationMs: 0 };

  const raw = readRangeRaw(dataDir, from, to);
  const atoms = normalizeRaw(raw, classify, buildIgnoreSet(opts.ignoredApps));
  inferDurations(atoms, opts);

  const hits = atoms.filter(a =>
    a.app.toLowerCase().includes(kw) || a.title.toLowerCase().includes(kw)
  );

  return {
    keyword,
    from,
    to,
    hitCount: hits.length,
    totalDurationMs: hits.reduce((s, h) => s + h.durationMs, 0),
    hits: hits.slice(0, 200).map(h => ({
      time: new Date(h.ms).toISOString(),
      date: toDateStr(h.ms),
      app: h.app,
      title: h.title,
      category: h.category,
      durationMs: h.durationMs
    }))
  };
}

// ---------------------------------------------------------------------------
// 对外：Markdown 渲染（给 AI 读的主格式）
// ---------------------------------------------------------------------------

function renderDayMarkdown(report, detail) {
  const level = detail || 'normal';
  const s = report.stats;
  const lines = [];

  lines.push(`# ${report.date} 电脑使用日报`);
  lines.push('');

  if (s.recordCount === 0) {
    lines.push('当日无任何活动记录。');
    return lines.join('\n');
  }

  lines.push(`- 统计区间：${toHm(s.firstAt)} – ${toHm(s.lastAt)}（跨度 ${formatDuration(s.spanMs)}）`);
  lines.push(`- 有效记录：${formatDuration(s.trackedMs)}（占跨度 ${pct(s.coverage)}）`);
  if (s.idleMs > 0) {
    lines.push(`- 锁屏离座：${formatDuration(s.idleMs)}（已从有效工时中剔除）`);
  }
  lines.push(`- 采样记录 ${s.recordCount} 条 · 折叠为 ${s.sessionCount} 个会话 · 涉及 ${s.uniqueApps} 个应用`);
  if (report.dataNotes.length) {
    lines.push(`- 数据提示：${report.dataNotes.join('；')}`);
  }
  lines.push('');

  lines.push('## 分类时长');
  lines.push('');
  lines.push('| 分类 | 时长 | 占比 | 主要应用 |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of report.categories) {
    const top = c.apps.slice(0, 3).join('、');
    lines.push(`| ${c.name} | ${formatDuration(c.durationMs)} | ${pct(c.percent)} | ${top} |`);
  }
  lines.push('');

  lines.push('## 应用时长');
  lines.push('');
  lines.push('| 应用 | 分类 | 时长 | 占比 | 会话数 | 时间范围 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const appLimit = level === 'compact' ? 8 : level === 'full' ? 100 : 20;
  for (const a of report.apps.slice(0, appLimit)) {
    lines.push(`| ${a.processName} | ${a.category} | ${formatDuration(a.durationMs)} | ${pct(a.percent)} | ${a.sessionCount} | ${toHm(a.firstMs)}–${toHm(a.lastMs)} |`);
  }
  lines.push('');

  if (level !== 'compact') {
    lines.push('## 应用内主要窗口');
    lines.push('');
    const titleLimit = level === 'full' ? 100 : 12;
    for (const a of report.apps.slice(0, titleLimit)) {
      if (!a.titles.length) continue;
      lines.push(`- **${a.processName}**：${a.titles.join(' / ')}`);
    }
    lines.push('');

    lines.push('## 时间线');
    lines.push('');
    lines.push('按应用连续停留折叠，仅列出较长片段。');
    lines.push('');
    const minMs = level === 'full' ? 0 : 3 * 60 * 1000;
    const sessionLimit = level === 'full' ? 500 : 60;
    const visible = report.sessions.filter(x => x.durationMs >= minMs).slice(0, sessionLimit);
    for (const x of visible) {
      const mark = x.uncertain ? ' *(时长不确定)*' : '';
      const titleText = x.titles.length ? ` · ${x.titles.slice(0, 2).join(' / ')}` : '';
      lines.push(`- ${toHm(x.start)}–${toHm(x.end)}　${formatDuration(x.durationMs)}　${x.app}［${x.category}］${titleText}${mark}`);
    }
    if (report.sessions.length > visible.length) {
      lines.push(`- …另有 ${report.sessions.length - visible.length} 段更短的会话未列出`);
    }
    lines.push('');
  }

  if (report.focus.arhatSessions.length || report.focus.notes.length) {
    lines.push('## 专注与随手记');
    lines.push('');
    for (const fs2 of report.focus.arhatSessions) {
      lines.push(`- 罗汉专注 ${toHm(fs2.start)}–${toHm(fs2.end)}（${formatDuration(fs2.durationMs)}）：${fs2.focusText || '未命名'}`);
    }
    for (const n of report.focus.notes) {
      lines.push(`- ${toHm(n.time)} 〔${n.category}〕${n.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderRangeMarkdown(report, detail) {
  const level = detail || 'normal';
  const s = report.stats;
  const lines = [];

  lines.push(`# ${report.from} ~ ${report.to} 使用概览`);
  lines.push('');
  lines.push(`- 覆盖 ${s.dayCount} 天（有记录 ${s.activeDayCount} 天）`);
  lines.push(`- 累计有效记录 ${formatDuration(s.trackedMs)}，活跃日均 ${formatDuration(s.avgPerActiveDayMs)}`);
  lines.push(`- 采样记录 ${s.totalRecordCount} 条`);
  lines.push('');

  lines.push('## 每日有效时长');
  lines.push('');
  lines.push('| 日期 | 有效时长 | 跨度 | 应用数 | 占比最高的应用 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of report.days) {
    const top = d.topApps[0] ? `${d.topApps[0].app} ${formatDuration(d.topApps[0].durationMs)}` : '-';
    lines.push(`| ${d.date} | ${formatDuration(d.trackedMs)} | ${formatDuration(d.spanMs)} | ${d.uniqueApps} | ${top} |`);
  }
  lines.push('');

  lines.push('## 分类占比');
  lines.push('');
  for (const c of report.categories) {
    lines.push(`- ${c.name}：${formatDuration(c.durationMs)}（${pct(c.percent)}）`);
  }
  lines.push('');

  if (level !== 'compact') {
    lines.push('## 应用排行');
    lines.push('');
    lines.push('| 应用 | 分类 | 累计时长 | 占比 | 出现天数 |');
    lines.push('| --- | --- | --- | --- | --- |');
    const limit = level === 'full' ? 200 : 25;
    for (const a of report.apps.slice(0, limit)) {
      lines.push(`| ${a.processName} | ${a.category} | ${formatDuration(a.durationMs)} | ${pct(a.percent)} | ${a.dayCount} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 对外：给 AI 模型用的紧凑上下文
// ---------------------------------------------------------------------------

/**
 * 把一段原始记录折成「时间段 + 时长 + 应用 + 窗口标题」的紧凑文本。
 * 这是修掉旧版 prompt 矛盾的关键：旧版把标题去重成应用清单（时间信息全丢）
 * 却要求模型输出"时间分配"。这里每一行都自带真实时长。
 */
function renderPromptContext(rawItems, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const classify = buildClassifier(opts.categoryRules);
  const atoms = normalizeRaw(rawItems, classify, buildIgnoreSet(opts.ignoredApps));

  if (!atoms.length) return { text: '', totalMs: 0, sessionCount: 0, idleMs: 0 };

  const idleAtoms = atoms.filter(a => a.kind === 'idle');
  const workAtoms = atoms.filter(a => a.kind !== 'idle');
  inferDurations(workAtoms, opts);
  const allSessions = foldSessions(workAtoms, opts);

  // 锁屏/登录界面归为离座，不参与工作内容
  const sessions = [];
  let idleMs = idleAtoms.reduce((s, a) => s + (Number.isFinite(a.durationMs) ? a.durationMs : 0), 0);
  for (const s of allSessions) {
    if (classify.isExcluded(s.category)) {
      idleMs += s.durationMs;
    } else {
      sessions.push(s);
    }
  }

  const totalMs = sessions.reduce((s, x) => s + x.durationMs, 0);

  const lines = [];
  const MAX_LINES = opts.maxPromptLines || 70;

  if (sessions.length <= MAX_LINES) {
    for (const s of sessions) {
      if (s.durationMs < 30000) continue; // 30 秒以下不进 prompt
      const titles = s.titles.slice(0, 3).join(' / ');
      lines.push(`${toHm(s.startMs)}–${toHm(s.endMs)}  ${formatDuration(s.durationMs)}  ${s.app}［${s.category}］${titles ? '  ' + titles : ''}`);
    }
  } else {
    // 片段过多时按小时聚合，避免 prompt 过长
    const buckets = new Map();
    for (const s of sessions) {
      const hour = new Date(s.startMs).getHours();
      if (!buckets.has(hour)) buckets.set(hour, { totalMs: 0, apps: new Map(), titles: [] });
      const b = buckets.get(hour);
      b.totalMs += s.durationMs;
      b.apps.set(s.app, (b.apps.get(s.app) || 0) + s.durationMs);
      if (b.titles.length < 2 && s.titles[0]) b.titles.push(s.titles[0]);
    }
    for (const [hour, b] of Array.from(buckets.entries()).sort((a, c) => a[0] - c[0])) {
      const top = Array.from(b.apps.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([app, ms]) => `${app} ${formatDuration(ms)}`)
        .join(' / ');
      lines.push(`${pad2(hour)}:00–${pad2(hour)}:59  有效 ${formatDuration(b.totalMs)}  ${top}`);
    }
  }

  const header = [
    `统计区间 ${toHm(atoms[0].ms)}–${toHm(atoms[atoms.length - 1].ms)}`,
    `有效 ${formatDuration(totalMs)}`,
    idleMs > 0 ? `离座 ${formatDuration(idleMs)}` : null,
    `${sessions.length} 段`
  ].filter(Boolean).join(' · ');

  return {
    text: `${header}\n\n${lines.join('\n')}`,
    totalMs,
    sessionCount: sessions.length,
    idleMs
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  DEFAULT_CATEGORY_RULES,
  DEFAULT_IGNORED_APPS,
  resolveDataDir,
  listDates,
  toDateStr,
  toHm,
  formatDuration,
  buildClassifier,
  buildIgnoreSet,
  buildDayReport,
  buildRangeReport,
  buildDailyTrackedMs,
  searchActivities,
  renderDayMarkdown,
  renderRangeMarkdown,
  renderPromptContext
};
