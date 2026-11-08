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
const crypto = require('crypto');
const axios = require('axios');

const API_BASE = 'https://api.dida365.com/open/v1';
const PAGE_DAYS = 30;          // 官方单次最多 30 天
const PUSH_LIMIT = 20;         // 单次最多推送 20 条，防止刷屏

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
    this.busy = { pull: false, push: false };
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
      status: path.join(root, 'sync-status.json'),
      pushed: path.join(root, 'pushed.json')
    };
  }

  readStatus() {
    const d = this.dirs();
    const s = readJson(d.status, {});
    return {
      lastPullAt: s.lastPullAt || '',
      lastPushAt: s.lastPushAt || '',
      pulledTotal: Number(s.pulledTotal) || 0,
      pushedTotal: Number(s.pushedTotal) || 0,
      todayDate: s.todayDate || '',
      todayPulled: Number(s.todayPulled) || 0,
      todayPushed: Number(s.todayPushed) || 0,
      lastPullCount: Number(s.lastPullCount) || 0,
      lastPushCount: Number(s.lastPushCount) || 0,
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
    return {
      ...s, today, mirrorRecords, mirrorDays,
      todayFocusCount, todayFocusMinutes,
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
      const pushed = readJson(d.pushed, {});
      const days = clampInt(cfg.syncDays, 1, 30, 7);
      const candidates = [];
      for (let i = 0; i < days; i += 1) {
        const date = localDateStr(Date.now() - i * 86400000);
        let report = null;
        try {
          report = this.buildDayReport(this.getDataDir(), date, {});
        } catch (_) { continue; }
        const sessions = (report && report.sessions) || [];
        for (const s of sessions) {
          // 只推展示层里人工声明过的段，绝不推记录层的原始采样
          if (!s.manual && !s.isManual && s.layer !== 'display') continue;
          const start = parseDidaTime(s.startTime || s.start);
          const end = parseDidaTime(s.endTime || s.end);
          if (!Number.isFinite(start)) continue;
          const legacyKey = `${date}:${Math.round(start / 60000)}:${String(s.app || s.title || '').slice(0, 40)}`;
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify([s.category, s.app, s.titles, s.durationMs])).digest('hex').slice(0, 16);
          const key = `${date}:${Math.round(start / 60000)}:${fingerprint}`;
          if (pushed[key] || pushed[legacyKey]) continue;
          candidates.push({ key, date, start, end, session: s });
          if (candidates.length >= PUSH_LIMIT) break;
        }
        if (candidates.length >= PUSH_LIMIT) break;
      }

      if (!candidates.length) {
        return { ok: true, count: 0, skipped: true, reason: '没有需要推送的新标注' };
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
        pushed[c.key] = new Date().toISOString();
        writeJson(d.pushed, pushed);
        sent += 1;
      }

      const st = this.status();
      st.lastPushAt = new Date().toISOString();
      st.lastPushCount = sent;
      st.pushedTotal += sent;
      st.todayPushed += sent;
      st.lastError = '';
      this.writeStatus(st);
      return { ok: true, count: sent, manual };
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
    if (cfg.enabled && cfg.autoSyncOnStart && cfg.pullFocus && cfg.token) {
      setTimeout(() => { this.pull({ manual: false }).catch(() => {}); }, 8000);
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
    if (cfg.pushEnabled && cfg.pushProjectId && due(s.lastPushAt, cfg.pushIntervalMin)) jobs.push(this.push());
    await Promise.all(jobs);
  }
}

module.exports = { DidaSync, localDateStr, parseDidaTime, formatRecordTask };
