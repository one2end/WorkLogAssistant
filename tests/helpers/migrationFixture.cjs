/**
 * 迁移测试的共用夹具。
 *
 * 两条硬规矩：
 *   1. 所有路径都必须落在 os.tmpdir() 下的临时目录里，绝不碰真实用户数据
 *   2. 「崩溃」用抛出哨兵异常模拟，而不是真的 kill 进程——同一个测试进程内
 *      可以反复中断/重启，验证的正是「重启后状态可判定」这件事
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CRASH = 'SIMULATED_CRASH';

/** 制造一次「进程被杀」：抛出后调用方 catch 掉，就等同于重启 */
function crash() {
  const err = new Error(CRASH);
  err.simulatedCrash = true;
  throw err;
}

function isCrash(error) {
  return error && error.simulatedCrash === true;
}

function sha(file) {
  return fs.existsSync(file)
    ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    : null;
}

/** 目录内所有文件的 { 文件名: sha } 快照，用于逐字节比对 */
function snapshotDir(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = sha(p);
  }
  return out;
}

function countRecords(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.length : 0;
  } catch (_) {
    return 0;
  }
}

function totalRecords(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) n += countRecords(path.join(dir, name));
  }
  return n;
}

/** 本地时间构造 ISO 字符串，避免 UTC 偏移把记录挪到前一天 */
function isoLocal(y, m, d, h = 9, mi = 0) {
  return new Date(y, m - 1, d, h, mi, 0).toISOString();
}

/**
 * 搭一个临时数据目录。
 *
 * @param {object} opts
 * @param {'activities'|'summaries'} [opts.kind]
 * @param {Array} [opts.sourceRecords]     写进源单文件的记录
 * @param {object} [opts.existingByDate]   { 'YYYY-MM-DD': [records] } 目标目录已有数据
 * @param {boolean} [opts.withSource]      是否创建源文件（默认 true）
 */
function makeFixture(t, opts = {}) {
  const kind = opts.kind || 'activities';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lm-${kind}-`));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
  });

  const dataDir = path.join(root, 'Data');
  const targetDir = path.join(dataDir, kind);
  fs.mkdirSync(targetDir, { recursive: true });

  const sourcePath = path.join(dataDir, `${kind}.json`);
  if (opts.withSource !== false) {
    fs.writeFileSync(sourcePath, JSON.stringify(opts.sourceRecords || [], null, 2), 'utf8');
  }

  for (const [date, records] of Object.entries(opts.existingByDate || {})) {
    fs.writeFileSync(path.join(targetDir, `${date}.json`), JSON.stringify(records, null, 2), 'utf8');
  }

  return { root, dataDir, targetDir, sourcePath, kind };
}

/** 一次「完全成功」的参照结果，用于和其他中断路径逐字节比较 */
function runClean(fx, extra = {}) {
  const { MigrationEngine } = require('../../electron/legacyMigration');
  const engine = new MigrationEngine({
    kind: fx.kind,
    sourcePath: fx.sourcePath,
    targetDir: fx.targetDir,
    dataDir: fx.dataDir,
    ...extra
  });
  const result = engine.run({ auto: true });
  return { result, engine };
}

/**
 * 建一个带故障注入的引擎。
 * hooks 里的回调抛 crash() 即可在指定位置中断。
 */
function makeEngine(fx, hooks, extra = {}) {
  const { MigrationEngine } = require('../../electron/legacyMigration');
  return new MigrationEngine({
    kind: fx.kind,
    sourcePath: fx.sourcePath,
    targetDir: fx.targetDir,
    dataDir: fx.dataDir,
    hooks: hooks || {},
    ...extra
  });
}

/** 跑一次并吞掉模拟崩溃，返回是否崩了 */
function runCatching(engine, options = { auto: true }) {
  try {
    const result = engine.run(options);
    return { crashed: false, result };
  } catch (error) {
    if (isCrash(error)) return { crashed: true };
    throw error;
  }
}

function workspaceDirs(dataDir) {
  const root = path.join(dataDir, '.migration');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(n => path.join(root, n));
}

function readStatus(dir) {
  const p = path.join(dir, 'status.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

module.exports = {
  CRASH,
  crash,
  isCrash,
  sha,
  snapshotDir,
  countRecords,
  totalRecords,
  isoLocal,
  makeFixture,
  makeEngine,
  runClean,
  runCatching,
  workspaceDirs,
  readStatus
};
