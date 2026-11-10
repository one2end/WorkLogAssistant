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

/**
 * 自动录制要多满才把一格算成「已记录」。
 *
 * 为什么不是 1.0：真实录制永远凑不满整格。切应用、游戏加载、
 * 采样间隔、锁屏边界都会留几秒空隙，实测一段连续一小时游戏，
 * 四格覆盖率是 51.7% / 94.1% / 97.8% / 74.2%——按 100% 判会全部落空，
 * 用户看到的就是「一直在玩，却一分钟都没记上」。
 *
 * 0.6（9 分钟）的好处：打开软件瞟几秒、几分钟的零碎停留仍然不算，
 * 那几格依然可以手工补记；而一段真正坐下来的时间能正常落格。
 */
const AUTO_SLOT_FILL_RATIO = 0.6;

const DEFAULT_OPTIONS = {
  // 采样间隔（毫秒）。仅用于给「当日最后一条」这类无后继记录兜底
  sampleGapMs: 60 * 1000,
  // 单段停留时长封顶。超过则视为空档/未采集，避免一晚挂机刷出 10 小时
  maxSegmentMs: 20 * 60 * 1000,
  // 相邻记录间隔超过此值，判定为数据空档（休眠、应用未运行等）
  idleGapMs: 10 * 60 * 1000,
  /**
   * 夹在两段「同一件事」中间的短活动，短于此值时被跨过去。
   *
   * 实测一天的原始记录：一场 15 分钟的游戏，中间会插进
   * LeagueClientUx（客户端）、ACE-Helper（反作弊）和切出去看一眼的窗口，
   * 每段 3–30 秒，加起来不到一分钟，却把整场游戏切断成 8 分钟 + 5 分钟。
   * 于是「我明明打了两小时游戏」在时间线上是一堆几分钟的碎片。
   *
   * 默认 2 分钟：几秒钟的客户端闪动、查文件或回复一句消息，仍属于原活动；
   * 更长的切换保持独立。用户可以在设置里按自己的工作节奏调整。
   */
  bridgeFragmentMs: 120 * 1000,
  // 时间线中默认隐藏的短会话阈值
  minSessionMs: 60 * 1000,
  // 每个应用最多展示多少个窗口标题
  maxTitlesPerApp: 6
};

/**
 * 分类规则：窗口标题优先于通用应用名；用户固定映射和窗口例外在前。
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
    // 游戏单独成类，不并进「影音娱乐」：
    // 玩游戏和看视频在「今天过得怎么样」这件事上完全是两回事，
    // 混在一起看统计会得出错误结论。也避免落到「其他」里被当成未归类。
    //
    // 只列确定的游戏进程。javaw（通用 Java 进程）、tencentdl（下载器）
    // 这类会误伤其他软件的名字不收——宁可不认，也不要给错标签。
    name: '游戏',
    apps: ['league of legends', 'leagueclientux', 'leagueclient', 'riotclientservices',
      'valorant', 'valorant-win64-shipping', 'genshinimpact', 'yuanshen',
      'starrail', 'cs2', 'csgo', 'dota2', 'pubg', 'apex_legends',
      'overwatch', 'minecraft', 'robloxplayerbeta', 'gta5', 'rdr2', 'eldenring',
      'hoyoplay', 'battle.net', 'ace-helper'],
    titles: ['league of legends', 'valorant', '原神', '崩坏：星穹铁道']
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
  ['娱乐', ['影音娱乐', '游戏']],
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
const LIFE_CATEGORIES = new Set([LIFE_CATEGORY, '影音娱乐', '生活', '娱乐', SLEEP_CATEGORY]);

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

  // iCloud 冲突副本：数据目录在同步盘里时，同名文件被别处改过会生成
  // "2026-11-08 2.jsonl" 这样的副本。只读主文件的话，那部分记录会凭空消失。
  const actDir = path.join(dataDir, 'activities');
  const base = `${dateStr}.jsonl`;
  let files = [path.join(actDir, base)];
  try {
    if (fs.existsSync(actDir)) {
      for (const name of fs.readdirSync(actDir)) {
        if (name === base || !name.endsWith('.jsonl')) continue;
        if (!name.startsWith(dateStr)) continue;
        files.push(path.join(actDir, name));
      }
    }
  } catch (_) { /* 目录读不到就只用主文件 */ }

  let index = 0;
  for (const jsonlPath of files) {
    try {
      if (!fs.existsSync(jsonlPath)) continue;
      const raw = fs.readFileSync(jsonlPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed);
          if (!rec || !rec.t) continue;
          items.push({
            id: `${rec.t}#${index++}`,
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
            category: rec.cat || undefined,
            project: Object.prototype.hasOwnProperty.call(rec, 'project')
              ? String(rec.project || '') : undefined
          });
        } catch (e) { /* 单行损坏跳过 */ }
      }
    } catch (e) { /* ignore */ }
  }

  items.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return items;
}

