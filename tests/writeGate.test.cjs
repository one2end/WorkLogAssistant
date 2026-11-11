const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

/**
 * 统一写入锁（T-M09、T-M10、T-M16 ~ T-M22）。
 *
 * 这些用例的核心不是「抛错了就算过」，而是「抛错 + 磁盘真的没动」。
 * 只断言异常类型而不比对文件哈希，等于没验证锁，所以每个写方法都记录前后 SHA。
 */

const writeGate = require('../electron/writeGate');
const ActivityRecorder = require('../electron/activityRecorder');

function hashFile(p) {
  return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
}

function hashDir(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = hashFile(p);
  }
  return out;
}

/** 每个用例都必须从干净状态开始：锁是模块级的，漏了 reset 会互相污染。 */
function setup(t) {
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-gate-'));
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

  const storage = new StorageManager();
  const dataDir = storage.getDataDir();
  const activitiesDir = path.join(dataDir, 'activities');
  const summariesDir = path.join(dataDir, 'summaries');
  fs.mkdirSync(activitiesDir, { recursive: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  const today = storage._todayStr();
  const todayJson = path.join(activitiesDir, `${today}.json`);
  const todayJsonl = path.join(activitiesDir, `${today}.jsonl`);
  // 统一用「今天 09:00」本地时刻构造：storage 分日也按本地日期，两边必然同一天
  const atToday = (h, m = 0) => {
    const [y, mo, d] = today.split('-').map(Number);
    return new Date(y, mo - 1, d, h, m, 0).toISOString();
  };
  fs.writeFileSync(todayJson, JSON.stringify([
    { id: 'a1', timestamp: new Date().toISOString(), processName: 'code', windowTitle: 'x' }
  ], null, 2), 'utf8');
  fs.writeFileSync(todayJsonl, JSON.stringify({
    t: atToday(9), dur: 600000, app: 'code', title: 'y'
  }) + '\n', 'utf8');
  // 让 cleanupOldData 有东西可删（应用它就会真删）
  fs.writeFileSync(path.join(activitiesDir, '2000-01-01.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(summariesDir, '2000-01-01.json'), '[]', 'utf8');

  const takeLock = () => writeGate.tryAcquire('test-holder', 'unit test');

  return { storage, dataDir, activitiesDir, summariesDir, today, todayJson, todayJsonl, atToday, takeLock };
}

test('T-M16 appendActivityRecords throws while migration holds the gate and leaves disk untouched', t => {
  const ctx = setup(t);
  ctx.takeLock();
  const before = hashDir(ctx.activitiesDir);

  assert.throws(
    () => ctx.storage.appendActivityRecords([{ t: ctx.atToday(11), dur: 1000, app: 'code' }]),
    (err) => err.code === writeGate.ERR
  );
  assert.deepEqual(hashDir(ctx.activitiesDir), before, '磁盘内容必须逐字节不变');
});

test('T-M17 saveActivity throws while locked and leaves disk untouched', t => {
  const ctx = setup(t);
  ctx.takeLock();
  const before = hashDir(ctx.activitiesDir);

  assert.throws(
    () => ctx.storage.saveActivity({ id: 'zz', timestamp: new Date().toISOString(), processName: 'other' }),
    (err) => err.code === writeGate.ERR
  );
  assert.deepEqual(hashDir(ctx.activitiesDir), before);
});

test('T-M21 saveScreenshot is blocked and today file hash is unchanged', t => {
  const ctx = setup(t);
  const before = hashFile(ctx.todayJson);
  ctx.takeLock();

  assert.throws(() => ctx.storage.saveScreenshot('a1', 'shot.png'), (err) => err.code === writeGate.ERR);
  assert.equal(hashFile(ctx.todayJson), before, 'activities/<today>.json 必须完全没变');
});

test('T-M22 cleanupOldData is blocked and deletes nothing', t => {
  const ctx = setup(t);
  const oldActivity = path.join(ctx.activitiesDir, '2000-01-01.json');
  const oldSummary = path.join(ctx.summariesDir, '2000-01-01.json');
  ctx.takeLock();

  assert.throws(() => ctx.storage.cleanupOldData(30), (err) => err.code === writeGate.ERR);
  assert.ok(fs.existsSync(oldActivity), '过期活动文件不得被删除');
  assert.ok(fs.existsSync(oldSummary), '过期摘要文件不得被删除');
});

test('T-M18 all 15 mutating methods are blocked while the gate is held', t => {
  const ctx = setup(t);
  ctx.takeLock();
  const dateStr = '2026-11-08';
  const iso = new Date(`${dateStr}T09:00:00`).toISOString();

  const calls = [
    ['saveActivity', () => ctx.storage.saveActivity({ id: 'x', timestamp: iso })],
    ['appendActivityRecords', () => ctx.storage.appendActivityRecords([{ t: iso, dur: 1000, app: 'code' }])],
    ['deleteActivity', () => ctx.storage.deleteActivity('a1')],
    ['updateDisplayRecord', () => ctx.storage.updateDisplayRecord(dateStr, iso, { title: 'n' })],
    ['deleteDisplayRange', () => ctx.storage.deleteDisplayRange(dateStr, iso, new Date(`${dateStr}T10:00:00`).toISOString())],
    ['replaceDisplayRanges', () => ctx.storage.replaceDisplayRanges(dateStr, [], { t: iso, dur: 1000 })],
    ['recategorizeAppForDay', () => ctx.storage.recategorizeAppForDay(dateStr, 'code', 'work', [])],
    ['deleteDisplayRecord', () => ctx.storage.deleteDisplayRecord(dateStr, iso)],
    ['clearActivities', () => ctx.storage.clearActivities()],
    ['saveSummary', () => ctx.storage.saveSummary({ id: 's1', timestamp: iso, summary: 'x' })],
    ['deleteSummary', () => ctx.storage.deleteSummary('s1')],
    ['saveScreenshot', () => ctx.storage.saveScreenshot('a1', 'p.png')],
    ['cleanupOldData', () => ctx.storage.cleanupOldData(30)],
    ['migrateDataTo', () => ctx.storage.migrateDataTo(path.join(ctx.dataDir, 'elsewhere'))],
    ['setDataDir', () => ctx.storage.setDataDir(path.join(ctx.dataDir, 'elsewhere'))]
  ];

  assert.equal(calls.length, 15, '规范 §2.13：16 个磁盘写方法中 15 个需要阻塞');
  const blocked = [];
  for (const [name, fn] of calls) {
    let code = null;
    try {
      fn();
    } catch (error) {
      code = error.code;
    }
    if (code === writeGate.ERR) blocked.push(name);
  }
  assert.equal(blocked.length, 15, `应全部阻塞，实际阻塞 ${blocked.length} 个：${blocked.join(',')}`);
  assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'elsewhere')), 'setDataDir / migrateDataTo 不得创建目录');
});

test('T-M19 the gate is released after success, failure and rollback paths', t => {
  const ctx = setup(t);
  const owner = 'migration:activities:1';

  // 成功路径
  assert.equal(writeGate.tryAcquire(owner, 'ok'), true);
  writeGate.release(owner);
  assert.equal(writeGate.isLocked(), false);
  assert.doesNotThrow(() => ctx.storage.appendActivityRecords([{ t: new Date().toISOString(), dur: 5, app: 'code' }]));

  // 失败路径：withMigrationContext 内部抛错，finally 仍要释放
  assert.equal(writeGate.tryAcquire(owner, 'fail'), true);
  assert.throws(() => {
    try {
      writeGate.withMigrationContext(() => { throw new Error('boom'); });
    } finally {
      writeGate.release(owner);
    }
  }, /boom/);
  assert.equal(writeGate.isLocked(), false);

  // 回滚路径
  assert.equal(writeGate.tryAcquire(owner, 'rollback'), true);
  writeGate.release(owner);
  assert.equal(writeGate.isLocked(), false);
  assert.equal(writeGate.getHolder(), null);
});

test('release by a non-owner does not drop the lock', t => {
  const ctx = setup(t);
  ctx.takeLock();
  assert.equal(writeGate.release('someone-else'), false, '非持有者释放必须无效');
  assert.equal(writeGate.isLocked(), true);
  assert.throws(() => ctx.storage.appendActivityRecords([{ t: new Date().toISOString(), dur: 1, app: 'a' }]),
    (err) => err.code === writeGate.ERR);
});

test('withMigrationContext lets migration write while the gate is held', t => {
  const ctx = setup(t);
  ctx.takeLock();
  const before = fs.readFileSync(ctx.todayJsonl, 'utf8');

  writeGate.withMigrationContext(() => {
    assert.doesNotThrow(() => ctx.storage.appendActivityRecords([
      // 必须落在文件已存在的那一天：用本地时间构造，避免 UTC 偏移把记录写到前一天
      { t: ctx.atToday(10), dur: 1000, app: 'code' }
    ]));
  });

  const after = fs.readFileSync(ctx.todayJsonl, 'utf8');
  assert.notEqual(after, before, '迁移上下文内必须能写');
  assert.equal(after.trim().split('\n').length, 2);
});

test('T-M10 flush keeps every buffered segment while locked, without the 200-record truncation', t => {
  const ctx = setup(t);
  const logs = [];
  const recorder = new ActivityRecorder({
    storage: ctx.storage,
    getConfig: () => ({}),
    onLog: (msg) => logs.push(msg)
  });
  t.after(() => recorder.stop());

  // 直接塞 250 段：超过 slice(-200) 的上限，若走了错误分支就会丢 50 段
  const segments = [];
  for (let i = 0; i < 250; i += 1) {
    segments.push({ t: ctx.atToday(9, i % 60), dur: 60000, kind: 'active', app: 'code' });
  }
  recorder._buffer = segments.slice();

  ctx.takeLock();
  const written = recorder.flush();
  assert.equal(written, 0, '迁移期间不落盘');
  assert.equal(recorder._buffer.length, 250, '250 段必须一段不少地留在缓冲里');
  assert.equal(hashFile(ctx.todayJsonl), hashFile(ctx.todayJsonl));

  const fileBefore = fs.readFileSync(ctx.todayJsonl, 'utf8');
  assert.equal(fileBefore.trim().split('\n').length, 1, '迁移期间文件不得增加');

  writeGate.release('test-holder');
  assert.equal(recorder._buffer.length, 0, '锁释放后应主动落盘');
  const rows = fs.readFileSync(ctx.todayJsonl, 'utf8').trim().split('\n');
  assert.equal(rows.length, 251, '原有 1 行 + 250 段');
  assert.ok(logs.some(m => /迁移进行中/.test(m)), '应提示数据暂存内存');
});

test('T-M20 three segments recorded during migration all land afterwards', t => {
  const ctx = setup(t);
  const recorder = new ActivityRecorder({ storage: ctx.storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => recorder.stop());

  ctx.takeLock();
  for (let i = 0; i < 3; i += 1) {
    recorder._buffer.push({ t: ctx.atToday(12, i * 5), dur: 300000, kind: 'active', app: 'code' });
    assert.equal(recorder.flush(), 0);
  }
  assert.equal(recorder._buffer.length, 3);
  // 有 buffer 才会触发 onReleased 的自动 flush，这里显式确认数量
  writeGate.release('test-holder');

  const rows = fs.readFileSync(ctx.todayJsonl, 'utf8').trim().split('\n');
  assert.equal(rows.length, 4, '原有 1 行 + 3 段');
  const apps = rows.map(l => JSON.parse(l)).filter(r => r.app === 'code');
  assert.equal(apps.length, 4);
});

test('a non-gate write error still truncates the buffer to 200 as before', t => {
  const logs = [];
  const brokenStorage = { appendActivityRecords: () => { throw new Error('disk on fire'); } };
  const recorder = new ActivityRecorder({ storage: brokenStorage, getConfig: () => ({}), onLog: (m) => logs.push(m) });
  t.after(() => recorder.stop());

  recorder._buffer = Array.from({ length: 250 }, (_, i) => ({
    t: new Date(Date.UTC(2026, 10, 8, 9, i)).toISOString(), dur: 1000, kind: 'active', app: 'code'
  }));
  assert.equal(recorder.flush(), 0);
  assert.equal(recorder._buffer.length, 200, '普通写失败仍保留上限保护，行为不变');
  assert.ok(logs.some(m => /写入活动记录失败/.test(m)));
});

test('the gate error carries a readable message and its code', () => {
  writeGate._resetForTests();
  const owner = 'm1';
  writeGate.tryAcquire(owner, 'test');
  try {
    assert.throws(() => writeGate.assertWritable('保存活动记录'), (err) => {
      assert.equal(err.code, 'MIGRATION_IN_PROGRESS');
      assert.equal(err.name, 'WriteBlockedError');
      assert.match(err.message, /保存活动记录/);
      assert.match(err.message, /迁移/);
      return true;
    });
  } finally {
    writeGate.release(owner);
  }
});
