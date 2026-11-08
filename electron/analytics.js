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
const { buildDayBalance } = require('./timeBalance');
const path = require('path');

// ---------------------------------------------------------------------------
// 常量与默认参数
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  // 采样间隔（毫秒）。仅用于给「当日最后一条」这类无后继记录兜底
  sampleGapMs: 60 * 1000,
  // 单段停留时长封顶。超过则视为空档/未采集，避免一晚挂机刷出 10 小时
  maxSegmentMs: 20 * 60 * 1000,
  // 相邻记录间隔超过此值，判定为数据空档（休眠、应用未运行等）
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
    // 锁屏 / 登录界面：算「空档」，不计入有效工时
    name: '空档',
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

/** 生活事务：时间线可见，但不计入有效工时（见 classify.isLife） */
const LIFE_CATEGORY = '生活事务';
/**
 * 睡眠：一天里占比最大的一块，必须能看见，但它既不是工作也不是「空档」。
 * 单独成类，才能让「空档」回到它本来的意思（没被任何一层记录覆盖的时间）。
 */
const SLEEP_CATEGORY = '睡眠';
/**
 * 展示分组：13 个细分分类太碎，日历上既难认也难记。
 * 参照「时间块」这类应用的做法收敛成 7 类——选起来只要一眼，
 * 而细分分类仍然保留在会话里，用于统计与后续的自动归类。
 *
 * 注意：这只是投影层。原始分类不动，随时可以调整映射重算。
 */
const SIMPLE_GROUPS = [
  ['工作', ['沟通协作', '文档写作', '开发编码', '任务与效率', 'AI 助手', '文件系统', '系统工具', '浏览检索']],
  ['学习', ['学习', '阅读']],
  ['生活', ['生活事务']],
  ['娱乐', ['影音娱乐']],
  ['睡眠', ['睡眠']],
  ['专注', ['专注']],
  ['其他', ['其他', '空档']]
];

const CAT_TO_GROUP = (() => {
  const map = {};
  for (const [group, names] of SIMPLE_GROUPS) {
    map[group] = group;
    for (const n of names) map[n] = group;
  }
  return map;
})();

const SIMPLE_GROUP_NAMES = SIMPLE_GROUPS.map(g => g[0]);

/** 细分分类 → 展示分组（幂等：已经是分组名就原样返回） */
function simpleCategory(cat) {
  if (!cat) return '其他';
  return CAT_TO_GROUP[cat] || '其他';
}

/** 不算工作产出的分类：生活事务、影音娱乐、睡眠。时间照实显示，但不进有效工时。 */
const LIFE_CATEGORIES = new Set([LIFE_CATEGORY, '影音娱乐', SLEEP_CATEGORY]);

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
            // 三层来源：manual=本人补记，imported=从别的软件导入的人工标注，
            // auto=本机自动录制。三者的可信度不同，不能简单相加。
            source: rec.source === 'manual' ? 'manual'
              : (rec.source === 'dida' || rec.source === 'uptimer') ? 'imported'
              : 'auto',
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