/** 历史记录层出现过的应用；只列应用，不把手工事项或导入专注当作软件。 */
function listRecordedApps(dataDir, options = {}) {
  const ignored = buildIgnoreSet(options.ignoredApps);
  const apps = new Map();
  for (const date of listDates(dataDir)) {
    for (const row of readDayRaw(dataDir, date)) {
      if ((row.source && row.source !== 'auto') || row.kind === 'idle') continue;
      const name = String(row.processName || '').trim();
      if (!name || ignored.has(name.toLowerCase())) continue;
      const key = name.toLowerCase().replace(/\.exe$/, '');
      const item = apps.get(key) || { key, name, count: 0, lastDate: date };
      item.count += 1;
      item.lastDate = date;
      apps.set(key, item);
    }
  }
  return [...apps.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 设置页使用异步扫描，避免 iCloud 历史文件阻塞 Electron 主进程。 */
async function listRecordedAppsAsync(dataDir, options = {}) {
  const dir = path.join(dataDir, 'activities');
  let files;
  try { files = (await fs.promises.readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.(json|jsonl)$/.test(f)); }
  catch (_) { return []; }
  const ignored = buildIgnoreSet(options.ignoredApps);
  const apps = new Map();
  for (let offset = 0; offset < files.length; offset += 6) {
    const batch = await Promise.all(files.slice(offset, offset + 6).map(async file => {
      try {
        const content = await fs.promises.readFile(path.join(dir, file), 'utf8');
        const rows = file.endsWith('.jsonl') ? content.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch (_) { return null; }
        }) : JSON.parse(content);
        return { date: file.slice(0, 10), rows: Array.isArray(rows) ? rows : [], jsonl: file.endsWith('.jsonl') };
      } catch (_) { return { date: file.slice(0, 10), rows: [], jsonl: false }; }
    }));
    for (const file of batch) for (const row of file.rows) {
      if (!row || (row.source && row.source !== 'auto') || row.kind === 'idle') continue;
      const name = String((file.jsonl ? row.app : row.processName) || '').trim();
      if (!name || ignored.has(name.toLowerCase())) continue;
      const key = name.toLowerCase().replace(/\.exe$/, '');
      const item = apps.get(key) || { key, name, count: 0, lastDate: file.date };
      item.count += 1;
      if (file.date > item.lastDate) item.lastDate = file.date;
      apps.set(key, item);
    }
  }
  return [...apps.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

function buildClassifier(rules, appCategoryMap = {}, windowCategoryRules = [], customCategories = []) {
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
  const customGroups = new Map((customCategories || []).map(c => [c.key || c.name, c.group || '其他']));

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

    for (const rule of windowCategoryRules || []) {
      const targetApp = String(rule.app || '').trim().toLowerCase().replace(/\.exe$/, '');
      const keyword = String(rule.titleContains || '').trim().toLowerCase();
      if (targetApp === app && keyword.length >= 2 && title.includes(keyword) && rule.category) return rule.category;
    }
    const mapped = appCategoryMap[app] || appCategoryMap[`${app}.exe`];
    if (mapped) return mapped;

    for (const rule of compiled) {
      if (rule.excludeFromTotal && rule.apps.some(k => matchesApp(app, k))) return rule.name;
    }
    for (const rule of compiled) {
      if (rule.titles.some(k => title.includes(k))) return rule.name;
    }
    for (const rule of compiled) {
      if (rule.apps.some(k => matchesApp(app, k))) return rule.name;
    }
    return FALLBACK_CATEGORY;
  }

  classify.isExcluded = (category) => excluded.has(category);
  /**
   * 「生活事务」类：吃饭、家务、通勤、陪家人、睡觉之外的日常。
   * 它们要出现在时间线上（一天是完整的），但不能算进有效工作工时，
   * 否则手工补记的全天记录会把"有效工时"顶到 18 小时。
   */
  classify.isLife = (category) => LIFE_CATEGORIES.has(category) || ['生活', '娱乐', '睡眠'].includes(customGroups.get(category));
  classify.isSleep = (category) => category === SLEEP_CATEGORY || customGroups.get(category) === '睡眠';
  return classify;
}

// ---------------------------------------------------------------------------
// 核心：时长推断 + 会话折叠
// ---------------------------------------------------------------------------

/**
 * 把原始记录标准化为原子事件，并按时间排序。
 * 自动丢弃异常记录（无时间戳 / 无法解析）。
 */
function resolveCategoryMerge(category, merges = {}) {
  let current = category;
  const seen = new Set();
  while (merges[current]) {
    if (seen.has(current)) return category;
    seen.add(current);
    current = merges[current];
  }
  return current;
}

function normalizeRaw(rawItems, classify, ignoreSet, mappedApps = new Set(), windowCategoryRules = [], categoryMerges = {}, projectRules = []) {
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
    const source = item.source === 'manual' ? 'manual'
      : (item.source === 'dida' || item.source === 'uptimer' || item.source === 'imported') ? 'imported' : 'auto';
    const normalizedApp = app.toLowerCase().replace(/\.exe$/, '');
    const hasWindowRule = windowCategoryRules.some(rule =>
      String(rule.app || '').toLowerCase().replace(/\.exe$/, '') === normalizedApp &&
      String(rule.titleContains || '').trim().length >= 2 &&
      title.toLowerCase().includes(String(rule.titleContains).toLowerCase()));
    const category = source === 'auto' && (hasWindowRule || mappedApps.has(normalizedApp))
      ? classify(app, title) : (item.category || classify(app, title));
    const haystack = `${app} ${title}`.toLowerCase();
    const projectRule = (projectRules || []).find(rule => {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : String(rule.keywords || '').split(/[,，]/);
      return rule.name && keywords.some(keyword => {
        const word = String(keyword || '').trim().toLowerCase();
        return word.length >= 2 && haystack.includes(word);
      });
    });
    atoms.push({
      ms,
      app,
      title,
      category: resolveCategoryMerge(category, categoryMerges),
      // 手工标注明确写入空项目时，视为用户主动清空，不能再被规则补回。
      project: String(item.project !== undefined ? item.project : (projectRule?.name || '')).trim(),
      kind: item.kind === 'idle' ? 'idle' : 'active',
      // 三层来源要原样保留：优先级消解靠它区分
      // manual（本人补记）> imported（导入的标注）> focus（专注）> auto（录制）
      source,
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
      catMs: {}, appMs: {}, layerMs: {}, titleMs: {}, noteMs: {}, focusMs: {}, projectMs: {},
      // 有效占用（毫秒）：决定这一格算不算「已记录」
      substantiveMs: 0,
      // 自动录制在该格里的占用：只有占满整格才算数
      autoMs: 0
    });
  }

  /**
   * 一格要不要算「有记录」，取决于这一格有没有实质占用。
   *
   * 问题是自动录制：打开一个软件一秒、扫一眼、关掉，会在某个 15 分钟格里
   * 留下十几秒的采样。如果「有采样就算这一格有记录」，
   * 那用户看到的是「这 15 分钟我记过了」，可实际上什么都没做，
   * 于是那一格永远轮不到手工补记——而那正是最该补的地方。
   *
   * 规则（按来源分层）：
   *   · 专注（focus）      ：整格都算，这是用户明确声明过的
   *   · 手工标注（manual） ：整格都算，用户自己填的
   *   · 自动录制（auto）    ：占满一定比例就算「有记录」
   *   · 导入（imported）   ：同自动录制
   *
   * 关于那个「一定比例」——之前要求 100% 占满，是错的。
   * 真实录制永远凑不满整格：切换应用、游戏加载画面、采样间隔、锁屏边界
   * 都会留几秒到几十秒的空隙。实测玩了一小时游戏，四格覆盖分别是
   * 51.7% / 94.1% / 97.8% / 74.2%，按 100% 判全部落空——
   * 用户看到的就是「一直在玩，但一分钟都没记上」。
   * 现在按 60%（9 分钟）判：几秒钟的窥探仍然不算，
   * 但一段真正的停留能正常落格。
   */
  const autoThresholdMs = Number.isFinite(options.autoSlotThresholdMs)
    ? options.autoSlotThresholdMs
    : slotMs * AUTO_SLOT_FILL_RATIO;

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
      const isCustom = (options.customCategories || []).some(c => (c.key || c.name) === a.category);
      const cat = (isCustom || a.source === 'manual') && a.category && !CAT_TO_GROUP[a.category]
        ? a.category : simpleCategory(a.category || '其他');
      const segMs = segEnd - cur;
      slot.ms += segMs;
      slot.catMs[cat] = (slot.catMs[cat] || 0) + mins;
      slot.appMs[a.app] = (slot.appMs[a.app] || 0) + mins;
      slot.layerMs[a.source] = (slot.layerMs[a.source] || 0) + mins;
      if (a.source === 'focus' || a.source === 'manual') {
        slot.substantiveMs += segMs;
      } else {
        // 自动录制：累计占用要达到阈值，这一格才算「有记录」
        slot.autoMs += segMs;
      }
      const t = (a.title || '').trim();
      if (t) slot.titleMs[t] = (slot.titleMs[t] || 0) + mins;
      const note = (a.note || '').trim();
      if (note) slot.noteMs[note] = (slot.noteMs[note] || 0) + mins;
      if (a.focusId) slot.focusMs[a.focusId] = (slot.focusMs[a.focusId] || 0) + mins;
      if (a.project) slot.projectMs[a.project] = (slot.projectMs[a.project] || 0) + mins;
      cur = segEnd;
    }
  }

  return slots.map((slot) => {
    // 自动录制累计达到阈值 → 整格算满；否则维持 0（视为空白）
    if (slot.autoMs >= autoThresholdMs && slot.substantiveMs < slotMs) {
      slot.substantiveMs = slotMs;
    }
    const top = Object.entries(slot.catMs).sort((x, y) => y[1] - x[1])[0];
    const app = Object.entries(slot.appMs).sort((x, y) => y[1] - x[1])[0];
    const layer = Object.entries(slot.layerMs).sort((x, y) => y[1] - x[1])[0];
    const title = Object.entries(slot.titleMs).sort((x, y) => y[1] - x[1])[0];
    const note = Object.entries(slot.noteMs).sort((x, y) => y[1] - x[1])[0];
    const focus = Object.entries(slot.focusMs).sort((x, y) => y[1] - x[1])[0];
    const project = Object.entries(slot.projectMs).sort((x, y) => y[1] - x[1])[0];
    return {
      index: slot.index,
      startMin: slot.startMin,
      endMin: Math.min(1440, slot.startMin + slotMin),
      // filledMin 是「有效占用」：
      //   专注/手工标注 → 有多少算多少（但专注独占的格算满）
      //   自动录制     → 累计占用达到整格才算数，否则这格是空的、可以手工补记
      filledMin: Math.min(slotMin, Math.round(slot.substantiveMs / 60000)),
      // sampledMin 是「采样占用」（含自动录制的零碎占用），只用于展示
      sampledMin: Math.round(slot.ms / 60000),
      category: top ? top[0] : null,
      app: app ? app[0] : null,
      layer: layer ? layer[0] : null,
      appPurity: app && slot.ms ? Number((app[1] / (slot.ms / 60000)).toFixed(2)) : 0,
      layerPurity: layer && slot.ms ? Number((layer[1] / (slot.ms / 60000)).toFixed(2)) : 0,
      // 这一格最有代表性的备注（来自人工标注/导入的标题），给日历和时间轴显示
      note: note ? note[0] : (title ? title[0] : ''),
      // 专注会话 id：界面上要能单独删掉一条专注
      focusId: focus ? focus[0] : null,
      project: project ? project[0] : '',
      // 主要事件占该格的比例：低于 0.6 说明这段本身是混合的
      purity: top && slot.ms ? Number((top[1] / (slot.ms / 60000)).toFixed(2)) : 0
    };
  });
}

