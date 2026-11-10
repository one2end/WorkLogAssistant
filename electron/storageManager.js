const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { copyMissingData } = require('./fileMigration');
const { writeFileAtomic } = require('./atomicFile');
const { splitRecordAtMidnight } = require('./timeSplit');

class StorageManager {
  constructor(customBasePath) {
    const userDataPath = app.getPath('userData');
    this._defaultDataDir = path.join(userDataPath, 'Data');

    // Use custom path if provided and accessible, otherwise default
    if (customBasePath && customBasePath.trim()) {
      try {
        if (!fs.existsSync(customBasePath)) {
          fs.mkdirSync(customBasePath, { recursive: true });
        }
        // Test write access
        const testFile = path.join(customBasePath, '.write_test');
        fs.writeFileSync(testFile, 'test', 'utf8');
        fs.unlinkSync(testFile);
        this.dataDir = customBasePath;
      } catch (error) {
        console.error('自定义存储路径不可用，使用默认路径:', error.message);
        this.dataDir = this._defaultDataDir;
      }
    } else {
      this.dataDir = this._defaultDataDir;
    }

    this.activitiesDir = path.join(this.dataDir, 'activities');
    this.summariesDir = path.join(this.dataDir, 'summaries');
    this.screenshotsDir = path.join(this.dataDir, 'screenshots');
    // Legacy single-file paths (for migration)
    this._legacyActivitiesFile = path.join(this._defaultDataDir, 'activities.json');
    this._legacySummariesFile = path.join(this._defaultDataDir, 'summaries.json');
    this.ensureDataDir();
    this._migrateIfNeeded();
  }

  /**
   * 运行时切换数据根目录（供设置页改存储路径后立即生效，无需重启）。
   * 直接在当前实例上改路径，这样 ActivityRecorder / ApiServer 等已持有
   * 本实例引用的地方会自动指向新目录。
   */
  setDataDir(newPath) {
    const target = newPath && newPath.trim() ? newPath.trim() : this._defaultDataDir;

    if (target !== this._defaultDataDir) {
      try {
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        const testFile = path.join(target, '.write_test');
        fs.writeFileSync(testFile, 'test', 'utf8');
        fs.unlinkSync(testFile);
      } catch (error) {
        console.error('自定义存储路径不可用，保持原路径:', error.message);
        return { success: false, error: error.message };
      }
    }

    this.dataDir = target;
    this.activitiesDir = path.join(target, 'activities');
    this.summariesDir = path.join(target, 'summaries');
    this.screenshotsDir = path.join(target, 'screenshots');
    this.ensureDataDir();
    return { success: true, dataDir: target };
  }

  // --- Helpers ---