/** 滴答专注只读镜像：由 electron/didaSync.js 落盘，删掉整个目录即可重拉 */
function readDidaFocus(dataDir, dateStr) {
  const items = safeReadJson(path.join(dataDir, 'dida', 'focus', `${dateStr}.json`), []);
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
  /**
   * 「生活事务」类：吃饭、家务、通勤、陪家人、睡觉之外的日常。
   * 它们要出现在时间线上（一天是完整的），但不能算进有效工作工时，
   * 否则手工补记的全天记录会把"有效工时"顶到 18 小时。
   */
  classify.isLife = (category) => LIFE_CATEGORIES.has(category);
  classify.isSleep = (category) => category === SLEEP_CATEGORY;
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
      // 三层来源要原样保留：优先级消解靠它区分
      // manual（本人补记）> imported（导入的标注）> focus（专注）> auto（录制）
      source: item.source === 'manual' ? 'manual'
        : (item.source === 'dida' || item.source === 'uptimer' || item.source === 'imported') ? 'imported'
        : 'auto',
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
/**
 * 记录层 / 展示层冲突消解。
 *
 * 同一段时间可能同时存在三种来源：自动录制（真实但无语义）、导入的人工标注
 * （有语义但可能粗）、本人补记（最准）。它们不是可以相加的三份数据，
 * 而是对同一段时间的三种描述——所以按时长优先级覆盖，不是求和。
 *
 * 优先级：manual(4) > imported(3) > focus(2) > auto(1)
 * 低优先级被覆盖的部分会被裁掉，高优先级的时间块保持完整。
 *
 * 专注排在「自动录制」之上但低于任何人工标注：它是本人主动声明的意图，
 * 比「窗口看着像在工作」更可信；但手工改过的那一段仍然最权威。
 */
const SOURCE_PRIORITY = { manual: 4, imported: 3, focus: 2, auto: 1 };

function cutInterval(intervals, cutStart, cutEnd) {
  const out = [];
  for (const [s, e] of intervals) {
    if (cutEnd <= s || cutStart >= e) { out.push([s, e]); continue; }
    if (cutStart > s) out.push([s, cutStart]);
    if (cutEnd < e) out.push([cutEnd, e]);
  }
  return out;
}

function resolveByPriority(atoms) {
  const ranked = atoms
    .filter(a => a.kind !== 'idle')
    .slice()
    .sort((a, b) => (SOURCE_PRIORITY[b.source] || 0) - (SOURCE_PRIORITY[a.source] || 0) || a.ms - b.ms);

  const taken = [];
  const out = [];
  for (const a of ranked) {
    const dur = Number.isFinite(a.durationMs) ? a.durationMs : 0;
    if (dur <= 0) { out.push(a); continue; }
    let pieces = [[a.ms, a.ms + dur]];
    for (const [ts, te] of taken) pieces = cutInterval(pieces, ts, te);
    for (const [s, e] of pieces) {
      out.push({ ...a, ms: s, durationMs: e - s });
      taken.push([s, e]);
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * 把一天的记录折成 15 分钟一格，每格只留一个「主要事件」。
 *
 * 这是展示层的口径：15 分钟里可能切了十几次窗口，但只要 9 分钟在 Word 上，
 * 这一格就是「写材料」，而不是十条碎片。人工标注与导入的标注因为优先级更高，
 * 会自然成为该格的主要事件。
 */
function buildSlots(atoms, dateStr, options = {}) {
  const slotMin = options.slotMin || 15;
  const slotMs = slotMin * 60000;
  const dayStart = new Date(`${dateStr}T00:00:00`).getTime();
  if (Number.isNaN(dayStart)) return [];

  const slots = [];
  for (let i = 0; i < Math.ceil(1440 / slotMin); i += 1) {
    slots.push({
      index: i, startMin: i * slotMin, ms: 0,
      catMs: {}, appMs: {}, layerMs: {}, titleMs: {}, noteMs: {}, focusMs: {}
    });
  }

  for (const a of atoms) {
    if (a.kind === 'idle') continue;
    const dur = Number.isFinite(a.durationMs) ? a.durationMs : 0;
    if (dur <= 0) continue;
    const from = Math.max(a.ms, dayStart);
    const to = Math.min(a.ms + dur, dayStart + 86400000);
    if (to <= from) continue;
    let cur = from;
    while (cur < to) {
      const idx = Math.min(slots.length - 1, Math.floor((cur - dayStart) / slotMs));
      const segEnd = Math.min(to, dayStart + (idx + 1) * slotMs);
      const mins = (segEnd - cur) / 60000;
      const slot = slots[idx];
      const cat = a.source === 'manual' && a.category && !CAT_TO_GROUP[a.category]
        ? a.category : simpleCategory(a.category || '其他');
      slot.ms += segEnd - cur;
      slot.catMs[cat] = (slot.catMs[cat] || 0) + mins;
      slot.appMs[a.app] = (slot.appMs[a.app] || 0) + mins;
      slot.layerMs[a.source] = (slot.layerMs[a.source] || 0) + mins;
      const t = (a.title || '').trim();
      if (t) slot.titleMs[t] = (slot.titleMs[t] || 0) + mins;
      const note = (a.note || '').trim();
      if (note) slot.noteMs[note] = (slot.noteMs[note] || 0) + mins;
      if (a.focusId) slot.focusMs[a.focusId] = (slot.focusMs[a.focusId] || 0) + mins;
      cur = segEnd;
    }
  }

  return slots.map((slot) => {
    const top = Object.entries(slot.catMs).sort((x, y) => y[1] - x[1])[0];
    const app = Object.entries(slot.appMs).sort((x, y) => y[1] - x[1])[0];
    const layer = Object.entries(slot.layerMs).sort((x, y) => y[1] - x[1])[0];
    const title = Object.entries(slot.titleMs).sort((x, y) => y[1] - x[1])[0];
    const note = Object.entries(slot.noteMs).sort((x, y) => y[1] - x[1])[0];
    const focus = Object.entries(slot.focusMs).sort((x, y) => y[1] - x[1])[0];
    return {
      index: slot.index,
      startMin: slot.startMin,
      endMin: Math.min(1440, slot.startMin + slotMin),
      filledMin: Math.round(slot.ms / 60000),
      category: top ? top[0] : null,
      app: app ? app[0] : null,
      layer: layer ? layer[0] : null,
      appPurity: app && slot.ms ? Number((app[1] / (slot.ms / 60000)).toFixed(2)) : 0,
      layerPurity: layer && slot.ms ? Number((layer[1] / (slot.ms / 60000)).toFixed(2)) : 0,
      // 这一格最有代表性的备注（来自人工标注/导入的标题），给日历和时间轴显示
      note: note ? note[0] : (title ? title[0] : ''),
      // 专注会话 id：界面上要能单独删掉一条专注
      focusId: focus ? focus[0] : null,
      // 主要事件占该格的比例：低于 0.6 说明这段本身是混合的
      purity: top && slot.ms ? Number((top[1] / (slot.ms / 60000)).toFixed(2)) : 0
    };
  });
}

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
        manualCount: 0,
        firstMs: s.startMs,
        lastMs: s.endMs,
        titles: []
      };
      appMap.set(s.app, app);
    }
    app.durationMs += s.durationMs;
    app.sessionCount += 1;
    app.manualCount += (s.manualCount || 0);
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
      // 手工补记把「事项名」写进了 app 字段，它不是应用；前端据此把它
      // 从「应用排行」里排除，避免业务词被误当成凭空冒出来的软件。
      manual: a.manualCount > 0 && a.manualCount === a.sessionCount,
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

  // 展示分组版：把 13 类合成 7 组，只用于「时间构成」这类展示，
  // 细分分类仍留在 categories 里做统计与设置页规则。
  const groupMap = new Map();
  for (const c of categories) {
    const g = !CAT_TO_GROUP[c.name] ? c.name : simpleCategory(c.name);
    if (!groupMap.has(g)) groupMap.set(g, { name: g, durationMs: 0, sessionCount: 0, apps: new Set() });
    const item = groupMap.get(g);
    item.durationMs += c.durationMs;
    item.sessionCount += c.sessionCount;
    for (const a of c.apps) item.apps.add(a);
  }
  const categoriesGrouped = Array.from(groupMap.values())
    .map(c => ({
      name: c.name,
      durationMs: c.durationMs,
      percent: totalMs > 0 ? c.durationMs / totalMs : 0,
      sessionCount: c.sessionCount,
      apps: Array.from(c.apps)
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return { totalMs, apps, categories, categoriesGrouped };
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

  // 专注会话也是「一段时间里在做什么」的一种声明，必须参与同一套优先级消解，
  // 否则它和自动录制会各画一份，同一段时间被重复计算两次。
  // 本地番茄钟与滴答清单拉来的专注属于同一层级（第二层级），合并成一份声明。
  const arhatSessions = readArhatSessions(dataDir, dateStr);
  const didaSessions = readDidaFocus(dataDir, dateStr);
  const focusClaims = [
    ...arhatSessions.map(f => ({
      from: new Date(f.startTime).getTime(),
      dur: Number(f.durationMs) || 0,
      text: f.focusText || '专注',
      focusId: f.id
    })),
    ...didaSessions.map(f => ({
      from: Number(f.startMs),
      dur: Math.max(0, Number(f.durationMs) - Number(f.pauseMs || 0)),
      text: f.title || '专注',
      note: f.note || '',
      focusId: `dida:${f.id}`
    }))
  ];
  const focusAtoms = [];
  for (const f of focusClaims) {
    if (!Number.isFinite(f.from) || f.dur <= 0) continue;
    // 专注也服从「15 分钟一块」：起点向下对齐，时长至少一个块
    const cv = new Date(f.from);
    cv.setSeconds(0, 0);
    cv.setMinutes(Math.floor(cv.getMinutes() / 15) * 15);
    const from = cv.getTime();
    const dur = Math.max(15, Math.round(f.dur / 60000 / 15) * 15) * 60000;
    focusAtoms.push({
      ms: from,
      durationMs: dur,
      kind: 'active',
      app: f.text,
      title: f.text,
      note: f.note || '',
      category: '专注',
      source: 'focus',
      focusId: f.focusId
    });
  }

  // 消解之后 atoms 才代表「这一段时间到底算谁的」，后面的会话与统计都基于它
  const resolvedAtoms = resolveByPriority([...workAtoms, ...focusAtoms]);
  const allSessions = foldSessions(resolvedAtoms, opts);
  // 应用排行只反映录制器看到的软件；人工补记、导入与专注是解释层。
  const recordedSessions = foldSessions(resolveByPriority(workAtoms.filter(a => a.source === 'auto')), opts)
    .filter(s => !classify.isExcluded(s.category));
  const recordedApps = aggregate(recordedSessions).apps;
  const windowMap = new Map();
  for (const atom of resolveByPriority(workAtoms.filter(a => a.source === 'auto'))) {
    if (classify.isExcluded(atom.category) || atom.durationMs <= 0) continue;
    const title = (atom.title || '').trim() || '未命名窗口';
    const key = `${atom.app}\u0000${title}`;
    const row = windowMap.get(key) || { title, app: atom.app, category: atom.category, durationMs: 0 };
    row.durationMs += atom.durationMs;
    windowMap.set(key, row);
  }
  const recordedWindows = [...windowMap.values()].sort((a, b) => b.durationMs - a.durationMs);

  // 旧数据里锁屏会被记成普通活动，这里也归入「空档」
  const sessions = [];
  for (const s of allSessions) {
    if (classify.isExcluded(s.category)) {
      idleMs += s.durationMs;
      idleSessionCount += 1;
    } else {
      sessions.push(s);
    }
  }

  const agg = aggregate(sessions);
  const { apps, categories, categoriesGrouped } = agg;
  // 生活事务保留在 sessions（时间线要完整），但不计入有效工时
  // 睡眠单独统计，不能再算进「生活事务」，否则两栏相加会超过 24 小时
  const sleepMs = sessions
    .filter(s => classify.isSleep(s.category))
    .reduce((sum, s) => sum + s.durationMs, 0);
  const lifeMs = sessions
    .filter(s => classify.isLife(s.category) && !classify.isSleep(s.category))
    .reduce((sum, s) => sum + s.durationMs, 0);
  const totalMs = Math.max(0, agg.totalMs - lifeMs - sleepMs);

  const firstMs = atoms.length ? atoms[0].ms : null;
  const lastEndMs = atoms.length
    ? Math.max(...atoms.map(a => a.ms + (Number.isFinite(a.durationMs) ? a.durationMs : 0)))
    : null;
  const spanMs = (firstMs && lastEndMs) ? Math.max(0, lastEndMs - firstMs) : 0;

  const notes = readArhatNotes(dataDir, dateStr);

  const dataNotes = [];
  if (raw.length === 0) {
    dataNotes.push('当日无任何记录');
  }
  const bigGaps = gaps.filter(g => g.gapMs > opts.idleGapMs);
  if (bigGaps.length > 0) {
    dataNotes.push(`存在 ${bigGaps.length} 处超过 ${Math.round(opts.idleGapMs / 60000)} 分钟的空档（空档、休眠或应用未运行），此时长不可信`);
  }
  if (spanMs > 0 && agg.totalMs / spanMs < 0.35) {
    dataNotes.push(`已记录时长仅占区间跨度的 ${pct(agg.totalMs / spanMs)}，可检查未记录时段`);
  }

  const slots = buildSlots(resolvedAtoms, dateStr, opts);
  return {
    kind: 'day',
    date: dateStr,
    generatedAt: new Date().toISOString(),
    stats: {
      recordCount: atoms.length,
      sessionCount: sessions.length,
      uniqueApps: apps.length,
      trackedMs: totalMs,
      recordedMs: agg.totalMs,
      lifeMs,
      sleepMs,
      idleMs,
      idleSessionCount,
      spanMs,
      coverage: spanMs > 0 ? totalMs / spanMs : 0,
      firstAt: firstMs ? new Date(firstMs).toISOString() : null,
      lastAt: lastEndMs ? new Date(lastEndMs).toISOString() : null,
      bigGapCount: bigGaps.length
    },
    categories,
    categoriesGrouped,
    apps,
    recordedApps,
    recordedWindows,
    // 展示层：15 分钟一格的主要事件，UI 与 AI 回顾都读这一层
    slots,
    dayBalance: buildDayBalance(slots),
    layers: {
      autoMs: resolvedAtoms.filter(a => a.source === 'auto').reduce((n, a) => n + (a.durationMs || 0), 0),
      importedMs: resolvedAtoms.filter(a => a.source === 'imported').reduce((n, a) => n + (a.durationMs || 0), 0),
      manualMs: resolvedAtoms.filter(a => a.source === 'manual').reduce((n, a) => n + (a.durationMs || 0), 0)
    },
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
        id: s.id,
        start: s.startTime,
        end: s.endTime,
        durationMs: s.durationMs,
        focusText: s.focusText,
        notesCount: s.notesCount
      })),
      didaSessions: didaSessions.map(s => ({
        id: s.id,
        start: new Date(s.startMs).toISOString(),
        end: new Date(Number(s.endMs) || Number(s.startMs) + Number(s.durationMs || 0)).toISOString(),
        durationMs: Math.max(0, Number(s.durationMs) - Number(s.pauseMs || 0)),
        focusText: s.title || '专注',
        note: s.note || ''
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
  const reports = dates.map(d => buildDayReport(dataDir, d, opts));
  const perDay = reports.map(r => {
    return {
      date: r.date,
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

  for (const report of reports) {
    const day = report;
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
// 轻量：逐日「全部已记录时长」(供前端热力图使用)
//
// 口径必须与 buildDayReport().stats.recordedMs 完全一致：该值经过
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
        out.push({ date: dateStr, trackedMs: report.stats.recordedMs });
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
    lines.push(`- 空档（锁屏/未记录）：${formatDuration(s.idleMs)}（已从有效工时中剔除）`);
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

  if (report.focus.arhatSessions.length || (report.focus.didaSessions || []).length || report.focus.notes.length) {
    lines.push('## 专注与随手记');
    lines.push('');
    for (const fs2 of report.focus.arhatSessions) {
      lines.push(`- 罗汉专注 ${toHm(fs2.start)}–${toHm(fs2.end)}（${formatDuration(fs2.durationMs)}）：${fs2.focusText || '未命名'}`);
    }
    for (const fs2 of report.focus.didaSessions || []) {
      lines.push(`- 滴答专注 ${toHm(fs2.start)}–${toHm(fs2.end)}（${formatDuration(fs2.durationMs)}）：${fs2.focusText}${fs2.note ? ` · ${fs2.note}` : ''}`);
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
  // 模型输入也使用展示层优先级，人工补记不能与同一时段的窗口采样相加。
  const allSessions = foldSessions(resolveByPriority(workAtoms), opts);

  // 锁屏/登录界面归为空档，不参与工作内容
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
  simpleCategory,
  SIMPLE_GROUP_NAMES,
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