/**
 * 两段活动算不算「同一件事」。
 *
 * 同进程当然算。不同进程也可能算——英雄联盟一场游戏里前后台会轮换
 * League of Legends（游戏本体）、LeagueClientUx（客户端）、
 * ACE-Helper（反作弊），三个进程名不同，但都是这场游戏的一部分。
 *
 * 兜底分类（「其他」）不参与：那里什么杂项都有，按分类粘合会糊成一团。
 */
function isSameThread(a, b) {
  if (a.project && b.project && a.project !== b.project) return false;
  if (a.app === b.app) return true;
  if (!a.category || a.category !== b.category) return false;
  return a.category !== FALLBACK_CATEGORY;
}

function foldSessions(atoms, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const bridgeMs = Number.isFinite(opts.bridgeFragmentMs) ? opts.bridgeFragmentMs : 120000;
  const sessions = [];

  const absorb = (target, atom) => {
    target.endMs = atom.ms + Math.max(atom.durationMs, 0);
    target.durationMs = target.endMs - target.startMs;
    target.recordCount += 1;
    if (atom.source === 'manual') target.manualCount += 1;
    if (atom.app !== target.app) {
      target.mixedApps = true;
      target.appMs[atom.app] = (target.appMs[atom.app] || 0) + Math.max(atom.durationMs, 0);
    }
    if (atom.title && !target.titles.includes(atom.title)) {
      target.titles.push(atom.title);
    }
    if (atom.durationExact === false) target.hasUncertainty = true;
    if (atom.project) {
      if (!target.project) target.project = atom.project;
      target.projectMs[atom.project] = (target.projectMs[atom.project] || 0) + Math.max(atom.durationMs, 0);
    }
  };

  for (const atom of atoms) {
    if (atom.durationMs <= 0) continue;
    const last = sessions[sessions.length - 1];

    const projectCompatible = last && (!last.project || !atom.project || last.project === atom.project);
    const mergeable = last
      && projectCompatible
      && last.app === atom.app
      && (atom.ms - last.endMs) <= Math.max(opts.sampleGapMs * 2, 120000);

    /**
     * 同分类紧邻也算同一件事。
     *
     * 一场英雄联盟里前台会在游戏本体和客户端之间来回跳，一次 20 分钟；
     * 按进程名分会显示成「15m 游戏 + 24m 客户端」，但对你来说就是打了 39 分钟。
     * 间隔限制在 1 分钟内，真离开去干别的不会被粘回来。
     */
    const sameCategoryAdjacent = last
      && projectCompatible
      && last.category === atom.category
      && last.category !== FALLBACK_CATEGORY
      && (atom.ms - last.endMs) <= Math.max(opts.sampleGapMs, 60000);

    if (mergeable || sameCategoryAdjacent) {
      absorb(last, atom);
      continue;
    }

    /**
     * 跨过一段短碎片把同一件事接上。
     *
     * 不加这一步，一场 15 分钟的游戏会显示成「8 分钟 + 5 分钟」两段，
     * 因为中间插了十几秒的客户端窗口。碎片本身让位，时间由 endMs
     * 覆盖回来——所以两段之间的几十秒会算给正在做的事，
     * 这正是「连续做一件事」的实际感受。
     */
    const prev = sessions.length >= 2 ? sessions[sessions.length - 2] : null;
    if (last && prev
        && last.durationMs <= bridgeMs
        && (atom.ms - prev.endMs) <= bridgeMs * 2
        && isSameThread(prev, atom)) {
      sessions.pop();
      prev.absorbedCount = (prev.absorbedCount || 0) + 1;
      absorb(prev, atom);
      continue;
    }

    sessions.push({
      app: atom.app,
      category: atom.category,
      startMs: atom.ms,
      endMs: atom.ms + atom.durationMs,
      durationMs: atom.durationMs,
      recordCount: 1,
      manualCount: atom.source === 'manual' ? 1 : 0,
      titles: atom.title ? [atom.title] : [],
      hasUncertainty: atom.durationExact === false,
      appMs: { [atom.app]: Math.max(atom.durationMs, 0) },
      project: atom.project || '',
      projectMs: atom.project ? { [atom.project]: Math.max(atom.durationMs, 0) } : {}
    });
  }

  /**
   * 合并过的会话用「待得最久的那个进程名」作代表。
   * 一场游戏里客户端和本体轮流在前台，若固定取第一个，
   * 会出现「49 分钟 LeagueClientUx」这种误导——主体其实是游戏本体。
   */
  for (const s of sessions) {
    if (s.mixedApps && s.appMs) {
      const top = Object.entries(s.appMs).sort((a, b) => b[1] - a[1])[0];
      if (top) s.app = top[0];
    }
    const topProject = Object.entries(s.projectMs || {}).sort((a, b) => b[1] - a[1])[0];
    s.project = topProject ? topProject[0] : '';
    delete s.appMs;
    delete s.projectMs;
  }

  return sessions.filter(s => s.durationMs > 0);
}

