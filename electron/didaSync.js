/**
 * 滴答清单同步插件（主进程）。
 *
 * 两条独立通道：
 *   pull —— 把滴答的专注记录拉成本地只读镜像 Data/dida/focus/*.json，
 *           再由 analytics 喂进展示层第二层级（focus）。不写 activities/。
 *   push —— 把展示层标注写成滴答任务。默认关闭，必须同时满足
 *           enabled / pushEnabled / pushProjectId 才会真正发请求。
 *
 * 只读镜像与推送去重都落在数据目录里，随时可删可重拉；同步统计单独存
 * sync-status.json，不写进 config.json，避免每次同步触发全量配置落盘。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_BASE = 'https://api.dida365.com/open/v1';
const PAGE_DAYS = 30;          // 官方单次最多 30 天
const PUSH_LIMIT = 20;         // 单次最多推送 20 条，防止刷屏
const PUSH_DELETE_LIMIT = 40;  // 单次最多清理 40 条旧任务，防止误删刷屏

/**
 * 推送记录（pushed.json）的三个版本，读取时要能同时兼容：
 *
 *   v1  { "<key>": "<ISO 时间>" }                     —— 只知道「推过」，没有 id
 *   v2  { "<key>": { id, at } }                        —— 记下 taskId，能删
 *   v3  { "<key>": { id, at, start, end, date } }      —— 还能按时间范围对账
 *
 * 为什么必须记 id：滴答的清单接口只返回**未完成**的任务，推过去并标记完成之后
 * 就再也查不到了。所以「这条旧任务要不要删」只能靠本地记录判断，删也得靠本地存的 id。
 *
 * 为什么去重键不能只看内容指纹：一条 1 小时的记录先被推成 A，后来和邻段合并成
 * 2 小时，指纹（含时长）就变了，于是被当成新记录再推一条 B——A 还留在滴答里。
 * 现在改成按「时间范围」判断：同一段时间只应该有一条任务。
 */
const PUSH_RECORD_VERSION = 3;

function pad(n) { return String(n).padStart(2, '0'); }

function localDateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时间带时区偏移，滴答 from/to 要求这种格式 */
function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${localDateStr(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

/** 滴答返回 "2026-10-20T14:04:48.000+0000"，补一个冒号才稳定解析 */
function parseDidaTime(value) {
  if (!value) return NaN;
  const s = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** 滴答 startDate/dueDate 要求 UTC 的 +0000 形式 */
function didaUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000+0000`;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data === null || data === undefined ? fallback : data;
  } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function formatRecordTask(session, categoryNames = {}) {
  const category = categoryNames[session.category] || session.category || '其他';
  const app = String(session.app || '').trim();
  let remark = String((session.titles || []).filter(Boolean).join(' · ') || session.note || '').trim();
  if (!remark && !['手工标注', '手工记录', category].includes(app)) remark = app;
  if (remark.startsWith(`${category}-`) || remark.startsWith(`${category}－`)) remark = remark.slice(category.length + 1).trim();
  const full = remark ? `${category}-${remark}` : category;
  const chars = Array.from(full);
  return { title: chars.slice(0, 30).join(''), overflow: chars.slice(30).join('') };
}

/**
 * 把推送记录统一成 v3 结构。入参是已经解析过的 JSON 对象。
 *
 * v1 的值只是一个时间字符串、没有 taskId——那批任务是本次改造之前推的，
 * 删不掉（滴答查不到已完成任务），只能照样当作「已推过」避免重复。
 * 这里把它们标成 start/end 为 null，既不会参与区间对账，也不会被误删。
 */
function readPushRecords(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value && typeof value === 'object') {
      out[key] = {
        id: value.id || '',
        at: value.at || '',
        start: Number.isFinite(value.start) ? value.start : null,
        end: Number.isFinite(value.end) ? value.end : null,
        date: value.date || ''
      };
    } else if (typeof value === 'string' && value) {
      out[key] = { id: '', at: value, start: null, end: null, date: '' };
    }
  }
  return out;
}

/**
 * 旧记录是否该被「当前这批标注」取代。
 *
 * 核心规则：**同一段时间只应该存在一条任务**。
 * 只要当前标注里找不到一条与它时间范围完全一致（±1 分钟）的，
 * 这条旧记录就已经过时——合并、拆分、挪时间、干脆删掉，都归到这一类。
 *
 * 为什么不比较内容指纹：一条 13:00–14:00 的记录被合并进 13:00–15:00 之后，
 * 内容固然变了，但真正的判定依据是「这段时间现在归谁」。
 * 用区间判断，合并和拆分才不会各写一套逻辑。
 */
function hasSameRange(record, live) {
  return Math.abs(record.start - live.start) < 60000 && Math.abs(record.end - live.end) < 60000;
}

/**
 * 一条待推标注是否已经有对应记录。
 *
 * 分两种情况：
 *   · v1 老记录没有区间，只能退回按「日期 + 起始分钟」比对，
 *     这样改造前推过的段不会重复推一遍；
 *   · 有区间的记录一律按区间比对——同一起点但终点变了（合并/拉长），
 *     必须当成新任务重推，否则合并后的内容永远推不出去。
 */
function liveHasRecord(records, item) {
  const direct = records[pushKey(item.date, item.start)];
  if (direct && (direct.start === null || direct.end === null)) return true;
  return Object.values(records).some(rec => (
    rec.start !== null && rec.end !== null && hasSameRange(rec, item)
  ));
}

/** 推送记录的去重键：同一天同一起点视为同一条 */
function pushKey(date, startMs) {
  return `${date}:${Math.round(startMs / 60000)}`;
}

function normalizeProjectName(value) {
  return String(value || '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, '')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    .trim();
}

function planCategory(title) {
  const raw = String(title || '').trim();
  const prefix = raw.split(/[-—－:：]/)[0].trim();
  if (/睡/.test(prefix)) return '睡眠';
  if (/工作/.test(prefix)) return '工作';
  if (/学习/.test(prefix)) return '学习';
  if (/专注/.test(prefix)) return '专注';
  if (/娱乐|游戏/.test(prefix)) return '娱乐';
  if (/家庭|生活|日常|健康|个人|吃饭|洗漱|锻炼|运动/.test(prefix)) return '生活';
  return '其他';
}

function planLabel(title) {
  const raw = String(title || '').trim();
  const parts = raw.split(/[-—－:：]/);
  const detail = parts.slice(1).join('-').trim();
  // 旧的重复模板里有不少“工作-”这类占位标题。分隔符后没有事项时，
  // 退回干净的分类名，不把尾部符号带到首页。
  const fallback = raw.replace(/[-—－:：\s]+$/g, '').trim();
  return detail || fallback || '未命名计划';
}

function parseRule(flag) {
  const out = {};
  const raw = String(flag || '').replace(/^RRULE:/i, '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  return out;
}

function dayNumber(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

function matchesPlanDate(item, dateStr) {
  const baseDate = localDateStr(item.startMs);
  const diffDays = dayNumber(dateStr) - dayNumber(baseDate);
  if (diffDays < 0) return false;
  if (!item.repeatFlag) return dateStr === baseDate;

  const rule = parseRule(item.repeatFlag);
  const target = new Date(`${dateStr}T12:00:00`);
  const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][target.getDay()];
  const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  const skipped = String(rule.TT_SKIP || '').toUpperCase().split(',');
  if (skipped.includes('WEEKEND') && ['SA', 'SU'].includes(weekday)) return false;

  if (rule.FREQ === 'DAILY') return diffDays % interval === 0;
  if (rule.FREQ === 'WEEKLY') {
    const days = String(rule.BYDAY || '').split(',').filter(Boolean);
    return (days.length ? days.includes(weekday) : weekday === ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(item.startMs).getDay()])
      && Math.floor(diffDays / 7) % interval === 0;
  }
  if (rule.FREQ === 'MONTHLY') {
    const days = String(rule.BYMONTHDAY || new Date(item.startMs).getDate()).split(',').map(Number);
    const base = new Date(item.startMs);
    const monthDiff = (target.getFullYear() - base.getFullYear()) * 12 + target.getMonth() - base.getMonth();
    return monthDiff >= 0 && monthDiff % interval === 0 && days.includes(target.getDate());
  }
  return dateStr === baseDate;
}

class DidaSync {
  /**
   * @param {object} deps
   *   getConfig  —— 取最新配置（含 config.local.json 里的 token）
   *   getDataDir —— 取最新数据目录（用户可改存储路径）
   *   broadcast  —— (channel, payload) 推给渲染层
   *   buildDayReport —— 可选，推送时读取展示层
   */
  constructor({ getConfig, getDataDir, broadcast, buildDayReport }) {
    this.getConfig = getConfig;
    this.getDataDir = getDataDir;
    this.broadcast = broadcast || (() => {});
    this.buildDayReport = buildDayReport || null;
    this.busy = { pull: false, plans: false, push: false };
    this.timer = null;
  }

  cfg() {
    return (this.getConfig() && this.getConfig().dida) || {};
  }

  dirs() {
    const root = path.join(this.getDataDir(), 'dida');
    return {
      root,
      focus: path.join(root, 'focus'),
      plans: path.join(root, 'plans'),
      status: path.join(root, 'sync-status.json'),
      pushed: path.join(root, 'pushed.json')
    };
  }

  readStatus() {
    const d = this.dirs();
    const s = readJson(d.status, {});
    return {
      lastPullAt: s.lastPullAt || '',
      lastPlanPullAt: s.lastPlanPullAt || '',
      lastPushAt: s.lastPushAt || '',
      pulledTotal: Number(s.pulledTotal) || 0,
      pushedTotal: Number(s.pushedTotal) || 0,
      todayDate: s.todayDate || '',
      todayPulled: Number(s.todayPulled) || 0,
      todayPushed: Number(s.todayPushed) || 0,
      lastPullCount: Number(s.lastPullCount) || 0,
      lastPlanPullCount: Number(s.lastPlanPullCount) || 0,
      planProjectId: s.planProjectId || '',
      planProjectName: s.planProjectName || '',
      lastPushCount: Number(s.lastPushCount) || 0,
      // 上一次推送顺带清理掉多少条被合并/改动的旧任务
      lastRemovedCount: Number(s.lastRemovedCount) || 0,
      lastPushNote: s.lastPushNote || '',
      lastError: s.lastError || ''
    };
  }

  /** 对外状态：跨天自动把「今日」清零，并带上镜像规模 */
  status() {
    const s = this.readStatus();
    const today = localDateStr(Date.now());
    if (s.todayDate !== today) {
      s.todayDate = today;
      s.todayPulled = 0;
      s.todayPushed = 0;
      this.writeStatus(s);
    }
    const d = this.dirs();
    let mirrorRecords = 0;
    let mirrorDays = 0;
    try {
      if (fs.existsSync(d.focus)) {
        const files = fs.readdirSync(d.focus).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
        mirrorDays = files.length;
        for (const f of files) {
          const rows = readJson(path.join(d.focus, f), []);
          if (Array.isArray(rows)) mirrorRecords += rows.length;
        }
      }
    } catch (_) { /* 统计失败不影响状态展示 */ }
    const todayRows = readJson(path.join(d.focus, `${today}.json`), []);
    const list = Array.isArray(todayRows) ? todayRows : [];
    const todayFocusCount = list.length;
    const todayFocusMinutes = Math.round(
      list.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0) / 60000
    );
    const planCache = readJson(path.join(d.plans, 'templates.json'), { items: [] });
    return {
      ...s, today, mirrorRecords, mirrorDays,
      todayFocusCount, todayFocusMinutes,
      planTemplateCount: Array.isArray(planCache.items) ? planCache.items.length : 0,
      busy: { ...this.busy }
    };
  }

  writeStatus(s) {
    writeJson(this.dirs().status, s);
    this.broadcast('dida-status', this.status());
  }

  /** 拉取分页：官方单次最多 30 天，type=0 番茄钟 / type=1 正向计时 */
  async fetchWindow(token, fromMs, toMs, type) {
    const res = await axios.get(`${API_BASE}/focus`, {
      params: { from: localIso(fromMs), to: localIso(toMs), type },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
      // 本机环境变量里有代理，axios 走代理会把 https 请求以明文发到 443，
      // 表现为 400 "The plain HTTP request was sent to HTTPS port"。直连可用。
      proxy: false
    });
    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * 拉取账号下的清单列表，供设置页下拉选择推送目标。
   *
   * 只读缓存到 Data/dida/projects.json：滴答的清单接口没有增量参数，
   * 每次都要全量取一遍，缓存下来可以让设置页打开就能显示，
   * 不必等一次网络往返，也不至于每次进设置都打一次接口。
   */
  async listProjects({ force = false } = {}) {
    const cfg = this.cfg();
    if (!cfg.token) return { ok: false, error: '请先填写滴答 API 口令' };

    const d = this.dirs();
    const cacheFile = path.join(d.root, 'projects.json');
    const cache = readJson(cacheFile, { at: 0, items: [] });
    const fresh = Date.now() - (cache.at || 0) < 10 * 60000;
    if (!force && fresh && Array.isArray(cache.items) && cache.items.length) {
      return { ok: true, items: cache.items, cached: true };
    }

    try {
      const res = await axios.get(`${API_BASE}/project`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        timeout: 15000,
        proxy: false
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      const items = rows
        .map((p) => ({
          id: String(p.id || ''),
          name: String(p.name || '').trim() || '未命名清单',
          color: p.color || '',
          // 滴答里「收集箱」是 kind 或 closed 为空的那一类，界面上标一下
          closed: p.closed === true,
          kind: p.kind || ''
        }))
        .filter((p) => p.id && !p.closed)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

      fs.mkdirSync(d.root, { recursive: true });
      writeJson(cacheFile, { at: Date.now(), items });
      return { ok: true, items };
    } catch (e) {
      // 网络失败时退回旧缓存，总比设置页一片空白强
      if (Array.isArray(cache.items) && cache.items.length) {
        return { ok: true, items: cache.items, cached: true, warning: `清单列表刷新失败，显示上次结果：${e.message || e}` };
      }
      return { ok: false, error: `读取清单失败：${e.response?.status || ''} ${e.message || e}`.trim() };
    }
  }

  /**
   * 拉取《记录》里的生效任务作为只读计划模板。
   *
   * 计划与事实必须分层：这里只写 Data/dida/plans/templates.json，绝不写
   * activities/，也不进入 trackedMs。没有显式选择清单时，自动匹配名称为
   * “记录”的清单，兼容前面带 emoji 的命名。
   */
  async pullPlans({ manual = false } = {}) {
    if (this.busy.plans) return { ok: false, skipped: true, reason: '计划正在同步中' };
    const cfg = this.cfg();
    if (!cfg.enabled || cfg.pullPlans === false) {
      return { ok: false, skipped: true, reason: '滴答同步或计划参考未开启' };
    }
    if (!cfg.token) return { ok: false, error: '请先填写滴答 API 口令' };

    this.busy.plans = true;
    this.broadcast('dida-status', this.status());
    try {
      const projects = await this.listProjects({ force: manual });
      if (!projects.ok) return projects;
      const chosen = cfg.planProjectId
        ? projects.items.find(p => p.id === cfg.planProjectId)
        : projects.items.find(p => normalizeProjectName(p.name) === '记录');
      if (!chosen) {
        const s = this.status();
        s.lastError = '没有找到计划来源清单；请在设置中选择《记录》清单';
        this.writeStatus(s);
        return { ok: false, error: s.lastError };
      }

      const res = await axios.get(`${API_BASE}/project/${encodeURIComponent(chosen.id)}/data`, {
        headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 15000, proxy: false
      });
      const rows = Array.isArray(res.data?.tasks) ? res.data.tasks : [];
      const items = rows.filter(row => {
        const tags = (Array.isArray(row.tags) ? row.tags : []).map(tag => String(tag).toLowerCase());
        return row && row.id && Number(row.status || 0) === 0 && !tags.includes('lifelog');
      }).map(row => {
        const startMs = parseDidaTime(row.startDate);
        const dueMs = parseDidaTime(row.dueDate);
        if (!Number.isFinite(startMs)) return null;
        const durationMs = Number.isFinite(dueMs) && dueMs > startMs ? dueMs - startMs : 30 * 60000;
        return {
          id: String(row.id), etag: String(row.etag || ''), title: String(row.title || '').trim(),
          label: planLabel(row.title), category: planCategory(row.title), startMs, durationMs,
          repeatFlag: String(row.repeatFlag || ''), repeatFrom: String(row.repeatFrom || ''),
          timeZone: row.timeZone || 'Asia/Shanghai', isAllDay: row.isAllDay === true
        };
      }).filter(Boolean).sort((a, b) => a.startMs - b.startMs);

      const d = this.dirs();
      fs.mkdirSync(d.plans, { recursive: true });
      writeJson(path.join(d.plans, 'templates.json'), {
        at: Date.now(), projectId: chosen.id, projectName: chosen.name, items
      });
      const s = this.status();
      s.lastPlanPullAt = new Date().toISOString();
      s.lastPlanPullCount = items.length;
      s.planProjectId = chosen.id;
      s.planProjectName = chosen.name;
      s.lastError = '';
      this.writeStatus(s);
      this.broadcast('data-changed', { reason: 'dida-plan-pull' });
      return { ok: true, count: items.length, projectId: chosen.id, projectName: chosen.name, manual };
    } catch (e) {
      const s = this.status();
      s.lastError = `计划拉取失败：${e.response?.status || ''} ${e.message || e}`.trim();
      this.writeStatus(s);
      return { ok: false, error: s.lastError };
    } finally {
      this.busy.plans = false;
      this.broadcast('dida-status', this.status());
    }
  }

  /** 按需展开某一天的计划实例；只读投影，不落成活动记录。 */
  getPlanForDate(dateStr) {
    const cfg = this.cfg();
    if (!cfg.enabled || cfg.pullPlans === false || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return [];
    const cache = readJson(path.join(this.dirs().plans, 'templates.json'), { items: [] });
    const rows = Array.isArray(cache.items) ? cache.items : [];
    const [y, m, d] = dateStr.split('-').map(Number);
    return rows.filter(item => matchesPlanDate(item, dateStr)).map(item => {
      const base = new Date(item.startMs);
      const start = new Date(y, m - 1, d, base.getHours(), base.getMinutes(), 0, 0);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const durationMin = Math.max(15, Math.round((Number(item.durationMs) || 1800000) / 60000));
      return {
        id: `${item.id}:${dateStr}`, templateId: item.id, source: 'dida-plan',
        title: item.title, label: item.label, category: item.category,
        start: start.toISOString(), end: new Date(start.getTime() + durationMin * 60000).toISOString(),
        startMin, endMin: Math.min(1440, startMin + durationMin), durationMin,
        repeat: !!item.repeatFlag, projectId: cache.projectId || '', projectName: cache.projectName || ''
      };
    }).sort((a, b) => a.startMin - b.startMin);
  }

  /** 把一条滴答专注拆成本地日镜像记录（跨午夜按天切开） */
  normalize(row) {
    const id = String(row.id || '');
    if (!id) return [];
    const start = parseDidaTime(row.startTime);
    const end = parseDidaTime(row.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    // 只同步已完成的专注：status 1 = 完成；没有 status 的旧数据按完成处理
    if (row.status !== undefined && Number(row.status) !== 1) return [];

    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    const taskTitle = (tasks.find(t => t && t.title) || {}).title || '';
    const rawTitle = row.timerName || taskTitle || row.note || '专注';
    const title = String(rawTitle).trim().slice(0, 80) || '专注';
    const note = String(row.note || '').trim().slice(0, 300);
    const pauseRaw = Number(row.pauseDuration) || 0;
    // 文档示例是秒、MCP 返回毫秒：大于 1000 视为毫秒，否则按秒
    const pauseMs = pauseRaw > 1000 ? pauseRaw : pauseRaw * 1000;

    const pieces = [];
    let cursor = start;
    while (cursor < end) {
      const dayStart = new Date(cursor);
      dayStart.setHours(0, 0, 0, 0);
      const nextDay = dayStart.getTime() + 86400000;
      const stop = Math.min(end, nextDay);
      pieces.push({
        id: pieces.length ? `${id}#${pieces.length}` : id,
        source: 'dida',
        type: Number(row.type) || 0,
        etag: String(row.etag || ''),
        date: localDateStr(cursor),
        startMs: cursor,
        endMs: stop,
        durationMs: Math.max(0, stop - cursor),
        pauseMs: pieces.length === 0 ? pauseMs : 0,
        title,
        note
      });
      cursor = stop;
    }
    return pieces;
  }

  /** 拉取专注 → 只读镜像 → 通知界面刷新 */
  async pull({ manual = false } = {}) {
    if (this.busy.pull) return { ok: false, skipped: true, reason: '正在同步中' };
    const cfg = this.cfg();
    if (!cfg.enabled || !cfg.pullFocus) {
      return { ok: false, skipped: true, reason: '滴答同步或拉取专注未开启' };
    }
    if (!cfg.token) {
      return { ok: false, error: '请先填写滴答 API 口令' };
    }

    this.busy.pull = true;
    this.broadcast('dida-status', this.status());
    try {
      const days = clampInt(cfg.syncDays, 1, 365, 30);
      const toMs = Date.now();
      const fromMs = toMs - days * 86400000;
      const rows = [];
      for (let cursor = fromMs; cursor < toMs; cursor += PAGE_DAYS * 86400000) {
        const stop = Math.min(cursor + PAGE_DAYS * 86400000, toMs);
        for (const type of [0, 1]) {
          const part = await this.fetchWindow(cfg.token, cursor, stop, type);
          rows.push(...part);
        }
      }

      const seen = new Set();
      const byDay = new Map();
      for (const row of rows) {
        const key = `${row.id}:${row.etag || ''}:${row.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const item of this.normalize(row)) {
          if (!byDay.has(item.date)) byDay.set(item.date, []);
          byDay.get(item.date).push(item);
        }
      }

      const d = this.dirs();
      fs.mkdirSync(d.focus, { recursive: true });
      let added = 0;
      let total = 0;
      for (const [date, incoming] of byDay) {
        const file = path.join(d.focus, `${date}.json`);
        const existing = readJson(file, []);
        const map = new Map();
        for (const r of (Array.isArray(existing) ? existing : [])) {
          if (r && r.id) map.set(`${r.id}:${r.etag || ''}`, r);
        }
        for (const r of incoming) {
          const key = `${r.id}:${r.etag || ''}`;
          if (!map.has(key)) added += 1;
          map.set(key, r);
        }
        const merged = [...map.values()].sort((a, b) => a.startMs - b.startMs);
        writeJson(file, merged);
        total += merged.length;
      }

      const s = this.status();
      s.lastPullAt = new Date().toISOString();
      s.lastPullCount = added;
      s.pulledTotal += added;
      s.todayPulled += added;
      s.lastError = '';
      this.writeStatus(s);

      // 镜像变了，展示层要重算（专注是第二层级）
      this.broadcast('data-changed', { reason: 'dida-pull' });
      return { ok: true, count: rows.length, added, mirrored: total, manual };
    } catch (e) {
      const s = this.status();
      s.lastError = `拉取失败：${e.response?.status || ''} ${e.message || e}`.trim();
      this.writeStatus(s);
      return { ok: false, error: s.lastError };
    } finally {
      this.busy.pull = false;
      this.broadcast('dida-status', this.status());
    }
  }

  /** 推送展示层标注到滴答。默认关闭；三重保护缺一不发请求。 */
  async push({ manual = false } = {}) {
    if (this.busy.push) return { ok: false, skipped: true, reason: '正在推送中' };
    const cfg = this.cfg();
    if (!cfg.enabled || !cfg.pushEnabled) {
      return { ok: false, skipped: true, reason: '推送展示层未开启' };
    }
    if (!cfg.pushProjectId) {
      return { ok: false, skipped: true, reason: '未指定目标清单 ID' };
    }
    if (!cfg.token) return { ok: false, error: '请先填写滴答 API 口令' };
    if (!this.buildDayReport) {
      return { ok: false, error: '展示层读取器未就绪' };
    }

    this.busy.push = true;
    this.broadcast('dida-status', this.status());
    try {
      const d = this.dirs();
      const pushed = readPushRecords(readJson(d.pushed, {}));
      const days = clampInt(cfg.syncDays, 1, 30, 7);

      // 1) 先把这些天所有「该推的标注」收齐，不管推没推过。
      //    对账需要完整集合：只有知道现在这段时间归谁，才能判断旧任务是否过时。
      const live = [];
      for (let i = 0; i < days; i += 1) {
        const date = localDateStr(Date.now() - i * 86400000);
        let report = null;
        try {
          report = this.buildDayReport(this.getDataDir(), date, {});
        } catch (_) { continue; }
        for (const s of (report && report.sessions) || []) {
          // 只推展示层里人工声明过的段，绝不推记录层的原始采样
          if (!s.manual && !s.isManual && s.layer !== 'display') continue;
          const start = parseDidaTime(s.startTime || s.start);
          let end = parseDidaTime(s.endTime || s.end);
          if (!Number.isFinite(start)) continue;
          if (!Number.isFinite(end) || end <= start) {
            end = start + (Number(s.durationMs) || 900000);
          }
          live.push({ date, start, end, session: s });
        }
      }

      // 2) 对账：找出已被取代的旧推送，删掉滴答任务并清出记录。
      //    判据是「当前标注里没有一条与它时间范围一致」——合并、拆分、改时间、删除都归此列。
      let removed = 0;
      let unremovable = 0;
      for (const [key, rec] of Object.entries(pushed)) {
        if (rec.start === null || rec.end === null) {
          // v1 老记录：没有区间也没 id，既判断不了过时也删不掉，原样留着避免重复推送
          continue;
        }
        const stillLive = live.some(x => hasSameRange(rec, x));
        if (stillLive) continue;
        if (!rec.id) { unremovable += 1; delete pushed[key]; continue; }
        if (removed >= PUSH_DELETE_LIMIT) continue;
        try {
          await axios.delete(
            `${API_BASE}/project/${encodeURIComponent(cfg.pushProjectId)}/task/${encodeURIComponent(rec.id)}`,
            { headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 15000, proxy: false }
          );
          delete pushed[key];
          removed += 1;
        } catch (e) {
          // 删不掉就留着，下一轮再试；不要因为一条删失败中断整轮
          const st0 = this.status();
          st0.lastError = `清理旧任务失败（${rec.id}）：${e.response?.status || ''} ${e.message || e}`.trim();
          this.writeStatus(st0);
        }
      }
      writeJson(d.pushed, pushed);

      // 3) 再决定推哪些：当前标注里，凡是还没有「同区间」记录的就是新任务
      const candidates = [];
      for (const item of live) {
        if (liveHasRecord(pushed, item)) continue;
        candidates.push(item);
        if (candidates.length >= PUSH_LIMIT) break;
      }

      if (!candidates.length && !removed) {
        return { ok: true, count: 0, removed: 0, skipped: true, reason: '没有需要推送的新标注' };
      }

      let sent = 0;
      const analysis = this.getConfig().analysis || {};
      const categoryNames = Object.fromEntries([
        ...Object.entries(analysis.categoryMeta || {}).map(([key, meta]) => [key, meta.name || key]),
        ...(analysis.customCategories || []).map(c => [c.key || c.name, c.name])
      ]);
      for (const c of candidates) {
        const s = c.session;
        const startMs = c.start;
        const durMs = Number(s.durationMs) || (Number.isFinite(c.end) ? c.end - startMs : 900000);
        const taskText = formatRecordTask(s, categoryNames);
        const body = {
          projectId: cfg.pushProjectId,
          title: taskText.title,
          content: [taskText.overflow, `来自 LifeLog · ${Math.round(durMs / 60000)} 分钟`].filter(Boolean).join('\n\n'),
          startDate: didaUtc(startMs),
          dueDate: didaUtc(startMs + Math.max(15 * 60000, durMs)),
          timeZone: 'Asia/Shanghai',
          tags: ['LifeLog'],
          isAllDay: false
        };
        const res = await axios.post(`${API_BASE}/task`, body, {
          headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
          timeout: 15000,
          proxy: false
        });
        // 这些都是「已经发生完的事」，推进去就该是已完成状态。
        // 滴答的创建接口只建任务，完成要走单独端点，所以补一刀。
        // 拿不到 id 也不影响已创建的事实：先记账，别把整轮推送打断。
        const taskId = res && res.data && (res.data.id || (res.data.task && res.data.task.id));
        if (taskId) {
          try {
            await axios.post(`${API_BASE}/project/${encodeURIComponent(cfg.pushProjectId)}/task/${encodeURIComponent(taskId)}/complete`,
              {}, { headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 15000, proxy: false });
          } catch (e) {
            // 完成失败就记在状态里，任务本身已经建好，重试会造成重复
            const st0 = this.status();
            st0.lastError = `任务已创建但标记完成失败：${e.response?.status || ''} ${e.message || e}`.trim();
            this.writeStatus(st0);
          }
        }
        // 记下 id 和区间：下次合并时要靠这两个字段把这条删掉
        pushed[pushKey(c.date, c.start)] = {
          id: taskId || '',
          at: new Date().toISOString(),
          start: c.start,
          end: c.end,
          date: c.date
        };
        writeJson(d.pushed, pushed);
        sent += 1;
      }

      const st = this.status();
      st.lastPushAt = new Date().toISOString();
      st.lastPushCount = sent;
      st.lastRemovedCount = removed;
      // 每轮都重写，避免上一轮的提示一直挂着
      st.lastPushNote = unremovable ? `${unremovable} 条早期推送缺少任务 id，无法自动清理` : '';
      st.pushedTotal += sent;
      st.todayPushed += sent;
      st.lastError = '';
      this.writeStatus(st);
      return { ok: true, count: sent, removed, manual };
    } catch (e) {
      const s = this.status();
      s.lastError = `推送失败：${e.response?.status || ''} ${e.message || e}`.trim();
      this.writeStatus(s);
      return { ok: false, error: s.lastError };
    } finally {
      this.busy.push = false;
      this.broadcast('dida-status', this.status());
    }
  }

  /** 定时调度：60 秒检查一次，两个方向各自按自己的间隔判断 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 60000);
    const cfg = this.cfg();
    if (cfg.enabled && cfg.autoSyncOnStart && cfg.token) {
      setTimeout(() => {
        const jobs = [];
        if (cfg.pullFocus) jobs.push(this.pull({ manual: false }));
        if (cfg.pullPlans !== false) jobs.push(this.pullPlans({ manual: false }));
        Promise.all(jobs).catch(() => {});
      }, 8000);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const cfg = this.cfg();
    if (!cfg.enabled || !cfg.token) return;
    const s = this.readStatus();
    const due = (at, min) => {
      const interval = clampInt(min, 1, 1440, 30) * 60000;
      return !at || (Date.now() - new Date(at).getTime() >= interval);
    };
    const jobs = [];
    if (cfg.pullFocus && due(s.lastPullAt, cfg.pullIntervalMin)) jobs.push(this.pull());
    if (cfg.pullPlans !== false && due(s.lastPlanPullAt, cfg.pullIntervalMin)) jobs.push(this.pullPlans());
    if (cfg.pushEnabled && cfg.pushProjectId && due(s.lastPushAt, cfg.pushIntervalMin)) jobs.push(this.push());
    await Promise.all(jobs);
  }
}

module.exports = {
  DidaSync, localDateStr, parseDidaTime, formatRecordTask, hasSameRange,
  readPushRecords, liveHasRecord, pushKey, planCategory, planLabel, matchesPlanDate
};