  _toDateStr(timestamp) {
    const d = new Date(timestamp);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  _todayStr() {
    return this._toDateStr(new Date());
  }

  _activityFile(dateStr) {
    return path.join(this.activitiesDir, `${dateStr}.json`);
  }

  _activityJsonlFile(dateStr) {
    return path.join(this.activitiesDir, `${dateStr}.jsonl`);
  }

  _summaryFile(dateStr) {
    return path.join(this.summariesDir, `${dateStr}.json`);
  }

  _readJsonlFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      const out = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed));
        } catch (e) {
          // 单行损坏不影响整份文件
        }
      }
      return out;
    } catch (error) {
      console.error(`读取 JSONL 失败 ${filePath}:`, error);
      return [];
    }
  }

  /** 把录制器写下的片段转换成前端/统计一直使用的活动结构 */
  _fromSegment(rec, index) {
    return {
      id: `${rec.t}#${index}`,
      timestamp: rec.t,
      processName: rec.app || 'unknown',
      windowTitle: rec.title || '',
      platform: rec.platform || 'windows',
      durationMs: typeof rec.dur === 'number' ? rec.dur : 0,
      kind: rec.kind === 'idle' ? 'idle' : 'active',
      // 三层来源：manual=本人补记，imported=别的软件导入的标注，auto=本机录制
      source: rec.source === 'manual' ? 'manual'
        : (rec.source === 'dida' || rec.source === 'uptimer') ? 'imported'
        : 'auto',
      // src='appcat'：由「当天同应用全部同步」生成的覆盖标注
      src: rec.src || undefined,
      category: rec.cat || undefined
    };
  }

  /**
   * 读某天全部活动：旧版 JSON + 新版 JSONL，按时间排序。
   *
   * 还要合并 iCloud 冲突副本：数据目录放在 iCloud / OneDrive 时，
   * 同步进程发现同名文件被别处改过，会生成 "2026-11-08 2.jsonl" 这样的副本。
   * 主文件虽然能读到，但副本里的记录会被漏掉——表现为「那段时间凭空消失了」。
   * 所以这里把同名前缀的文件一起读进来。
   */
  _readActivityFile(dateStr) {
    const items = [];

    const legacy = this._readJsonFile(this._activityFile(dateStr));
    if (Array.isArray(legacy)) items.push(...legacy);

    let index = 0;
    for (const file of this._activityFilesOfDay(dateStr)) {
      const segments = this._readJsonlFile(file);
      segments.forEach((rec) => {
        if (rec && rec.t) items.push(this._fromSegment(rec, index++));
      });
    }

    items.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return items;
  }

  /**
   * 某一天的所有活动文件：主文件 + iCloud 冲突副本。
   * 副本命名形如 "2026-11-08 2.jsonl"（数字后缀），也可能是 "2026-11-08 (1).jsonl"。
   */
  _activityFilesOfDay(dateStr) {
    const main = this._activityJsonlFile(dateStr);
    const files = [main];
    try {
      const dir = path.dirname(main);
      if (!fs.existsSync(dir)) return files;
      const base = path.basename(main);
      for (const name of fs.readdirSync(dir)) {
        if (name === base) continue;
        if (!name.startsWith(dateStr)) continue;
        if (!name.endsWith('.jsonl')) continue;
        files.push(path.join(dir, name));
      }
    } catch (_) { /* 目录读不到就只用主文件 */ }
    return files;
  }

  _readJsonFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      console.error(`读取文件失败 ${filePath}:`, error);
    }
    return [];
  }

  _writeJsonFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeFileAtomic(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      console.error(`写入文件失败 ${filePath}:`, error);
      return false;
    }
  }

  // --- Init & Migration ---

  ensureDataDir() {
    [this.dataDir, this.activitiesDir, this.summariesDir, this.screenshotsDir]
      .forEach(dir => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });
  }

  _migrateIfNeeded() {
    // Migrate legacy activities.json → per-day files
    if (fs.existsSync(this._legacyActivitiesFile)) {
      try {
        const all = JSON.parse(fs.readFileSync(this._legacyActivitiesFile, 'utf8'));
        if (Array.isArray(all) && all.length > 0) {
          const grouped = {};
          all.forEach(a => {
            const dateStr = this._toDateStr(a.timestamp);
            if (!grouped[dateStr]) grouped[dateStr] = [];
            grouped[dateStr].push(a);
          });
          for (const [dateStr, items] of Object.entries(grouped)) {
            const filePath = this._activityFile(dateStr);
            const existing = this._readJsonFile(filePath);
            this._writeJsonFile(filePath, existing.concat(items));
          }
          console.log(`已迁移 ${all.length} 条活动记录到按天存储`);
        }
        // Rename legacy file as backup
        fs.renameSync(this._legacyActivitiesFile,
          this._legacyActivitiesFile + '.migrated');
      } catch (error) {
        console.error('迁移活动数据失败:', error);
      }
    }

    // Migrate legacy summaries.json → per-day files
    if (fs.existsSync(this._legacySummariesFile)) {
      try {
        const all = JSON.parse(fs.readFileSync(this._legacySummariesFile, 'utf8'));
        if (Array.isArray(all) && all.length > 0) {
          const grouped = {};
          all.forEach(s => {
            const dateStr = this._toDateStr(s.timestamp);
            if (!grouped[dateStr]) grouped[dateStr] = [];
            grouped[dateStr].push(s);
          });
          for (const [dateStr, items] of Object.entries(grouped)) {
            const filePath = this._summaryFile(dateStr);
            const existing = this._readJsonFile(filePath);
            this._writeJsonFile(filePath, existing.concat(items));
          }
          console.log(`已迁移 ${all.length} 条摘要记录到按天存储`);
        }
        fs.renameSync(this._legacySummariesFile,
          this._legacySummariesFile + '.migrated');
      } catch (error) {
        console.error('迁移摘要数据失败:', error);
      }
    }
  }

  // --- Data Dir ---

  getDataDir() {
    return this.dataDir;
  }

  // --- Activities ---

  saveActivity(activity) {
    try {
      const dateStr = this._toDateStr(activity.timestamp);
      const filePath = this._activityFile(dateStr);
      const activities = this._readJsonFile(filePath);
      activities.push(activity);
      return this._writeJsonFile(filePath, activities);
    } catch (error) {
      console.error('保存活动失败:', error);
      return false;
    }
  }

  /**
   * 追加写入录制片段（JSONL，一行一条）。
   * 相比旧版「读整个文件 → 解析 → push → 全量重写」，追加写是 O(1)，
   * 不会随当天记录变多而变慢。
   */
  appendActivityRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return false;

    const byDate = new Map();
    for (const rec of records) {
      if (!rec || !rec.t) continue;
      const dateStr = this._toDateStr(rec.t);
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr).push(rec);
    }

    let ok = true;
    for (const [dateStr, list] of byDate.entries()) {
      try {
        const filePath = this._activityJsonlFile(dateStr);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const payload = list
          .map(r => JSON.stringify({
            t: r.t,
            dur: r.dur,
            kind: r.kind || 'active',
            app: r.app,
            title: r.title || '',
            platform: r.platform || 'windows',
            ...(r.source === 'manual' ? { source: 'manual' } : {}),
            // src 用于区分标注来源：'appcat' = 「当天同应用全部同步」生成的覆盖标注，
            // 下次同步时会被替换掉，不会越叠越多。
            ...(r.src ? { src: r.src } : {}),
            ...(r.cat ? { cat: r.cat } : {}),
            // 计划转事实会带 planKey / origin / project，以前在这里被整段丢弃，
            // 生成的事实既看不出来自哪条计划，也丢了计划上的项目标签。
            ...(r.project ? { project: r.project } : {}),
            ...(r.origin ? { origin: r.origin } : {}),
            ...(r.planKey ? { planKey: r.planKey } : {}),
            ...(r.groupId ? { groupId: r.groupId } : {})
          }))
          .join('\n') + '\n';
        fs.appendFileSync(filePath, payload, 'utf8');
      } catch (error) {
        console.error(`追加活动记录失败 ${dateStr}:`, error);
        ok = false;
      }
    }
    return ok;
  }

  getActivities(date) {
    if (!date) {
      return this._getAllFromDir(this.activitiesDir);
    }
    const dateStr = this._toDateStr(date);
    return this._readActivityFile(dateStr);
  }

  getAllActivities() {
    return this._getAllActivities();
  }

  getActivitiesByDateRange(startDate, endDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const results = [];
    for (const dateStr of this._activityDatesInRange(start, end)) {
      this._readActivityFile(dateStr).forEach(a => {
        const t = new Date(a.timestamp);
        if (t >= start && t <= end) results.push(a);
      });
    }
    return results;
  }

  getActivitiesByTimeRange(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);

    const results = [];
    for (const dateStr of this._activityDatesInRange(start, end)) {
      this._readActivityFile(dateStr).forEach(a => {
        const t = new Date(a.timestamp);
        if (t >= start && t <= end) results.push(a);
      });
    }
    return results;
  }

  deleteActivity(activityId) {
    try {
      // 旧版 JSON 文件里可能存有该 id
      for (const file of this._listJsonFiles(this.activitiesDir)) {
        const filePath = path.join(this.activitiesDir, file);
        const items = this._readJsonFile(filePath);
        const filtered = items.filter(a => a.id !== activityId);
        if (filtered.length !== items.length) {
          this._writeJsonFile(filePath, filtered);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('删除活动失败:', error);
      return false;
    }
  }

  /**
   * 记录层 / 展示层判定。
   *
   * 记录层：本机自动录制的原始采样（source 为空或 recorded）。它是事实，
   *         只能读、不能改——改了就等于篡改历史。
   * 展示层：人工补记（manual）、别的软件导入的标注（dida / uptimer）。
   *         它们是「人的表述」，会写错、会重复，必须可改可删。
   */
  static layerOf(rec) {
    const src = rec && rec.source;
    return (!src || src === 'recorded') ? 'record' : 'display';
  }

  /** 修改一条展示层记录（标题 / 分类 / 应用名）。记录层一律拒绝。 */
  updateDisplayRecord(dateStr, matchT, patch = {}) {
    const file = this._activityJsonlFile(dateStr);
    if (!fs.existsSync(file)) return { success: false, error: '没有这一天的数据' };

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let hit = null;
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { out.push(line); continue; }
      if (!hit && rec.t === matchT) {
        if (StorageManager.layerOf(rec) === 'record') {
          return { success: false, error: '记录层数据不可修改' };
        }
        hit = rec;
        const next = { ...rec };
        if (typeof patch.title === 'string') next.title = patch.title;
        if (typeof patch.cat === 'string') next.cat = patch.cat;
        if (typeof patch.app === 'string') next.app = patch.app;
        next.editedAt = new Date().toISOString();
        out.push(JSON.stringify(next));
        continue;
      }
      out.push(line);
    }
    if (!hit) return { success: false, error: '没找到这条记录' };
    writeFileAtomic(file, out.join('\n') + '\n');
    return { success: true };
  }

  /**
   * 删除某段时间内的所有「标注层」记录（含跨天拆出来的多段）。
   * 记录层的采样一律保留——删除标注只是把这段还给原始数据。
   */
  deleteDisplayRange(dateStr, startIso, endIso) {
    const file = this._activityJsonlFile(dateStr);
    if (!fs.existsSync(file)) return { success: false, error: '没有这一天的数据', removed: 0 };
    const from = new Date(startIso).getTime();
    const to = new Date(endIso).getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
      return { success: false, error: '时间区间无效', removed: 0 };
    }

    const out = [];
    let removed = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { out.push(line); continue; }
      const s0 = new Date(rec.t).getTime();
      const e0 = s0 + (rec.dur || 0);
      const overlap = s0 < to && e0 > from;
      if (overlap && StorageManager.layerOf(rec) === 'display') { removed += 1; continue; }
      out.push(line);
    }
    if (!removed) return { success: false, error: '这一段来自记录层，不能删除（可以编辑覆盖它）', removed: 0 };
    writeFileAtomic(file, out.length ? out.join('\n') + '\n' : '');
    return { success: true, removed };
  }

  /** 一次提交「删旧标注 + 写新标注」，失败时原文件保持不变。 */
  replaceDisplayRanges(dateStr, ranges, record) {
    const cuts = (ranges || []).map(r => [new Date(r.start).getTime(), new Date(r.end).getTime()]);
    if (cuts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || b <= a)) {
      return { success: false, error: '时间区间无效' };
    }
    try {
      const sourceFile = this._activityJsonlFile(dateStr);
      const sourceLines = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8').split('\n') : [];
      const oldGroups = new Set();
      for (const line of sourceLines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        const start = new Date(rec.t).getTime();
        // 次日 00:00 的续段单独编辑时，保留前一天已经记录的部分。
        const localStart = new Date(rec.t);
        const isContinuation = localStart.getHours() === 0 && localStart.getMinutes() === 0;
        if (StorageManager.layerOf(rec) === 'display' && rec.groupId && !isContinuation &&
            cuts.some(([a, b]) => start < b && start + (rec.dur || 0) > a)) oldGroups.add(rec.groupId);
      }
      const newParts = splitRecordAtMidnight(record);
      const next = new Date(`${dateStr}T00:00:00`); next.setDate(next.getDate() + 1);
      const previous = new Date(`${dateStr}T00:00:00`); previous.setDate(previous.getDate() - 1);
      const previousDate = this._toDateStr(previous);
      const midnight = new Date(`${dateStr}T00:00:00`).getTime();
      const legacySpill = new Set();
      const previousFile = this._activityJsonlFile(previousDate);
      if (fs.existsSync(previousFile)) {
        for (const line of fs.readFileSync(previousFile, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (_) { continue; }
          const start = new Date(rec.t).getTime();
          const end = start + (rec.dur || 0);
          if (StorageManager.layerOf(rec) === 'display' && !rec.groupId && start < midnight && end > midnight &&
              cuts.some(([a, b]) => midnight < b && end > a)) legacySpill.add(line);
        }
      }
      const dates = new Set([dateStr, ...newParts.map(part => this._toDateStr(part.t))]);
      if (legacySpill.size) dates.add(previousDate);
      if (oldGroups.size) {
        dates.add(this._toDateStr(next));
        dates.add(this._toDateStr(previous));
      }
      const pending = [];
      for (const day of dates) {
        const file = this._activityJsonlFile(day);
        const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
        const out = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          if (day === previousDate && legacySpill.has(line)) {
            const original = JSON.parse(line);
            original.dur = midnight - new Date(original.t).getTime();
            out.push(JSON.stringify(original));
            continue;
          }
          let rec;
          try { rec = JSON.parse(line); } catch (_) { out.push(line); continue; }
          const start = new Date(rec.t).getTime();
          const end = start + (rec.dur || 0);
          if (StorageManager.layerOf(rec) === 'display' &&
              (oldGroups.has(rec.groupId) || (day === dateStr && cuts.some(([a, b]) => start < b && end > a)))) continue;
          out.push(line);
        }
        for (const part of newParts) if (this._toDateStr(part.t) === day) out.push(JSON.stringify(part));
        pending.push({ file, out });
      }
      for (const { file, out } of pending) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, out.join('\n') + '\n');
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 把某一天里某个应用的所有时段改成同一分类。
   *
   * 记录层（自动采样）不可改，所以走「展示层覆盖」的思路：
   *   · 用户自己为该应用写过的标注 → 就地改分类，保留原备注与时间
   *   · 上一次同步生成的覆盖标注（src='appcat'）→ 先删掉，避免叠加
   *   · 自动录制占用的时段 → 写一条新的覆盖标注（优先级最高，自动生效）
   *   · 其它应用的标注 → 一律不动
   *
   * @param {string} dateStr  YYYY-MM-DD
   * @param {string} app      应用名
   * @param {string} category 新分类
   * @param {Array}  spans    该应用当天占用的时段 [{startMin, durationMin}]
   * @param {string} note     备注（写进覆盖标注）
   */
  recategorizeAppForDay(dateStr, app, category, spans, note) {
    const file = this._activityJsonlFile(dateStr);
    const target = String(app || '').trim().toLowerCase();
    if (!target) return { success: false, error: '缺少应用名' };

    const isTarget = (rec) => {
      const name = String(rec.app || '').trim().toLowerCase();
      return name === target || (name && target && name.includes(target));
    };

    try {
      const out = [];
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
      let updated = 0;
      let removedOverlay = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { out.push(line); continue; }
        if (StorageManager.layerOf(rec) === 'display' && isTarget(rec)) {
          if (rec.src === 'appcat') { removedOverlay += 1; continue; }  // 旧覆盖标注，删掉重写
          // 用户自己写的标注：只改分类，其余保留
          rec.cat = category;
          updated += 1;
          out.push(JSON.stringify(rec));
          continue;
        }
        out.push(line);
      }

      // 为自动录制占用的时段写覆盖标注
      const pad = (n) => String(n).padStart(2, '0');
      let added = 0;
      for (const span of (spans || [])) {
        const startMin = Math.max(0, Math.min(1440 - 15, Math.floor((Number(span.startMin) || 0) / 15) * 15));
        const durMin = Math.max(15, Math.round((Number(span.durationMin) || 15) / 15) * 15);
        const start = new Date(`${dateStr}T00:00:00`);
        start.setMinutes(startMin);
        const end = new Date(start.getTime() + durMin * 60000);
        out.push(JSON.stringify({
          t: start.toISOString(),
          dur: durMin * 60000,
          kind: 'active',
          app: String(app),
          title: note || '',
          platform: 'windows',
          source: 'manual',
          src: 'appcat',
          cat: category
        }));
        added += 1;
      }

      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, out.join('\n') + '\n');
      return { success: true, updated, removedOverlay, added };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /** 删除一条展示层记录。记录层一律拒绝（要删只能删整天，那是另一套语义）。 */
  deleteDisplayRecord(dateStr, matchT) {
    const file = this._activityJsonlFile(dateStr);
    if (!fs.existsSync(file)) return { success: false, error: '没有这一天的数据' };

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let removed = null;
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { out.push(line); continue; }
      if (!removed && rec.t === matchT) {
        if (StorageManager.layerOf(rec) === 'record') {
          return { success: false, error: '记录层数据不可删除' };
        }
        removed = rec;
        continue;
      }
      out.push(line);
    }
    if (!removed) return { success: false, error: '没找到这条记录' };
    writeFileAtomic(file, out.length ? out.join('\n') + '\n' : '');
    return { success: true };
  }

  clearActivities() {
    try {
      const removed = new Set();
      for (const dir of [this.activitiesDir]) {
        if (!fs.existsSync(dir)) continue;
        fs.readdirSync(dir)
          .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
          .forEach(f => removed.add(path.join(dir, f)));
      }
      removed.forEach(p => fs.unlinkSync(p));
      return true;
    } catch (error) {
      console.error('清空活动失败:', error);
      return false;
    }
  }

  // --- Summaries ---

  saveSummary(summary) {
    try {
      const dateStr = summary.date || this._toDateStr(summary.timestamp);
      const filePath = this._summaryFile(dateStr);
      const summaries = this._readJsonFile(filePath);
      summaries.push(summary);
      this._writeJsonFile(filePath, summaries);

      // Also write markdown file
      const mdDir = path.join(this.dataDir, 'summaries_md');
      if (!fs.existsSync(mdDir)) {
        fs.mkdirSync(mdDir, { recursive: true });
      }
      const mdFilename = `summary_${new Date(summary.timestamp).toISOString().replace(/[:.]/g, '-')}.md`;
      const mdPath = path.join(mdDir, mdFilename);
      fs.writeFileSync(mdPath, this.generateMarkdownSummary(summary), 'utf8');

      return true;
    } catch (error) {
      console.error('保存摘要失败:', error);
      return false;
    }
  }
  generateMarkdownSummary(summary) {
    let content = `# 工作日志摘要\n\n`;
    content += `**时间**: ${new Date(summary.timestamp).toLocaleString('zh-CN')}\n\n`;
    content += `**活动数量**: ${summary.activityCount}\n\n`;
    content += `---\n\n`;
    content += `## 摘要内容\n\n`;
    content += `${summary.summary}\n\n`;
    content += `---\n\n`;
    content += `## 活动详情\n\n`;
    if (summary.activities) {
      summary.activities.forEach(activity => {
        content += `- [${new Date(activity.timestamp).toLocaleTimeString('zh-CN')}] `;
        content += `${activity.processName} - ${activity.windowTitle}\n`;
      });
    }
    return content;
  }

  getAllSummaries() {
    return this._getAllFromDir(this.summariesDir);
  }

  getSummaries(date) {
    if (!date) {
      return this._getAllFromDir(this.summariesDir);
    }
    const dateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date : this._toDateStr(date);
    return this._readJsonFile(this._summaryFile(dateStr));
  }

  getTodaySummaries() {
    return this.getSummaries(new Date());
  }

  deleteSummary(summaryId) {
    try {
      const files = this._listJsonFiles(this.summariesDir);
      for (const file of files) {
        const filePath = path.join(this.summariesDir, file);
        const items = this._readJsonFile(filePath);
        const filtered = items.filter(s => s.id !== summaryId);
        if (filtered.length !== items.length) {
          this._writeJsonFile(filePath, filtered);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('删除摘要失败:', error);
      return false;
    }
  }

  // --- Screenshots ---

  saveScreenshot(activityId, screenshot) {
    try {
      // Search today's file first, then all files
      const todayFile = this._activityFile(this._todayStr());
      const activities = this._readJsonFile(todayFile);
      const activity = activities.find(a => a.id === activityId);
      if (activity) {
        activity.screenshot = screenshot;
        this._writeJsonFile(todayFile, activities);
        return true;
      }
      return false;
    } catch (error) {
      console.error('保存截图信息失败:', error);
      return false;
    }
  }

  getScreenshotPath(filename) {
    return path.join(this.screenshotsDir, filename);
  }

  // --- Statistics ---

  getStatistics(date) {
    const activities = this.getActivities(date);
    if (activities.length === 0) {
      return {
        totalActivities: 0,
        uniqueApplications: 0,
        mostUsedApplication: null,
        activityTimeline: []
      };
    }

    const appUsage = {};
    activities.forEach(a => {
      appUsage[a.processName] = (appUsage[a.processName] || 0) + 1;
    });

    const uniqueApplications = Object.keys(appUsage).length;
    const mostUsedApplication = Object.entries(appUsage)
      .sort((a, b) => b[1] - a[1])[0];

    const activityTimeline = activities.map(a => ({
      time: new Date(a.timestamp).toLocaleTimeString('zh-CN'),
      application: a.processName,
      window: a.windowTitle
    }));

    return {
      totalActivities: activities.length,
      uniqueApplications,
      mostUsedApplication: mostUsedApplication
        ? { name: mostUsedApplication[0], count: mostUsedApplication[1] }
        : null,
      activityTimeline
    };
  }

  // --- Cleanup ---

  cleanupOldData(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const cutoffStr = this._toDateStr(cutoffDate);

      let removed = 0;
      [this.activitiesDir, this.summariesDir].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir)
          .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
          .forEach(file => {
            const dateStr = file.replace(/\.(json|jsonl)$/, '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
            if (dateStr < cutoffStr) {
              fs.unlinkSync(path.join(dir, file));
              removed++;
            }
          });
      });

      console.log(`清理完成，删除了 ${removed} 个过期文件，保留最近 ${daysToKeep} 天`);
      return true;
    } catch (error) {
      console.error('清理旧数据失败:', error);
      return false;
    }
  }

  // --- Directory scan helpers ---

  _listJsonFiles(dir) {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort();
    } catch (error) {
      console.error(`列出文件失败 ${dir}:`, error);
      return [];
    }
  }

  /** 活动目录里有数据的日期（json 与 jsonl 取并集） */
  _listActivityDates() {
    try {
      if (!fs.existsSync(this.activitiesDir)) return [];
      const set = new Set();
      fs.readdirSync(this.activitiesDir).forEach(f => {
        const m = /^(\d{4}-\d{2}-\d{2})\.(json|jsonl)$/.exec(f);
        if (!m) return;
        // 空文件（例如导入后被清空）不算"有数据"，否则日历上会出现点了没内容的日期
        try {
          if (fs.statSync(path.join(this.activitiesDir, f)).size > 2) set.add(m[1]);
        } catch (e) { /* 忽略读取失败的文件 */ }
      });
      return Array.from(set).sort();
    } catch (error) {
      return [];
    }
  }

  _getAllActivities() {
    let all = [];
    for (const dateStr of this._listActivityDates()) {
      all = all.concat(this._readActivityFile(dateStr));
    }
    return all;
  }

  _activityDatesInRange(start, end) {
    const startStr = this._toDateStr(start);
    const endStr = this._toDateStr(end);
    return this._listActivityDates().filter(d => d >= startStr && d <= endStr);
  }

  _getAllFromDir(dir) {
    const files = this._listJsonFiles(dir);
    let all = [];
    for (const file of files) {
      const items = this._readJsonFile(path.join(dir, file));
      all = all.concat(items);
    }
    return all;
  }

  _getDateFilesInRange(dir, start, end) {
    const startStr = this._toDateStr(start);
    const endStr = this._toDateStr(end);
    return this._listJsonFiles(dir)
      .filter(f => {
        const dateStr = f.replace('.json', '');
        return dateStr >= startStr && dateStr <= endStr;
      })
      .map(f => path.join(dir, f));
  }

  // --- Dates with data (for calendar) ---

  getDatesWithData() {
    return this._listActivityDates();
  }

  // --- Data migration between paths ---

  migrateDataTo(newPath) {
    try {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      // Test write access
      const testFile = path.join(newPath, '.write_test');
      fs.writeFileSync(testFile, 'test', 'utf8');
      fs.unlinkSync(testFile);

      const fileCount = copyMissingData(this.dataDir, newPath,
        ['activities', 'summaries', 'summaries_md', 'screenshots', 'arhat', 'dida', 'logs']);

      console.log(`已迁移 ${fileCount} 个文件到 ${newPath}`);
      return { success: true, fileCount };
    } catch (error) {
      console.error('数据迁移失败:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = StorageManager;
