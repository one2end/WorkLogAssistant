'use strict';

/**
 * legacyMigration.js — 旧版单文件 → 按天文件的迁移引擎
 *
 * 设计依据：docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md §2.3 ~ §2.14。
 *
 * 为什么要有这个文件：
 *   原来的 _migrateIfNeeded 是 `existing.concat(items)` + 改名归档。它没有
 *   manifest、没有哈希、没有状态，于是「写到一半被杀」「源文件在迁移途中被
 *   改」「上一次已经迁移过」这三种情况全都表现为「再跑一遍」——记录数就翻倍。
 *
 * 这里的核心承诺只有一条：**任何时刻被打断，重启后的结果都与「一次跑完」
 * 逐字节等价**。为了做到这一点，每个可能中断的点都留下可判定的证据：
 *   · 替换前记下 expectedSha256，重启后比对正式文件就知道它是否已就位
 *   · 归档前后各算一次源文件哈希，改名途中被改也能被发现
 *   · 判不出来的一律标 conflict 并保留全部副本，绝不猜
 *
 * 与外部进程（iCloud / OneDrive / 杀毒软件）的关系：
 *   应用内写锁只能挡住本进程。外部修改只能靠哈希检测，且「校验 → rename」
 *   之间有微秒级窗口。这里不假装能消除它，只保证窗口内的变化**不会被静默
 *   吞掉**，而是变成一个可见的 conflict，三份数据都留着。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const writeGate = require('./writeGate');
const { writeFileAtomic } = require('./atomicFile');

// --- 状态定义（§2.5a，9 个状态，4 个终态） ---

const PHASE = {
  INIT: 'init',
  SNAPSHOT: 'snapshot',
  STAGING: 'staging',
  REPLACING: 'replacing',
  FINISHING: 'finishing',
  DONE: 'done',
  ROLLEDBACK: 'rolledback',
  CONFLICT: 'conflict',
  FAILED: 'failed'
};

const TERMINAL_PHASES = new Set([PHASE.DONE, PHASE.ROLLEDBACK, PHASE.CONFLICT, PHASE.FAILED]);
const NON_TERMINAL_PHASES = [PHASE.INIT, PHASE.SNAPSHOT, PHASE.STAGING, PHASE.REPLACING, PHASE.FINISHING];

const MANIFEST_VERSION = 1;

// --- 小工具 ---

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/** 稳定序列化：对象键排序，数组顺序保留。保证同一内容哈希可复现。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * 目标文件的规范内容与哈希。
 *
 * 为什么不用 JSON.stringify(data, null, 2)：数组内部对象的字段顺序取决于源数据，
 * 同一批记录在不同次运行里可能字段顺序不同，哈希就对不上了。这里对对象键排序，
 * **数组顺序保留原样**（顺序本身是数据的一部分）。
 */
function serializeTarget(records) {
  return JSON.stringify(JSON.parse(stableStringify(records)), null, 2);
}

function targetHash(records) {
  return sha256OfBuffer(Buffer.from(serializeTarget(records), 'utf8'));
}

