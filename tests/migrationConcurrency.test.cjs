const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

/**
 * T-M09 / T-M12：迁移期间的 IPC 写入与「迁移期间新增的日期」。
 *
 * main.js 需要整个 Electron 运行时，没法在 node:test 里直接加载，所以这里
 * 验证的是它能依赖的那份契约：写方法在锁定时抛出带 MIGRATION_IN_PROGRESS 的
 * 错误（handler 据此转成 { code, retryable }），以及迁移期间新出现的日期文件
 * 不会因为回滚而被牵连。契约对了，handler 那一层的转换才有意义。
 */

const writeGate = require('../electron/writeGate');

function setup(t) {
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try {
    StorageManager = require('../electron/storageManager');
  } finally {
    Module._load = originalLoad;
  }
  return { storage: new StorageManager(), root };
}

function hashDir(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isFile()) {
      out[n] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }
  return out;
}

test('T-M09 an add-manual-record style write is rejected with a retryable code', t => {
  const { storage } = setup(t);
  const activitiesDir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(activitiesDir, { recursive: true });
  const before = hashDir(activitiesDir);

  writeGate.tryAcquire('migration:activities:1', 'migrating');

  // 与 main.js 的 add-manual-record 走同一个方法
  let error = null;
  try {
    const now = new Date();
    storage.appendActivityRecords([{
      t: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).toISOString(),
      dur: 900000,
      kind: 'active',
      app: 'manual',
      source: 'manual'
    }]);
  } catch (e) {
    error = e;
  }

  assert.ok(error, '必须抛错，而不是返回 false 假装写成功');
  assert.equal(error.code, 'MIGRATION_IN_PROGRESS');
  assert.match(error.message, /迁移/);

  assert.deepEqual(hashDir(activitiesDir), before, '磁盘必须一点没动');
});

test('T-M12 a date created during the migration survives the rollback untouched', t => {
  const { MigrationEngine } = require('../electron/legacyMigration');
  const h = require('./helpers/migrationFixture.cjs');

  const fx = h.makeFixture(t, {
    kind: 'activities',
    sourceRecords: [
      { id: 'm1', timestamp: h.isoLocal(2026, 11, 5, 9), processName: 'code' },
      { id: 'm2', timestamp: h.isoLocal(2026, 11, 6, 9), processName: 'chrome' }
    ]
  });

  const engine = new MigrationEngine({
    kind: 'activities', sourcePath: fx.sourcePath, targetDir: fx.targetDir, dataDir: fx.dataDir
  });
  const run = engine.run({ auto: true });
  assert.equal(run.ok, true);

  // 迁移完成之后又多出一天的数据（不在 manifest.targets 里）
  const extra = path.join(fx.targetDir, '2026-11-20.json');
  const extraContent = JSON.stringify([
    { id: 'later', timestamp: h.isoLocal(2026, 11, 20, 9), processName: 'after' }
  ], null, 2);
  fs.writeFileSync(extra, extraContent, 'utf8');

  const rb = new MigrationEngine({
    kind: 'activities', sourcePath: fx.sourcePath, targetDir: fx.targetDir, dataDir: fx.dataDir
  }).rollback({});

  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(extra, 'utf8'), extraContent, 'manifest 之外的日期一律不碰');
});

test('a blocked write after the gate opens goes through normally', t => {
  const { storage } = setup(t);
  const owner = 'm';
  writeGate.tryAcquire(owner, 'test');

  const now = new Date();
  const iso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 0, 0).toISOString();
  assert.throws(() => storage.appendActivityRecords([{ t: iso, dur: 1000, app: 'a' }]));

  writeGate.release(owner);
  assert.equal(writeGate.isLocked(), false);
  const ok = storage.appendActivityRecords([{ t: iso, dur: 1000, app: 'a' }]);
  assert.equal(ok, true, '锁释放后写入必须恢复');
});

test('setDataDir is refused during a migration rather than redirecting writes', t => {
  const { storage } = setup(t);
  writeGate.tryAcquire('m', 'test');

  assert.throws(() => storage.setDataDir(path.join(storage.getDataDir(), 'elsewhere')),
    (err) => err.code === 'MIGRATION_IN_PROGRESS');
});