/**
 * 把应用会话进一步归并成用户能理解的「活动线程」。
 *
 * 会话回答的是前台窗口发生了什么；线程回答的是这段时间大致在推进什么。
 * 这里只使用本地证据：相邻关系、展示分组、窗口标题和用户标注，不调用模型，
 * 也不把低置信度结果写回标注层。
 */
function buildActivityThreads(sessions, options = {}) {
  const gapLimit = Number(options.activityThreadGapMs) || 5 * 60 * 1000;
  const stop = new Set(['google', 'chrome', 'microsoft', 'edge', 'mozilla', 'firefox', 'wps',
    'office', 'desktop', '微信', '邮e联', '首页', '主页', '新标签页', '未命名窗口']);
  const cleanTitle = (value, app) => String(value || '')
    .replace(/\s+[-—|·]\s+(Google Chrome|Microsoft Edge|WPS Office|微信|邮e联)$/i, '')
    .replace(/\.(docx?|xlsx?|pptx?|pdf|md|txt)$/i, '')
    .trim()
    .slice(0, 100) || String(app || '').trim();
  const titleTokens = (titles, app) => {
    const out = new Set();
    for (const raw of titles || []) {
      const title = cleanTitle(raw, app).toLowerCase();
      for (const token of title.split(/[\s/\\|·—_():：,，。\[\]【】]+/)) {
        const word = token.trim();
        if (!word || stop.has(word) || word === String(app || '').toLowerCase()) continue;
        if (/^[a-z0-9.-]+$/i.test(word) ? word.length >= 4 : word.length >= 2) out.add(word);
      }
    }
    return out;
  };
  const sharesToken = (left, right) => {
    for (const token of left) if (right.has(token)) return true;
    return false;
  };
  const sorted = [...(sessions || [])].filter(s => s && s.durationMs > 0).sort((a, b) => a.startMs - b.startMs);
  const groups = [];

  for (const session of sorted) {
    const tokens = titleTokens(session.titles, session.app);
    const last = groups[groups.length - 1];
    const gap = last ? Math.max(0, session.startMs - last.endMs) : Infinity;
    const sameGroup = last && simpleCategory(last.lastCategory) === simpleCategory(session.category)
      && simpleCategory(session.category) !== '其他';
    const shortSupport = last && (session.durationMs <= 5 * 60 * 1000 || last.lastItem.durationMs <= 5 * 60 * 1000);
    const projectConflict = last && session.project && last.projects.size > 0 && !last.projects.has(session.project);
    const related = last && !projectConflict && gap <= gapLimit &&
      (sharesToken(last.tokens, tokens) || (sameGroup && shortSupport && gap <= Math.min(gapLimit, 2 * 60 * 1000)));

    if (!related) {
      groups.push({ startMs: session.startMs, endMs: session.endMs, items: [session],
        tokens: new Set(tokens), projects: new Set(session.project ? [session.project] : []), lastCategory: session.category, lastItem: session });
      continue;
    }
    last.endMs = Math.max(last.endMs, session.endMs);
    last.items.push(session);
    for (const token of tokens) last.tokens.add(token);
    if (session.project) last.projects.add(session.project);
    last.lastCategory = session.category;
    last.lastItem = session;
  }

  return groups.map((group, index) => {
    const categories = new Map();
    const apps = new Map();
    const titles = [];
    const projects = new Map();
    let manualMs = 0;
    let totalMs = 0;
    for (const item of group.items) {
      const ms = Number(item.durationMs) || 0;
      totalMs += ms;
      categories.set(item.category || '其他', (categories.get(item.category || '其他') || 0) + ms);
      apps.set(item.app || '未知应用', (apps.get(item.app || '未知应用') || 0) + ms);
      if (item.manualCount > 0) manualMs += ms;
      if (item.project) projects.set(item.project, (projects.get(item.project) || 0) + ms);
      for (const title of item.titles || []) {
        const cleaned = cleanTitle(title, item.app);
        if (cleaned && cleaned.toLowerCase() !== String(item.app || '').toLowerCase() && !titles.includes(cleaned)) titles.push(cleaned);
      }
    }
    const [category, categoryMs] = [...categories].sort((a, b) => b[1] - a[1])[0] || ['其他', 0];
    const rankedApps = [...apps].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const label = titles.sort((a, b) => b.length - a.length)[0] || rankedApps[0] || category;
    const project = [...projects].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const durationMs = Math.max(totalMs, group.endMs - group.startMs);
    const dominance = totalMs ? categoryMs / totalMs : 0;
    const switches = Math.max(0, group.items.length - 1);
    const switchesPerHour = switches / Math.max(durationMs / 3600000, 0.25);
    let confidence = 0.2;
    if (titles.length) confidence += 0.25;
    if (durationMs >= 30 * 60000) confidence += 0.2;
    else if (durationMs >= 15 * 60000) confidence += 0.1;
    confidence += Math.min(0.25, dominance * 0.25);
    if (switchesPerHour <= 8) confidence += 0.1;
    if (manualMs > 0) confidence += 0.1;
    confidence = Number(Math.min(0.98, confidence).toFixed(2));
    const at = new Date(group.startMs);
    return {
      id: `${at.getTime()}-${index}`,
      start: at.toISOString(),
      end: new Date(group.endMs).toISOString(),
      startMin: at.getHours() * 60 + at.getMinutes(),
      durationMs,
      label: label.slice(0, 80),
      project,
      category,
      group: simpleCategory(category),
      apps: rankedApps.slice(0, 3),
      evidence: titles.slice(0, 3),
      switchCount: switches,
      confidence,
      source: manualMs > 0 ? 'confirmed' : 'inferred',
      needsConfirmation: confidence < 0.65 || simpleCategory(category) === '其他'
    };
  });
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
  const classify = buildClassifier(opts.categoryRules, opts.appCategoryMap, opts.windowCategoryRules, opts.customCategories);

  const raw = readDayRaw(dataDir, dateStr);
  const atoms = normalizeRaw(raw, classify, buildIgnoreSet(opts.ignoredApps),
    new Set(Object.keys(opts.appCategoryMap || {}).map(k => k.toLowerCase().replace(/\.exe$/, ''))), opts.windowCategoryRules || [], opts.categoryMerges || {}, opts.projectRules || []);

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
  const focusOverrides = safeReadJson(path.join(dataDir, 'arhat', 'overrides', `${dateStr}.json`), []);
  const overrideMap = new Map((Array.isArray(focusOverrides) ? focusOverrides : []).map(o => [String(o.id), o]));
  const didaSessions = readDidaFocus(dataDir, dateStr).map(f => {
    const override = overrideMap.get(`dida:${f.id}`);
    return override ? { ...f, title: override.focusText, note: override.note } : f;
  });
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
      category: resolveCategoryMerge('专注', opts.categoryMerges || {}),
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
  const activityThreads = buildActivityThreads(sessions, opts);
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
  const slots = buildSlots(resolvedAtoms, dateStr, opts);
  const now = new Date();
  const elapsedSlots = dateStr === toDateStr(now)
    ? Math.max(1, Math.min(slots.length, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 15)))
    : slots.length;
  const coveredSlots = slots.slice(0, elapsedSlots).filter(s => s.filledMin > 0).length;
  const slotCoverage = elapsedSlots > 0 ? coveredSlots / elapsedSlots : 0;

  /**
   * 15 分钟对齐的「当日记录时长」。
   *
   * 为什么必须单独算：stats.recordedMs 来自 foldSessions → aggregate，
   * 它把原子之间的空隙也算进时长（endMs - startMs），因此既不是 15 的倍数，
   * 也不是「实际有记录的时间」。而 slots 才是真正的 15 分钟格口径。
   *
   * 口径定义：一个 15 分钟格只有被「占满」才算一格。
   * 记录只占 4 分钟的那一格不算满格——否则「21 小时」这种数字没有意义：
   * 用户看到 21 小时，就会认为剩下 3 小时需要补录，而实际是零碎地占了几百格。
   * 所以：满格数 = 记录时长 >= 15 分钟的格数；总时长 = 满格数 × 15 分钟。
   *
   * 两种「欠账」要分清，不能混：
   *   · 未满格（partial）：格子里有记录，只是没占满 15 分钟。它不是空白，
   *     用户点进去能看到已有内容，所以只统计数量，不单独成段。
   *   · 完全空白（blank）：一格都没有记录。这才是真正的空缺，
   *     可以集中成一长段，是补录的目标。
   */
  const elapsedSlotList = slots.slice(0, elapsedSlots);
  const slotMinUsed = opts.slotMin || 15;
  const slotMsUsed = slotMinUsed * 60000;
  const fullSlots = elapsedSlotList.filter(s => s.filledMin * 60000 >= slotMsUsed).length;
  const partialSlots = elapsedSlotList.filter(s => s.filledMin > 0 && s.filledMin * 60000 < slotMsUsed).length;
  const slotFilledMs = fullSlots * slotMsUsed;
  const blankSlotCount = elapsedSlotList.filter(s => s.filledMin <= 0).length;
  // 未满格已记录的那部分（记了 4 分钟的那种）
  const partialMs = elapsedSlotList.reduce(
    (sum, s) => sum + (s.filledMin > 0 && s.filledMin * 60000 < slotMsUsed ? s.filledMin * 60000 : 0), 0
  );
  // 真正的空缺 = 完全空白的格子；未满格不算空白
  const blankMs = blankSlotCount * slotMsUsed;

  // 连续空白段：只有完全空白的格子才算入，是补录的目标
  const blankRanges = [];
  let blankStart = -1;
  for (let i = 0; i <= elapsedSlotList.length; i += 1) {
    const empty = i < elapsedSlotList.length && elapsedSlotList[i].filledMin <= 0;
    if (empty && blankStart < 0) blankStart = i;
    if (!empty && blankStart >= 0) {
      blankRanges.push({
        startMin: blankStart * slotMinUsed,
        endMin: i * slotMinUsed,
        durationMin: (i - blankStart) * slotMinUsed
      });
      blankStart = -1;
    }
  }

  if (elapsedSlots - coveredSlots > 0) {
    dataNotes.push(`当天已有 ${elapsedSlots - coveredSlots} 个 15 分钟格尚无记录，可在时间轴补充`);
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
      recordedMs: agg.totalMs,
      lifeMs,
      sleepMs,
      idleMs,
      idleSessionCount,
      spanMs,
      coverage: slotCoverage,
      coveredSlots,
      elapsedSlots,
      // 15 分钟对齐口径：首页「当日记录时长」用这个，必为 15 的倍数
      slotFilledMs,
      slotMin: slotMinUsed,
      fullSlots,
      partialSlots,
      partialMs,
      // 空档：已经过去但没有任何记录的时间，可用于提示「今天还欠多少」
      blankMs,
      blankSlotCount,
      blankRanges,
      firstAt: firstMs ? new Date(firstMs).toISOString() : null,
      lastAt: lastEndMs ? new Date(lastEndMs).toISOString() : null,
      bigGapCount: bigGaps.length
    },
    categories,
    categoriesGrouped,
    apps,
    recordedApps,
    recordedWindows,
    activityThreads,
    // 展示层：15 分钟一格的主要事件，UI 与 AI 回顾都读这一层
    slots,
    dayBalance: buildDayBalance(slots, Object.fromEntries((opts.customCategories || []).map(c => [c.key || c.name, c.group || '其他']))),
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
      project: s.project || '',
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
        note: s.note || '',
        source: 'local',
        notesCount: s.notesCount
      })),
      didaSessions: didaSessions.map(s => ({
        id: `dida:${s.id}`,
        start: new Date(s.startMs).toISOString(),
        end: new Date(Number(s.endMs) || Number(s.startMs) + Number(s.durationMs || 0)).toISOString(),
        durationMs: Math.max(0, Number(s.durationMs) - Number(s.pauseMs || 0)),
        focusText: s.title || '专注',
        note: s.note || '',
        source: 'dida'
      })),
      notes: notes.map(n => ({
        id: n.id,
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
  const threadTotals = new Map();
  const projectTotals = new Map();
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
    for (const thread of report.activityThreads || []) {
      const key = `${String(thread.project || '').trim().toLowerCase()}\u0000${String(thread.label || thread.category || '未命名活动').trim().toLowerCase()}`;
      const cur = threadTotals.get(key) || {
        label: thread.label || thread.category || '未命名活动', category: thread.category,
        group: thread.group, project: thread.project || '', durationMs: 0, days: new Set(), confidenceTotal: 0, count: 0
      };
      cur.durationMs += Number(thread.durationMs) || 0;
      cur.days.add(report.date);
      cur.confidenceTotal += Number(thread.confidence) || 0;
      cur.count += 1;
      threadTotals.set(key, cur);
      if (thread.project) {
        const project = projectTotals.get(thread.project) || { name: thread.project, durationMs: 0, days: new Set(), threadCount: 0 };
        project.durationMs += Number(thread.durationMs) || 0;
        project.days.add(report.date);
        project.threadCount += 1;
        projectTotals.set(thread.project, project);
      }
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
      .sort((a, b) => b.durationMs - a.durationMs),
    threads: Array.from(threadTotals.values())
      .map(t => ({
        label: t.label,
        category: t.category,
        group: t.group,
        project: t.project,
        durationMs: t.durationMs,
        dayCount: t.days.size,
        confidence: t.count ? Number((t.confidenceTotal / t.count).toFixed(2)) : 0
      }))
      .sort((a, b) => b.durationMs - a.durationMs),
    projects: Array.from(projectTotals.values())
      .map(p => ({ name: p.name, durationMs: p.durationMs, dayCount: p.days.size, threadCount: p.threadCount,
        percent: grandTotal > 0 ? p.durationMs / grandTotal : 0 }))
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
  const classify = buildClassifier(opts.categoryRules, opts.appCategoryMap, opts.windowCategoryRules, opts.customCategories);
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return { keyword, hits: [], totalDurationMs: 0 };

  const raw = readRangeRaw(dataDir, from, to);
  const atoms = normalizeRaw(raw, classify, buildIgnoreSet(opts.ignoredApps),
    new Set(Object.keys(opts.appCategoryMap || {}).map(k => k.toLowerCase().replace(/\.exe$/, ''))), opts.windowCategoryRules || [], opts.categoryMerges || {}, opts.projectRules || []);
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

/**
 * 历史备注候选：找出过去用过的说法，供写备注时复用。
 *
 * 与 searchActivities 的区别：这里按「文本」聚合，统计同一句话用过几次，
 * 并优先返回与当前应用、当前分类相关的候选——人写备注是重复劳动，
 * 「上次写的那句」往往正是现在要的。
 *
 * @param {string} keyword  关键词，空则返回该应用/分类的常用说法
 */
function findNoteHints(dataDir, keyword, from, to, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const kw = String(keyword || '').trim().toLowerCase();
  const appKey = String((options.app || '')).trim().toLowerCase();
  const categoryKey = String((options.category || '')).trim();

  const raw = readRangeRaw(dataDir, from, to);
  const classify = buildClassifier(opts.categoryRules, opts.appCategoryMap, opts.windowCategoryRules, opts.customCategories);
  const atoms = normalizeRaw(raw, classify, buildIgnoreSet(opts.ignoredApps),
    new Set(Object.keys(opts.appCategoryMap || {}).map(k => k.toLowerCase().replace(/\.exe$/, ''))),
    opts.windowCategoryRules || [], opts.categoryMerges || {}, opts.projectRules || []);

  const tally = new Map();
  for (const a of atoms) {
    const text = String(a.title || '').trim();
    if (!text || text.length > 120) continue;
    const lower = text.toLowerCase();
    if (kw && !lower.includes(kw)) continue;
    // 应用过滤只在没有关键词时生效：搜「张三」时要能跨应用找到人名
    if (!kw && appKey && !String(a.app || '').toLowerCase().includes(appKey)) continue;

    const key = text;
    const hit = tally.get(key) || {
      text, count: 0, lastAt: 0, apps: new Set(), categories: new Set(), manual: 0
    };
    hit.count += 1;
    hit.lastAt = Math.max(hit.lastAt, a.ms || 0);
    if (a.app) hit.apps.add(a.app);
    if (a.category) hit.categories.add(a.category);
    // 手工写过的备注比自动抓到的窗口标题更值得复用
    if (a.source === 'manual') hit.manual += 1;
    tally.set(key, hit);
  }

  let list = [...tally.values()].map(h => ({
    text: h.text,
    count: h.count,
    manual: h.manual,
    lastAt: h.lastAt ? new Date(h.lastAt).toISOString() : '',
    apps: [...h.apps].slice(0, 3),
    categories: [...h.categories].slice(0, 3)
  }));

  // 排序：自己写过的备注 > 同一分类/应用的 > 用得多的 > 最近用的
  list.sort((x, y) => {
    if (x.manual !== y.manual) return y.manual - x.manual;
    const sx = (x.categories.includes(categoryKey) ? 2 : 0) + (x.apps.some(a => appKey && a.toLowerCase().includes(appKey)) ? 1 : 0);
    const sy = (y.categories.includes(categoryKey) ? 2 : 0) + (y.apps.some(a => appKey && a.toLowerCase().includes(appKey)) ? 1 : 0);
    if (sx !== sy) return sy - sx;
    if (x.count !== y.count) return y.count - x.count;
    return String(y.lastAt).localeCompare(String(x.lastAt));
  });

  // 按应用过滤后一条都没有时，回退到全局候选：
  // 用户想不起这个应用以前写过什么时，全局候选比空白有用得多。
  let filtered = list;
  if (!kw && appKey) {
    const scoped = list.filter(h => h.apps.some(a => a.toLowerCase().includes(appKey)));
    if (scoped.length) filtered = scoped;
  }

  return { keyword, hints: filtered.slice(0, 12) };
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
  lines.push(`- 有效记录：${formatDuration(s.trackedMs)}；15 分钟格覆盖率 ${pct(s.coverage)}`);
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
  const classify = buildClassifier(opts.categoryRules, opts.appCategoryMap, opts.windowCategoryRules, opts.customCategories);
  const atoms = normalizeRaw(rawItems, classify, buildIgnoreSet(opts.ignoredApps),
    new Set(Object.keys(opts.appCategoryMap || {}).map(k => k.toLowerCase().replace(/\.exe$/, ''))), opts.windowCategoryRules || [], opts.categoryMerges || {}, opts.projectRules || []);

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
  const activityThreads = buildActivityThreads(sessions, opts);

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
    idleMs,
    activityThreads
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
  resolveCategoryMerge,
  foldSessions,
  buildActivityThreads,
  buildIgnoreSet,
  listRecordedApps,
  listRecordedAppsAsync,
  buildDayReport,
  buildRangeReport,
  buildDailyTrackedMs,
  searchActivities,
  findNoteHints,
  renderDayMarkdown,
  renderRangeMarkdown,
  renderPromptContext
};