function defaultDateStr(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 去掉内部标记字段，写进 history 时不该带出去 */
function stripInternalKeys(detail) {
  const out = {};
  for (const k of Object.keys(detail)) {
    if (k === 'keepPreviousConflict') continue;
    out[k] = detail[k];
  }
  return out;
}

// --- 跨卷探测（§2.4：以实测 rename 为最终依据） ---

/**
 * 用一次真实的跨目录 rename 判断两个目录是否同卷。
 *
 * 为什么不靠 path.parse().root：Windows 上同一盘符可挂不同卷（mountvol/subst），
 * 不同 root 也可能是同卷（junction）。探测用的正是迁移要用的那个操作，
 * 成功即证明 rename 可用，比任何路径推断都直接。
 */
function probeSameVolume(workspaceDir, targetDir) {
  const probeName = `.samevol-probe-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const src = path.join(workspaceDir, probeName);
  const dst = path.join(targetDir, probeName);
  let result = null;
  try {
    fs.writeFileSync(src, 'probe', 'utf8');
    fs.renameSync(src, dst);
    result = { same: true };
  } catch (error) {
    if (error.code === 'EXDEV') result = { same: false, reason: 'EXDEV' };
    else result = { same: false, reason: error.code || 'UNKNOWN', message: error.message };
  } finally {
    for (const p of [src, dst]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* 清理失败不影响判定 */ }
    }
  }
  return result;
}

const realIo = {
  readFileSync: (...a) => fs.readFileSync(...a),
  writeFileSync: (file, data, enc) => fs.writeFileSync(file, data, enc),
  renameSync: (a, b) => fs.renameSync(a, b),
  existsSync: p => fs.existsSync(p),
  mkdirSync: (d, o) => fs.mkdirSync(d, o),
  readdirSync: d => fs.readdirSync(d),
  statSync: p => fs.statSync(p),
  unlinkSync: p => fs.unlinkSync(p)
};

// --- 引擎 ---

class MigrationEngine {
  /**
   * @param {object} options
   * @param {'activities'|'summaries'} options.kind
   * @param {string} options.sourcePath    旧版单文件
   * @param {string} options.targetDir     按天文件目标目录
   * @param {string} options.dataDir       数据根目录；.migration/ 建在这里以保证与目标同卷
   * @param {Function} [options.toDateStr] 时间戳 → YYYY-MM-DD
   * @param {Function} [options.onLog]
   * @param {object} [options.hooks]       故障注入点 { F1: fn }
   */
  constructor(options) {
    const o = options || {};
    if (!o.kind) throw new Error('legacyMigration: kind is required');
    if (!o.sourcePath) throw new Error('legacyMigration: sourcePath is required');
    if (!o.targetDir) throw new Error('legacyMigration: targetDir is required');
    if (!o.dataDir) throw new Error('legacyMigration: dataDir is required');

    this.kind = o.kind;
    this.sourcePath = path.resolve(o.sourcePath);
    this.targetDir = path.resolve(o.targetDir);
    this.dataDir = path.resolve(o.dataDir);
    this.migrationRoot = path.join(this.dataDir, '.migration');
    this.toDateStr = typeof o.toDateStr === 'function' ? o.toDateStr : defaultDateStr;
    this.onLog = typeof o.onLog === 'function' ? o.onLog : () => {};
    this.hooks = o.hooks || {};
    this.owner = `migration:${this.kind}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  }

  // --- 基础设施 ---

  _log(message, level) {
    this.onLog(`[${this.kind}] ${message}`, level || 'info');
  }

  /** 故障注入点。生产环境 hooks 为空，等同于不调用。 */
  _hook(name, payload) {
    const fn = this.hooks[name];
    if (typeof fn === 'function') fn(payload || {});
  }

  _targetFile(dateStr) {
    return path.join(this.targetDir, `${dateStr}.json`);
  }

  _sha(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return sha256OfBuffer(fs.readFileSync(file));
    } catch (_) {
      return null;
    }
  }

  _countRecords(file) {
    const data = readJsonSafe(file, null);
    return Array.isArray(data) ? data.length : 0;
  }

  workspaceId(sourceSha) {
    return `${this.kind}-${(sourceSha || '').slice(0, 8)}`;
  }

  workspaceDir(sourceSha) {
    return path.join(this.migrationRoot, this.workspaceId(sourceSha));
  }

  /** 本 kind 的全部工作区（含 .abandoned-* 等历史目录）。 */
  listWorkspaces() {
    if (!fs.existsSync(this.migrationRoot)) return [];
    const out = [];
    let names = [];
    try { names = fs.readdirSync(this.migrationRoot); } catch (_) { return []; }
    for (const name of names) {
      if (!name.startsWith(`${this.kind}-`)) continue;
      const dir = path.join(this.migrationRoot, name);
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch (_) { /* 跳过读不到的 */ }
      if (!isDir) continue;
      out.push({
        id: name,
        dir,
        status: readJsonSafe(path.join(dir, 'status.json'), null),
        manifest: readJsonSafe(path.join(dir, 'manifest.json'), null)
      });
    }
    return out;
  }

  // --- status / history ---

  _statusPath(dir) {
    return path.join(dir, 'status.json');
  }

  /** 缺 phase 的 status 只能当「没有状态」处理，否则会被误判进非终态分支。 */
  _readStatus(dir) {
    const s = readJsonSafe(this._statusPath(dir), null);
    if (!s) return null;
    if (typeof s.phase !== 'string') return Object.assign({}, s, { phase: null });
    return s;
  }

  /**
   * 写状态。每次转换都追加 status.history，工作区永不自动删除，
   * 出问题时能顺着历史看清它走到哪一步。
   */
  _setPhase(dir, to, reason, detail) {
    const prev = this._readStatus(dir) || { phase: null, history: [] };
    const from = prev.phase;
    const status = {
      phase: to,
      completedTargets: Array.isArray(prev.completedTargets) ? prev.completedTargets.slice() : [],
      lastError: prev.lastError || null,
      updatedAt: nowIso(),
      conflictDetail: prev.conflictDetail || null,
      archivedPath: prev.archivedPath || null,
      history: Array.isArray(prev.history) ? prev.history.slice() : []
    };
    if (to === PHASE.DONE || to === PHASE.ROLLEDBACK) {
      // 进了成功/回滚终态，旧冲突记录已不适用
      status.conflictDetail = null;
    } else if (detail && typeof detail === 'object') {
      status.conflictDetail = stripInternalKeys(detail);
    }
    status.history.push({
      at: status.updatedAt,
      from: from || null,
      to,
      reason: reason || null,
      detail: detail && typeof detail === 'object' ? stripInternalKeys(detail) : null
    });
    writeJsonSafe(this._statusPath(dir), status);
    return status;
  }

  _updateStatus(dir, patch) {
    const prev = this._readStatus(dir) || { phase: null, history: [] };
    const status = Object.assign({}, prev, patch, { updatedAt: nowIso() });
    writeJsonSafe(this._statusPath(dir), status);
    return status;
  }

  _markCompleted(dir, date) {
    const status = this._readStatus(dir) || { completedTargets: [] };
    const list = Array.isArray(status.completedTargets) ? status.completedTargets.slice() : [];
    if (!list.includes(date)) list.push(date);
    this._updateStatus(dir, { completedTargets: list });
  }

  // --- 阶段 0：前置检查 ---

  /**
   * 前置检查。返回 { ok, reason }，不抛错——调用方要能区分
   * 「没东西可迁」和「迁不了」。
   */
  precheck() {
    if (!fs.existsSync(this.sourcePath)) {
      return { ok: false, skipped: true, reason: 'source-missing' };
    }

    let raw;
    try {
      raw = fs.readFileSync(this.sourcePath);
    } catch (error) {
      return { ok: false, reason: 'source-unreadable', detail: { message: error.message, code: error.code } };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      // 源文件坏了不能猜：既不迁移，也不改名，原样留着
      return { ok: false, reason: 'source-unparsable', detail: { message: error.message } };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'source-not-array', detail: { type: typeof parsed } };
    }

    const sourceSha256 = sha256OfBuffer(raw);

    if (parsed.length === 0) {
      // 空源文件：没有数据可合，但也要归档改名，否则每次启动都会重复检查
      return { ok: true, empty: true, sourceSha256, sourceRecordCount: 0, records: [] };
    }

    const missingTimestamp = parsed.filter(r => !r || r.timestamp === undefined || r.timestamp === null).length;
    if (missingTimestamp > 0) {
      // 没有 timestamp 就归不了日；猜一个日期等于篡改历史
      return {
        ok: false,
        reason: 'source-records-without-timestamp',
        detail: { missingTimestamp, total: parsed.length }
      };
    }

    return { ok: true, sourceSha256, sourceRecordCount: parsed.length, records: parsed };
  }

  /** 探测工作区与目标目录是否同卷（§2.4）。 */
  checkVolume() {
    ensureDir(this.migrationRoot);
    ensureDir(this.targetDir);
    const probe = probeSameVolume(this.migrationRoot, this.targetDir);
    if (probe.same) return { ok: true };
    if (probe.reason === 'EXDEV') {
      return {
        ok: false,
        reason: 'EXDEV',
        message: '暂存目录与目标目录不在同一磁盘卷，无法保证原子替换。请检查数据目录设置。'
      };
    }
    return {
      ok: false,
      reason: probe.reason,
      message: `无法确认暂存目录与目标目录是否同卷（${probe.reason}）。${probe.message || ''}`
    };
  }

  // --- 阶段 1：manifest ---

  /**
   * 建 manifest。expectedSha256 在这里一次算定，之后所有判定都拿它做基准——
   * 这样「rename 成功但 status 没写」的崩溃窗口也能判定（§2.5b 的关键）。
   */
  _buildManifest(sourceInfo) {
    const grouped = new Map();
    for (const rec of sourceInfo.records) {
      const dateStr = this.toDateStr(rec.timestamp);
      if (!grouped.has(dateStr)) grouped.set(dateStr, []);
      grouped.get(dateStr).push(rec);
    }

    const targets = [];
    for (const dateStr of Array.from(grouped.keys()).sort()) {
      const incoming = grouped.get(dateStr);
      const targetFile = this._targetFile(dateStr);
      const preReplaceExists = fs.existsSync(targetFile);
      const preReplaceSha256 = preReplaceExists ? this._sha(targetFile) : null;
      const existing = preReplaceExists ? readJsonSafe(targetFile, []) : [];
      const existingArr = Array.isArray(existing) ? existing : [];
      const merged = existingArr.concat(incoming);

      targets.push({
        date: dateStr,
        preReplaceExists,
        // 文件不存在时用 0 而不是 null：守恒公式要拿它做加数
        preReplaceRecordCount: preReplaceExists ? existingArr.length : 0,
        preReplaceSha256,
        preReplaceBackup: preReplaceExists ? path.join('staging', `${dateStr}.pre-replace.json`) : null,
        expectedRecordCount: merged.length,
        expectedSha256: targetHash(merged),
        sourceRecordCountForDay: incoming.length
      });
    }

    return {
      kind: this.kind,
      manifestVersion: MANIFEST_VERSION,
      sourcePath: this.sourcePath,
      sourceSha256: sourceInfo.sourceSha256,
      sourceRecordCount: sourceInfo.sourceRecordCount,
      targetDir: this.targetDir,
      createdAt: nowIso(),
      targets
    };
  }

  /**
   * 生成/复用工作区。
   *
   * 复用而非重建：重建会丢掉 preReplace 快照，已经替换过的文件就再也无法回滚。
   */
  _ensureWorkspace(sourceInfo) {
    const dir = this.workspaceDir(sourceInfo.sourceSha256);
    const stagingDir = ensureDir(path.join(dir, 'staging'));
    const manifestPath = path.join(dir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      const manifest = this._buildManifest(sourceInfo);
      // 顺序很重要：先建 status（init），再写 manifest。
      // 反过来的话，manifest 写完、status 未写时被杀，重启后会看到
      // 「有 manifest 没 status」，判不出进度。
      if (!fs.existsSync(this._statusPath(dir))) {
        writeJsonSafe(this._statusPath(dir), {
          phase: null,
          completedTargets: [],
          lastError: null,
          updatedAt: nowIso(),
          conflictDetail: null,
          archivedPath: null,
          history: []
        });
      }
      writeJsonSafe(manifestPath, manifest);
      ensureDir(stagingDir);
      this._setPhase(dir, PHASE.INIT, 'workspace created');
      this._hook('F1', { dir, manifestPath });
      return { ok: true, dir, manifest, resumed: false };
    }

    const manifest = readJsonSafe(manifestPath, null);
    if (!manifest || manifest.manifestVersion !== MANIFEST_VERSION) {
      return { ok: false, reason: 'manifest-unreadable', dir };
    }
    if (manifest.sourceSha256 !== sourceInfo.sourceSha256) {
      return { ok: false, reason: 'source-changed', dir, manifest };
    }
    if (path.resolve(manifest.targetDir) !== this.targetDir) {
      return { ok: false, reason: 'target-dir-changed', dir, manifest };
    }
    return { ok: true, dir, manifest, resumed: true };
  }

  // --- 阶段 2：快照 ---

  /**
   * 不可变快照（JSONL）。迁移全程以它为准，而不是反复回读源文件——
   * 源文件随时可能被外部进程改动。
   */
  _writeSnapshot(dir, sourceInfo) {
    const snapshotPath = path.join(dir, 'source.snapshot.jsonl');
    const payload = sourceInfo.records.map(r => JSON.stringify(r)).join('\n') +
      (sourceInfo.records.length ? '\n' : '');
    const bytes = Buffer.from(payload, 'utf8');
    const snapshotSha = sha256OfBuffer(bytes);

    if (fs.existsSync(snapshotPath)) {
      const existing = this._sha(snapshotPath);
      if (existing === snapshotSha) return { recreated: false, sha: snapshotSha };
      // 快照被改过：不覆盖、不猜，直接判冲突
      return { conflict: true, reason: 'snapshot-mismatch', expected: snapshotSha, actual: existing };
    }

    fs.writeFileSync(snapshotPath, bytes, 'utf8');
    return { recreated: true, sha: snapshotSha };
  }

  // --- 阶段 3 / 4：staging 与校验 ---

  /**
   * 生成 staging。已存在且 SHA 正确的直接复用（F2：第一个复用、第二个重生成）。
   *
   * 合并内容 = 目标目录「当前」已有记录 + 源该天记录。这里用「当前」而不是
   * manifest 里的 preReplace 快照：如果目标文件在准备阶段后被改过，我们希望在
   * 替换前的校验里发现它，而不是悄悄按旧内容再合一遍。
   */
  _buildStaging(dir, target, options) {
    const opts = options || {};
    const stagingPath = path.join(dir, 'staging', `${target.date}.json`);
    const targetFile = this._targetFile(target.date);

    const currentSha = this._sha(targetFile);
    const currentExists = currentSha !== null;

    // 目标文件是否还是「替换前那个」
    const sameAsPreReplace = target.preReplaceExists
      ? currentSha === target.preReplaceSha256
      : currentExists === false;
    if (!sameAsPreReplace) {
      return { conflict: 'target-changed', currentSha, exists: currentExists };
    }

    if (fs.existsSync(stagingPath) && !opts.force) {
      const sha = this._sha(stagingPath);
      if (sha === target.expectedSha256) {
        return { reused: true, path: stagingPath, sha };
      }
      // staging 不完整或被改：删掉重生成。staging 是可再生的中间产物，
      // 删它不损失任何用户数据。
      try { fs.unlinkSync(stagingPath); } catch (_) { /* 删不掉就下一步覆盖 */ }
    }

    const existing = target.preReplaceExists ? readJsonSafe(targetFile, []) : [];
    const existingArr = Array.isArray(existing) ? existing : [];
    const incoming = this._recordsForDate(dir, target.date);
    const merged = existingArr.concat(incoming);

    if (merged.length !== target.expectedRecordCount) {
      return { conflict: 'record-count-mismatch', expected: target.expectedRecordCount, actual: merged.length };
    }

    const payload = serializeTarget(merged);
    const sha = sha256OfBuffer(Buffer.from(payload, 'utf8'));
    if (sha !== target.expectedSha256) {
      // 内容哈希对不上：合并结果与 manifest 记录的不一致
      return { conflict: 'staging-hash-mismatch', expected: target.expectedSha256, actual: sha };
    }

    writeFileAtomic(stagingPath, payload);
    return { created: true, path: stagingPath, sha };
  }

  /** 从快照里取某天的记录（按快照顺序，保证可复现）。 */
  _recordsForDate(dir, dateStr) {
    const cache = this._snapshotCache && this._snapshotCache.dir === dir ? this._snapshotCache : null;
    let groups = cache ? cache.groups : null;
    if (!groups) {
      groups = new Map();
      const snapshotPath = path.join(dir, 'source.snapshot.jsonl');
      let raw = '';
      try { raw = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : ''; } catch (_) { raw = ''; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        const d = this.toDateStr(rec.timestamp);
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(rec);
      }
      this._snapshotCache = { dir, groups };
    }
    return groups.get(dateStr) || [];
  }

  /**
   * 备份原文件到 staging/<date>.pre-replace.json。
   * 备份失败就等于没有回滚能力，此时绝不能继续替换。
   */
  _backupTarget(dir, target) {
    if (!target.preReplaceExists) return { ok: true, skipped: true };
    const backupPath = path.join(dir, target.preReplaceBackup);
    ensureDir(path.dirname(backupPath));

    if (fs.existsSync(backupPath)) {
      const sha = this._sha(backupPath);
      if (sha === target.preReplaceSha256) return { ok: true, reused: true, path: backupPath };
      // 已有备份与记录不符：不覆盖，判冲突
      return { ok: false, reason: 'backup-mismatch', expected: target.preReplaceSha256, actual: sha };
    }

    const targetFile = this._targetFile(target.date);
    let raw;
    try {
      raw = fs.readFileSync(targetFile);
    } catch (error) {
      return { ok: false, reason: 'backup-read-failed', message: error.message };
    }
    const sha = sha256OfBuffer(raw);
    if (sha !== target.preReplaceSha256) {
      return { ok: false, reason: 'target-changed-before-backup', expected: target.preReplaceSha256, actual: sha };
    }
    fs.writeFileSync(backupPath, raw);
    return { ok: true, created: true, path: backupPath, sha };
  }

  // --- 归档（§2.6a 三点校验） ---

  /**
   * 源文件归档改名。三步：
   *   A 改名前校验 → B 取唯一名并 rename → C 改名后校验归档内容
   *
   * 为什么必须 C：A 与 B 之间有窗口。若此刻外部同步把新数据写进源文件，
   * rename 会把「改过的内容」归档成 .migrated，而目标文件里没有这些新数据。
   * 只有 rename 之后再算一次哈希，才能把这种静默丢失变成可见的冲突。
   */
  _archiveSource(dir, manifest) {
    const expected = manifest.sourceSha256;

    // step A
    const preRenameSha = this._sha(this.sourcePath);
    if (preRenameSha === null) {
      // 源文件已不在：可能上一次已经改名（F5a 的判定路径）
      const verify = this._verifyAllTargetsOnDisk(manifest);
      if (verify.allPlaced) {
        const archived = this._findArchivedCandidate(manifest);
        if (archived) {
          this._updateStatus(dir, { archivedPath: archived });
          return { ok: true, alreadyArchived: true, archivedPath: archived };
        }
      }
      return {
        ok: false,
        conflict: {
          stage: 'pre-rename',
          reason: 'source-missing',
          targetsPlaced: verify.allPlaced,
          missing: verify.missing,
          note: '源文件已不存在，且目标文件未全部就位或找不到内容一致的归档，无法确认迁移是否完成'
        }
      };
    }
    if (preRenameSha !== expected) {
      return {
        ok: false,
        conflict: {
          stage: 'pre-rename',
          reason: 'source-modified',
          expected,
          actual: preRenameSha,
          sourceRecordCountAtStart: manifest.sourceRecordCount,
          sourceRecordCountNow: this._countRecords(this.sourcePath)
        }
      };
    }

    // step B：唯一归档名。renameSync 在目标已存在时会静默覆盖，
    // 覆盖掉的是上一次迁移留下的完整历史备份。
    const original = this.sourcePath;
    let candidate = original + '.migrated';
    if (fs.existsSync(candidate)) {
      candidate = `${original}.migrated-${stamp()}`;
      if (fs.existsSync(candidate)) {
        candidate = `${original}.migrated-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
      }
    }
    try {
      fs.renameSync(original, candidate);
    } catch (error) {
      // 被锁 / 权限不足：目标已就位，下次启动会重新走这一步（F5）
      return {
        ok: false,
        retryable: true,
        error: { stage: 'rename', code: error.code, message: error.message }
      };
    }
    this._updateStatus(dir, { archivedPath: candidate });
    this._hook('F5a', { dir, candidate });

    // step C
    const archivedSha = this._sha(candidate);
    if (archivedSha !== expected) {
      return {
        ok: false,
        conflict: {
          stage: 'post-rename',
          reason: 'archived-content-mismatch',
          expected,
          actual: archivedSha,
          archivedPath: candidate,
          note: '源文件在改名前被外部修改，已归档内容与迁移开始时不一致'
        }
      };
    }

    return { ok: true, archivedPath: candidate };
  }

  /** 找一份哈希等于 sourceSha256 的归档文件（含唯一名变体）。 */
  _findArchivedCandidate(manifest) {
    const dirPath = path.dirname(this.sourcePath);
    const base = path.basename(this.sourcePath);
    if (!fs.existsSync(dirPath)) return null;
    let names = [];
    try { names = fs.readdirSync(dirPath); } catch (_) { return null; }
    const candidates = names
      .filter(n => n === `${base}.migrated` || n.startsWith(`${base}.migrated-`))
      .sort();
    for (const n of candidates) {
      const p = path.join(dirPath, n);
      if (this._sha(p) === manifest.sourceSha256) return p;
    }
    return null;
  }

  /** 逐 target 比对正式文件哈希。 */
  _verifyAllTargetsOnDisk(manifest) {
    const missing = [];
    for (const t of manifest.targets) {
      const sha = this._sha(this._targetFile(t.date));
      if (sha !== t.expectedSha256) missing.push({ date: t.date, actual: sha, expected: t.expectedSha256 });
    }
    return { allPlaced: missing.length === 0, missing };
  }

  // --- 主流程 ---

  /**
   * 执行迁移。
   *
   * @param {object} [options]
   * @param {boolean} [options.auto] 启动时自动触发（true）还是用户显式触发（false）
   * @returns {object} 结构化结果，永不抛错——调用方在构造函数里，
   *                   抛错会让应用启动失败
   */
  run(options) {
    const opts = options || {};

    const pre = this.precheck();
    if (!pre.ok) {
      if (pre.skipped) {
        // 源文件不在 ≠ 没事情可做。
        // 「归档改名成功、status 还没来得及写」时被杀，重启就会看到源文件消失。
        // 此时若直接返回 skipped，那份工作区永远停在 finishing，目标文件虽已
        // 就位却永远判不出结果。所以先看有没有非终态工作区需要收尾。
        const resumed = this._resumeWithoutSource(opts);
        if (resumed) return resumed;
        return { ok: true, skipped: true, reason: pre.reason };
      }
      return { ok: false, reason: pre.reason, detail: pre.detail, noAction: true };
    }

    const proposedDir = this.workspaceDir(pre.sourceSha256);
    const proposedExists = fs.existsSync(proposedDir);

    // F7 的关键防线：存在非终态工作区时，源文件若已变成另一份内容，
    // 绝不能开一个新工作区继续合并——那会与上一份未完成的迁移叠加，
    // 记录数直接翻倍。工作区是按源哈希命名的，所以「新哈希 → 新目录」
    // 会天然绕过 _ensureWorkspace 的一致性检查，必须在这里拦住。
    if (!proposedExists) {
      const liveElsewhere = this.listWorkspaces().filter(
        w => w.manifest && w.status && !TERMINAL_PHASES.has(w.status.phase)
      );
      if (liveElsewhere.length) {
        const ws = liveElsewhere[0];
        this._setPhase(ws.dir, PHASE.CONFLICT, 'source changed while migration incomplete', {
          stage: 'precheck',
          reason: 'source-modified-during-incomplete-migration',
          message: '上次迁移未完成且源文件已变化。请先完成或回滚上次迁移。'
        });
        return {
          ok: false,
          reason: 'source-changed',
          message: '上次迁移未完成且源文件已变化。请先完成或回滚上次迁移。',
          phase: PHASE.CONFLICT,
          workspace: ws.dir
        };
      }
    }

    if (opts.auto && !proposedExists) {
      // 没有本源的续跑工作区，但存在别的终态工作区（conflict/failed/rolledback）：
      // 只提示，绝不自动重跑（§2.5a）
      const blocking = this.listWorkspaces()
        .filter(w => w.status && TERMINAL_PHASES.has(w.status.phase) && w.status.phase !== PHASE.DONE);
      if (blocking.length) {
        return {
          ok: false,
          reason: 'terminal-workspace-requires-input',
          workspaces: blocking.map(w => ({ id: w.id, phase: w.status.phase }))
        };
      }
    }

    const vol = this.checkVolume();
    if (!vol.ok) {
      if (proposedExists) {
        this._setPhase(proposedDir, PHASE.CONFLICT, 'volume probe failed', {
          stage: 'precheck',
          reason: vol.reason,
          message: vol.message
        });
      }
      return { ok: false, reason: 'volume', message: vol.message, code: vol.reason };
    }

    const ws = this._ensureWorkspace(pre);
    if (!ws.ok) return this._handleWorkspaceRefusal(ws, opts);

    // 拿锁。拿不到说明另一个迁移在跑，本次直接放弃（不是错误）
    if (!writeGate.tryAcquire(this.owner, `migrating ${this.kind}`)) {
      return { ok: false, reason: 'another-migration-running' };
    }

    try {
      return writeGate.withMigrationContext(() => this._runPhases(ws, pre));
    } catch (error) {
      // 故障注入的哨兵异常必须穿透：它模拟的是「进程被杀」，
      // 而不是「迁移逻辑出错」。把它记成 failed 会让测试失去意义，
      // 也会把真实场景里的「进程消失」误判成业务错误。
      if (error && error.simulatedCrash === true) {
        this._log('模拟中断：进程在此处被杀，状态保留在磁盘上', 'info');
        throw error;
      }
      const status = this._readStatus(ws.dir);
      const current = status ? status.phase : null;
      if (!current || !TERMINAL_PHASES.has(current)) {
        this._updateStatus(ws.dir, {
          lastError: { message: error.message, code: error.code || null, stack: error.stack }
        });
        this._setPhase(ws.dir, PHASE.FAILED, 'unrecoverable error', {
          stage: current,
          reason: 'exception',
          message: error.message
        });
      }
      this._log(`迁移失败：${error.message}`, 'error');
      return { ok: false, reason: 'exception', error: error.message };
    } finally {
      writeGate.release(this.owner);
    }
  }

  /**
   * 源文件不在，但还有未收尾的工作区：走 F5a 的四重判定。
   *
   * 四重判定：源文件不存在 + 归档文件存在 + 归档哈希 == manifest.sourceSha256
   *          + 所有 target 哈希 == expectedSha256。
   * 全中才算完成；任一不满足就标冲突并保留所有副本，绝不当成「没东西可迁」。
   */
  _resumeWithoutSource(opts) {
    const live = this.listWorkspaces().filter(w => w.manifest && w.status && !TERMINAL_PHASES.has(w.status.phase));
    if (!live.length) return null;

    // 只在 finishing 阶段做这件事：其它阶段的源文件消失属于异常，
    // 不能拿「四重判定」蒙混过去（那会跳过尚未完成的替换）。
    const finishing = live.filter(w => w.status.phase === PHASE.FINISHING);
    if (!finishing.length) {
      return {
        ok: false,
        reason: 'source-missing-with-live-workspace',
        message: '源文件已不存在，但迁移尚未走到归档阶段，无法确认是否完成。请人工核对。',
        workspaces: live.map(w => ({ id: w.id, phase: w.status.phase }))
      };
    }

    const ws = finishing[0];
    const dir = ws.dir;
    const manifest = ws.manifest;
    const expected = manifest.sourceSha256;

    if (!writeGate.tryAcquire(this.owner, `resuming ${this.kind}`)) {
      return { ok: false, reason: 'another-migration-running' };
    }

    try {
      return writeGate.withMigrationContext(() => {
        const verify = this._verifyAllTargetsOnDisk(manifest);
        if (!verify.allPlaced) {
          this._setPhase(dir, PHASE.CONFLICT, 'source gone and targets not placed', {
            stage: 'pre-rename',
            reason: 'source-missing-targets-incomplete',
            missing: verify.missing
          });
          return { ok: false, reason: 'conflict', stage: 'pre-rename', workspace: dir };
        }

        const archived = this._findArchivedCandidate(manifest);
        if (!archived) {
          // 源没了、归档也没有、目标却齐了：可能是用户手工删了源文件。
          // 不猜，标冲突等人工确认。
          this._setPhase(dir, PHASE.CONFLICT, 'source gone without archive', {
            stage: 'pre-rename',
            reason: 'source-missing-no-archive',
            note: '源文件与归档文件都不存在，但目标文件已全部就位。无法确认迁移是否本应完成。'
          });
          return { ok: false, reason: 'conflict', stage: 'pre-rename', workspace: dir };
        }

        const archivedSha = this._sha(archived);
        if (archivedSha !== expected) {
          this._setPhase(dir, PHASE.CONFLICT, 'archived content does not match', {
            stage: 'post-rename',
            reason: 'archived-content-mismatch',
            expected,
            actual: archivedSha,
            archivedPath: archived
          });
          return { ok: false, reason: 'conflict', stage: 'archive', workspace: dir };
        }

        this._updateStatus(dir, { archivedPath: archived });
        this._setPhase(dir, PHASE.DONE, 'resumed: source was already archived', { archivedPath: archived });
        return {
          ok: true,
          phase: PHASE.DONE,
          workspace: dir,
          archivedPath: archived,
          resumed: true,
          targets: manifest.targets.length
        };
      });
    } finally {
      writeGate.release(this.owner);
    }
  }

  /** 工作区无法复用时按状态机分流，绝不擅自新建。 */
  _handleWorkspaceRefusal(ws, opts) {    const dir = ws.dir;
    const status = dir ? this._readStatus(dir) : null;

    if (ws.reason === 'source-changed') {
      // F7 / §2.7：先看旧工作区状态
      if (status && TERMINAL_PHASES.has(status.phase)) {
        return {
          ok: false,
          reason: 'source-changed-after-terminal',
          phase: status.phase,
          message: '上次迁移已处于终态，但源文件内容已变化。不自动处理，需人工确认。'
        };
      }
      // 非终态 + 源已变 → 停止，标 conflict，**不新建工作区**
      if (dir && fs.existsSync(path.join(dir, 'manifest.json'))) {
        this._setPhase(dir, PHASE.CONFLICT, 'source changed while migration incomplete', {
          stage: 'precheck',
          reason: 'source-modified-during-incomplete-migration',
          message: '上次迁移未完成且源文件已变化。请先完成或回滚上次迁移。'
        });
      }
      return {
        ok: false,
        reason: 'source-changed',
        message: '上次迁移未完成且源文件已变化。请先完成或回滚上次迁移。'
      };
    }

    if (ws.reason === 'target-dir-changed') {
      return {
        ok: false,
        reason: 'target-dir-changed',
        message: 'manifest 记录的目标目录与当前目标目录不一致，已停止，需人工确认。'
      };
    }

    return { ok: false, reason: ws.reason || 'workspace-unusable' };
  }

  /**
   * 六个阶段的执行体。所有写入都在迁移特权上下文内（由 run() 包裹）。
   *
   * 每个阶段都能从任意中断点续跑，因为每一步的判定依据都落在磁盘上。
   */
  _runPhases(ws, pre) {
    const dir = ws.dir;
    const manifest = ws.manifest;
    const status = this._readStatus(dir);

    // 终态工作区：什么都不做（§2.5a）
    if (status && TERMINAL_PHASES.has(status.phase)) {
      return { ok: status.phase === PHASE.DONE, reason: 'terminal', phase: status.phase, workspace: dir };
    }

    // ---- 阶段 2：快照 ----
    const phase0 = status ? status.phase : null;
    if (!phase0 || phase0 === PHASE.INIT) {
      this._setPhase(dir, PHASE.SNAPSHOT, 'snapshot starting');
      this._snapshotCache = null;
      const snap = this._writeSnapshot(dir, pre);
      if (snap.conflict) {
        this._setPhase(dir, PHASE.CONFLICT, 'snapshot mismatch', {
          stage: 'snapshot',
          reason: snap.reason,
          expected: snap.expected,
          actual: snap.actual
        });
        return { ok: false, reason: 'conflict', stage: 'snapshot', workspace: dir };
      }
      this._snapshotCache = null;
    }

    // ---- 阶段 3/4：staging ----
    const st = this._readStatus(dir);
    if (!st || st.phase === PHASE.SNAPSHOT || st.phase === PHASE.INIT) {
      this._setPhase(dir, PHASE.STAGING, 'building staging');
    }

    const staged = [];
    let index = 0;
    for (const target of manifest.targets) {
      index += 1;
      const result = this._buildStaging(dir, target);
      if (result.conflict) {
        // 已被替换过（SHA == expected）时不算冲突，交给替换阶段判定就位
        if (result.conflict === 'target-changed' && result.currentSha === target.expectedSha256) {
          this._markCompleted(dir, target.date);
          continue;
        }
        this._setPhase(dir, PHASE.CONFLICT, 'pre-replace check failed', {
          stage: 'pre-replace',
          reason: result.conflict,
          date: target.date,
          expected: target.expectedSha256,
          actual: result.currentSha === undefined ? null : result.currentSha,
          preReplace: target.preReplaceSha256,
          detail: result
        });
        return { ok: false, reason: 'conflict', stage: 'pre-replace', date: target.date, workspace: dir };
      }
      staged.push({ target, path: result.path });
      if (index === 2) this._hook('F2', { dir, index, path: result.path });
    }
    this._hook('F3', { dir, count: staged.length });

    // ---- 阶段 5：替换 ----
    const phaseNow = this._readStatus(dir);
    if (phaseNow && phaseNow.phase === PHASE.STAGING) {
      this._setPhase(dir, PHASE.REPLACING, 'replacing targets');
    }

    let replacedCount = 0;
    for (const { target, path: stagingPath } of staged) {
      const targetFile = this._targetFile(target.date);
      const currentSha = this._sha(targetFile);

      if (currentSha === target.expectedSha256) {
        // F4 / F4a：已经就位（上次 rename 成功但 status 没写）→ 不重写
        this._markCompleted(dir, target.date);
        continue;
      }

      // 替换前重新校验：目标文件必须仍然是「替换前那个」
      const sameAsPre = target.preReplaceExists
        ? currentSha === target.preReplaceSha256
        : currentSha === null;
      if (!sameAsPre) {
        this._setPhase(dir, PHASE.CONFLICT, 'target changed before replace', {
          stage: 'pre-replace',
          reason: 'target-changed',
          date: target.date,
          expected: target.preReplaceSha256,
          actual: currentSha
        });
        return { ok: false, reason: 'conflict', stage: 'pre-replace', date: target.date, workspace: dir };
      }

      const backup = this._backupTarget(dir, target);
      if (!backup.ok) {
        this._setPhase(dir, PHASE.CONFLICT, 'backup failed', {
          stage: 'pre-replace',
          reason: backup.reason,
          date: target.date,
          expected: backup.expected,
          actual: backup.actual,
          message: backup.message
        });
        return { ok: false, reason: 'conflict', stage: 'backup', date: target.date, workspace: dir };
      }

      ensureDir(this.targetDir);
      // F4 的注入点必须在 rename **之前**：规范要求「第 1 个已就位不重复，
      // 从第 2 个继续」，那么在第二个文件即将写入时被杀，才恰好留下
      // 「一个已替换、一个未替换」的状态。
      if (replacedCount === 1) this._hook('F4', { dir, date: target.date });
      try {
        fs.renameSync(stagingPath, targetFile);
      } catch (error) {
        // rename 失败：目标未变，staging 还在，下次重试即可
        this._setPhase(dir, PHASE.FAILED, 'rename failed', {
          stage: 'replacing',
          reason: 'rename-failed',
          date: target.date,
          code: error.code,
          message: error.message
        });
        return { ok: false, reason: 'rename-failed', date: target.date, workspace: dir };
      }

      this._markCompleted(dir, target.date);
      replacedCount += 1;
      // F4a：rename 成功、status 刚写完之后被杀
      this._hook('F4a', { dir, date: target.date });
      if (this.hooks.F6 && typeof this.hooks.F6.afterRename === 'function') {
        this.hooks.F6.afterRename({ dir, date: target.date });
      }
    }

    // ---- 阶段 6：finishing ----
    this._setPhase(dir, PHASE.FINISHING, 'verifying before archive');

    const verify = this._verifyAllTargetsOnDisk(manifest);
    if (!verify.allPlaced) {
      this._setPhase(dir, PHASE.CONFLICT, 'targets not placed after replace', {
        stage: 'finishing',
        reason: 'targets-not-placed',
        missing: verify.missing
      });
      return { ok: false, reason: 'conflict', stage: 'finishing', workspace: dir };
    }

    this._hook('F7', { dir });

    const archived = this._archiveSource(dir, manifest);
    if (archived.conflict) {
      // 冲突：保留归档文件、目标文件、工作区，等人工处理
      this._setPhase(dir, PHASE.CONFLICT, 'archive conflict', archived.conflict);
      return { ok: false, reason: 'conflict', stage: 'archive', workspace: dir, detail: archived.conflict };
    }
    if (!archived.ok && archived.retryable) {
      // 改名失败（被同步软件或杀毒软件锁住）：**不能进 failed 终态**。
      // failed 是终态，重启后不会自动继续，那这份数据就永远卡在半路——
      // 而目标文件其实已经全部就位，只差把源文件改个名。
      // 所以退回 finishing（非终态），下次启动直接重试改名。
      this._setPhase(dir, PHASE.FINISHING, 'source rename blocked, will retry on next start',
        Object.assign({ stage: 'finishing', retryable: true }, archived.error));
      return { ok: false, reason: 'rename-failed', stage: 'finishing', workspace: dir, detail: archived.error };
    }

    if (!archived.ok) {
      this._setPhase(dir, PHASE.FAILED, 'archive failed', { stage: 'finishing', reason: 'archive-failed' });
      return { ok: false, reason: 'archive-failed', stage: 'finishing', workspace: dir };
    }

    this._setPhase(dir, PHASE.DONE, 'migration complete', {
      archivedPath: archived.archivedPath,
      alreadyArchived: !!archived.alreadyArchived
    });
    return {
      ok: true,
      phase: PHASE.DONE,
      workspace: dir,
      archivedPath: archived.archivedPath,
      targets: manifest.targets.length,
      sourceRecordCount: manifest.sourceRecordCount
    };
  }

  // --- 回滚（§2.8 五分支） ---

  /**
   * 回滚到迁移前。逐文件判定，绝不批量覆盖后再校验。
   *
   * 为什么这么啰嗦：回滚最危险的写法是「用备份覆盖回去」。迁移之后用户可能
   * 又录了新数据，那些数据不在任何备份里，覆盖一次就没了。所以这里对每个
   * 文件先算当前哈希，再决定「恢复 / 跳过 / 隔离 / 停下问人」。
   *
   * @param {object} [options]
   * @param {string} [options.workspaceDir] 指定工作区；默认取当前源对应的
   * @returns {object}
   */
  rollback(options) {
    const opts = options || {};
    const pre = this.precheck();
    // 源文件可能已改名（迁移成功过），回滚仍要允许，所以不以 precheck 为门槛
    const sourceSha = opts.sourceSha256 ||
      (pre.ok ? pre.sourceSha256 : this._guessSourceShaFromWorkspaces());

    let dir = opts.workspaceDir;
    if (!dir && sourceSha) dir = this.workspaceDir(sourceSha);
    if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
      return { ok: false, reason: 'workspace-not-found' };
    }

    const manifest = readJsonSafe(path.join(dir, 'manifest.json'), null);
    const status = this._readStatus(dir);

    if (status && status.phase === PHASE.ROLLEDBACK) {
      return { ok: true, reason: 'already-rolled-back', phase: PHASE.ROLLEDBACK, workspace: dir };
    }

    if (!writeGate.tryAcquire(this.owner, `rolling back ${this.kind}`)) {
      return { ok: false, reason: 'another-migration-running' };
    }

    try {
      return writeGate.withMigrationContext(() => this._doRollback(dir, manifest));
    } finally {
      writeGate.release(this.owner);
    }
  }

  /** 源文件已改名时，从工作区里反推它原本的哈希。 */
  _guessSourceShaFromWorkspaces() {
    const list = this.listWorkspaces().filter(w => w.manifest && w.manifest.sourceSha256);
    if (!list.length) return null;
    // 取最近创建的那个
    list.sort((a, b) => String(b.manifest.createdAt || '').localeCompare(String(a.manifest.createdAt || '')));
    return list[0].manifest.sourceSha256;
  }

  _doRollback(dir, manifest) {
    if (!manifest) return { ok: false, reason: 'manifest-unreadable' };

    const conflictFiles = [];
    const restored = [];
    const skipped = [];
    const removed = [];

    // 逐个目标文件，逐分支判定
    for (const target of manifest.targets) {
      const targetFile = this._targetFile(target.date);
      const currentSha = this._sha(targetFile);

      // 情况 1：内容 == 迁移后预期 → 可安全回滚
      if (currentSha !== null && currentSha === target.expectedSha256) {
        if (target.preReplaceExists) {
          const backupPath = path.join(dir, target.preReplaceBackup);
          const backupSha = this._sha(backupPath);
          if (backupSha !== target.preReplaceSha256) {
            // 备份本身不完整：不能拿它覆盖，隔离并记录
            conflictFiles.push({
              date: target.date,
              reason: 'backup-missing-or-mismatch',
              expected: target.preReplaceSha256,
              actual: backupSha,
              backupPath
            });
            continue;
          }
          const raw = fs.readFileSync(backupPath);
          fs.writeFileSync(targetFile, raw);
          restored.push(target.date);
        } else {
          // 迁移新建的文件 → 删掉
          fs.unlinkSync(targetFile);
          removed.push(target.date);
        }
        continue;
      }

      // 情况 2：已是原始状态 → 跳过
      if (currentSha !== null && target.preReplaceExists && currentSha === target.preReplaceSha256) {
        skipped.push({ date: target.date, reason: 'already-pre-replace' });
        continue;
      }

      // 情况 3：原本不存在，现在也不存在 → 跳过
      if (currentSha === null && !target.preReplaceExists) {
        skipped.push({ date: target.date, reason: 'absent-before-and-now' });
        continue;
      }

      // 情况 4：原本存在，现在没了 → 原因无法区分，禁止自动恢复
      if (currentSha === null && target.preReplaceExists) {
        conflictFiles.push({
          date: target.date,
          reason: 'target-missing-unexpectedly',
          expected: target.preReplaceSha256,
          actual: null,
          backupPath: path.join(dir, target.preReplaceBackup)
        });
        continue;
      }

      // 情况 5：存在但既非预期也非替换前 → 含迁移后的新数据，禁止覆盖
      const isolateDir = ensureDir(path.join(dir, 'conflict-files'));
      const isolatePath = path.join(isolateDir, `${target.date}.json`);
      try {
        fs.copyFileSync(targetFile, isolatePath);
      } catch (_) { /* 复制失败不影响「不覆盖」这个决定 */ }
      conflictFiles.push({
        date: target.date,
        reason: 'target-modified-after-migration',
        expected: target.expectedSha256,
        actual: currentSha,
        isolatedPath: isolatePath
      });
      // 关键：原文件保持原样不动
    }

    if (conflictFiles.length) {
      this._setPhase(dir, PHASE.CONFLICT, 'rollback encountered conflicts', {
        stage: 'rollback',
        files: conflictFiles,
        restored,
        removed,
        skipped
      });
      return {
        ok: false,
        reason: 'conflict',
        phase: PHASE.CONFLICT,
        workspace: dir,
        restored,
        removed,
        skipped,
        conflictFiles
      };
    }

    // 源文件恢复原名（若此前已归档）
    const restoreSource = this._restoreSourceName(dir, manifest);

    this._setPhase(dir, PHASE.ROLLEDBACK, 'rollback complete', {
      restored,
      removed,
      skipped,
      sourceRestored: restoreSource
    });
    return {
      ok: true,
      phase: PHASE.ROLLEDBACK,
      workspace: dir,
      restored,
      removed,
      skipped,
      sourceRestored: restoreSource
    };
  }

  /**
   * 把归档文件改回原名。
   * 只在源位置当前没有文件时才改名——否则会覆盖迁移之后新写的源文件。
   */
  _restoreSourceName(dir, manifest) {
    if (fs.existsSync(this.sourcePath)) return { ok: true, already: true };
    const archived = this._findArchivedCandidate(manifest);
    if (!archived) return { ok: false, reason: 'archive-not-found' };
    try {
      fs.renameSync(archived, this.sourcePath);
      this._updateStatus(dir, { archivedPath: null });
      return { ok: true, restoredFrom: archived };
    } catch (error) {
      return { ok: false, reason: 'rename-failed', message: error.message };
    }
  }

  // --- 人工介入（§2.14） ---

  /**
   * 把工作区重命名为 <id>.<outcome>-<ts>/，标记为已处理。
   * 不删除任何东西：数据文件、快照、staging 全部留着供审计。
   */
  archiveWorkspace(outcome, options) {
    const opts = options || {};
    const dir = opts.workspaceDir || (opts.sourceSha256
      ? this.workspaceDir(opts.sourceSha256)
      : (this.listWorkspaces()[0] || {}).dir);
    if (!dir || !fs.existsSync(dir)) return { ok: false, reason: 'workspace-not-found' };

    const label = outcome || 'abandoned';
    const target = `${dir}.${label}-${stamp()}`;
    try {
      fs.renameSync(dir, target);
    } catch (error) {
      return { ok: false, reason: 'rename-failed', message: error.message };
    }
    const status = readJsonSafe(path.join(target, 'status.json'), null);
    if (status) {
      status.archivedAs = path.basename(target);
      status.archivedAt = nowIso();
      status.archivedOutcome = label;
      writeJsonSafe(path.join(target, 'status.json'), status);
    }
    return { ok: true, workspace: target, outcome: label };
  }

}

module.exports = {
  PHASE,
  TERMINAL_PHASES,
  NON_TERMINAL_PHASES,
  MANIFEST_VERSION,
  probeSameVolume,
  serializeTarget,
  targetHash,
  sha256OfBuffer,
  stableStringify,
  defaultDateStr,
  MigrationEngine,
  createEngine: options => new MigrationEngine(options)
};
