const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 冲突副本去重（V0.10.3 §4.4，T-R02 / 验收第 3 条）。
 *
 * 目标不是「尽量少重复」，而是「绝不误删」。多留一条重复记录，用户下次还能
 * 发现并处理；错删一条真实记录，那段时间就永远少了一块，而且没有任何提示。
 *
 * 所以这里每种组合都断言具体条数，包括「看起来该去重但不该去重」的那些。
 */

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 必须清缓存：storageManager 在加载时就把 app.getPath 的结果固定下来，
  // 缓存命中会让所有用例共用第一个用例的目录。
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) delete require.cache[key];
  }

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
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });
  return { storage, dir };
}

const AT = new Date(2026, 10, 8, 9, 0, 0).toISOString();
const line = rec => JSON.stringify(rec) + '\n';

function writeMain(dir, rows) {
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), rows.map(line).join(''), 'utf8');
}
function writeCopy(dir, rows) {
  fs.writeFileSync(path.join(dir, '2026-11-08 2.jsonl'), rows.map(line).join(''), 'utf8');
}

function read(storage) {
  return storage.getActivities(new Date(2026, 10, 8, 12));
}

test('same rid in main and copy is merged into one record', t => {
  const { storage, dir } = setup(t);
  writeMain(dir, [{ t: AT, dur: 60000, app: 'code', rid: 'rid-1' }]);
  writeCopy(dir, [{ t: AT, dur: 60000, app: 'code', rid: 'rid-1' }]);

  const rows = read(storage);
  assert.equal(rows.length, 1, '同一条记录出现在两份文件里，只应读一次');
  assert.equal(rows[0].rid, 'rid-1');
});

test('different rids are both kept', t => {
  const { storage, dir } = setup(t);
  writeMain(dir, [{ t: AT, dur: 60000, app: 'main', rid: 'rid-main' }]);
  writeCopy(dir, [{ t: AT, dur: 60000, app: 'copy', rid: 'rid-copy' }]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '不同 rid 是两条不同记录');
  assert.deepEqual(rows.map(r => r.processName).sort(), ['copy', 'main']);
});

test('one side without a rid keeps both', t => {
  const { storage, dir } = setup(t);
  writeMain(dir, [{ t: AT, dur: 60000, app: 'main', rid: 'rid-main' }]);
  writeCopy(dir, [{ t: AT, dur: 60000, app: 'copy' }]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '一方无 rid 时无法确认，必须保留两条');
});

test('neither side having a rid keeps both', t => {
  const { storage, dir } = setup(t);
  writeMain(dir, [{ t: AT, dur: 60000, app: 'main' }]);
  writeCopy(dir, [{ t: AT, dur: 60000, app: 'copy' }]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '历史数据没有 rid，一律保留');
});

test('identical content without rids is still kept as two records', t => {
  const { storage, dir } = setup(t);
  // 内容完全一样，但都没有 rid：这是合法的两条记录，不是重复
  writeMain(dir, [{ t: AT, dur: 60000, app: 'same' }]);
  writeCopy(dir, [{ t: AT, dur: 60000, app: 'same' }]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '绝不能靠内容判断重复');
});

test('duplicates inside a single file are never merged', t => {
  const { storage, dir } = setup(t);
  // 同一文件里两条同 rid：数据已经坏了，但删一条是更坏的处置
  writeMain(dir, [
    { t: AT, dur: 60000, app: 'code', rid: 'rid-1' },
    { t: AT, dur: 60000, app: 'code', rid: 'rid-1' }
  ]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '同文件内的重复一律保留');
});

test('a rid repeated across three copies collapses to one', t => {
  const { storage, dir } = setup(t);
  const rec = { t: AT, dur: 60000, app: 'code', rid: 'rid-1' };
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), line(rec), 'utf8');
  fs.writeFileSync(path.join(dir, '2026-11-08 2.jsonl'), line(rec), 'utf8');
  fs.writeFileSync(path.join(dir, '2026-11-08 3.jsonl'), line(rec), 'utf8');

  const rows = read(storage);
  assert.equal(rows.length, 1, '三份副本里的同一条记录应收敛为一条');
});

test('the four records with identical t/app/dur all survive', t => {
  // 验收第 2 条：t + app + dur 相同的 4 条记录必须读回 4 条
  const { storage, dir } = setup(t);
  const base = { t: AT, dur: 60000, app: 'same', title: 'same' };
  writeMain(dir, [
    { ...base, rid: 'r1' },
    { ...base, rid: 'r2' },
    { ...base, rid: 'r3' },
    { ...base, rid: 'r4' }
  ]);

  const rows = read(storage);
  assert.equal(rows.length, 4, '内容相同但 rid 不同，就是四条记录');
  assert.deepEqual(rows.map(r => r.rid).sort(), ['r1', 'r2', 'r3', 'r4']);
});

test('deduplication does not change the surviving record', t => {
  const { storage, dir } = setup(t);
  const main = { t: AT, dur: 60000, app: 'code', title: '原文', rid: 'rid-1' };
  const copy = { t: AT, dur: 60000, app: 'code', title: '副本里的版本', rid: 'rid-1' };
  writeMain(dir, [main]);
  writeCopy(dir, [copy]);

  const rows = read(storage);
  assert.equal(rows.length, 1);
  // 主文件在前，保留主文件那一份内容
  assert.equal(rows[0].windowTitle, '原文', '保留主文件的版本，而不是副本的');
});

test('a legacy json array record participates without blocking the copy', t => {
  const { storage, dir } = setup(t);
  // 旧版 activities/<date>.json 里的一条无 rid 记录
  fs.writeFileSync(path.join(dir, '2026-11-08.json'),
    JSON.stringify([{ id: 'legacy-1', timestamp: AT, processName: 'legacy' }], null, 2), 'utf8');
  writeMain(dir, [{ t: AT, dur: 60000, app: 'jsonl', rid: 'rid-1' }]);

  const rows = read(storage);
  assert.equal(rows.length, 2, '旧 JSON 与 JSONL 各一条，都要读到');
  assert.deepEqual(rows.map(r => r.processName).sort(), ['jsonl', 'legacy']);
  const legacyRow = rows.find(r => r.processName === 'legacy');
  assert.equal(legacyRow.rid, null, '旧记录没有 rid');
});
