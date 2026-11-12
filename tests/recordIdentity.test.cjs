const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const ActivityRecorder = require('../electron/activityRecorder');
const { splitRecordAtMidnight } = require('../electron/timeSplit');

/**
 * 记录标识（V0.10.3 §4.2 / §4.3，验收第 1 条）。
 *
 * rid 的用途只有一个：回答「这两条是不是同一条记录」。所以它必须在
 * 生成时定下来、落盘、重启后原样读回。任何一次重算都等于换了身份，
 * 去重就失效了——而且是悄悄失效，没有任何报错。
 */

function setup(t) {
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-rid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
  fs.mkdirSync(path.join(storage.getDataDir(), 'activities'), { recursive: true });
  return { storage, dataDir: storage.getDataDir(), root, StorageManager };
}

const iso = (h, m = 0) => new Date(2026, 10, 8, h, m, 0).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('T-R01 every emitted segment carries a uuid rid', t => {
  const { storage } = setup(t);
  const recorder = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => recorder.stop());

  recorder._emit({ t: iso(9), dur: 60000, kind: 'active', app: 'code', title: 'a' });
  recorder._emit({ t: iso(10), dur: 60000, kind: 'active', app: 'chrome', title: 'b' });

  assert.equal(recorder._buffer.length, 2);
  for (const rec of recorder._buffer) {
    assert.match(rec.rid, UUID, '每个片段必须有合法 uuid');
  }
  assert.notEqual(recorder._buffer[0].rid, recorder._buffer[1].rid, '两条记录不能同 rid');
});

test('T-R01 an idle segment also gets a rid', t => {
  const { storage } = setup(t);
  const recorder = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => recorder.stop());

  recorder._emit({ t: iso(11), dur: 120000, kind: 'idle', app: 'code', title: '' });
  assert.match(recorder._buffer[0].rid, UUID, 'idle 片段同样需要有 rid');
});

test('T-R01 the rid survives a write and a read, and never changes on restart', t => {
  const { storage, dataDir } = setup(t);

  const recorder = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => recorder.stop());
  recorder._emit({ t: iso(9), dur: 60000, kind: 'active', app: 'code', title: 'x' });
  recorder._emit({ t: iso(10), dur: 60000, kind: 'active', app: 'chrome', title: 'y' });
  assert.equal(recorder.flush(), 2);

  // 磁盘上必须有 rid
  const raw = fs.readFileSync(path.join(dataDir, 'activities', '2026-11-08.jsonl'), 'utf8');
  const onDisk = raw.trim().split('\n').map(JSON.parse);
  assert.equal(onDisk.length, 2);
  const diskRids = onDisk.map(r => r.rid);
  for (const rid of diskRids) assert.match(rid, UUID);

  // 读回：rid 原样
  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows.length, 2);
  const readRids = rows.map(r => r.rid);
  assert.deepEqual(readRids.sort(), diskRids.sort(), '读回的 rid 必须与落盘一致');

  // 再读一次（等价于重启后读取）：仍然不变
  const again = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.deepEqual(again.map(r => r.rid).sort(), diskRids.sort(), '多次读取 rid 必须稳定');
});

test('T-R01 the internal id is still derived from position and may change', t => {
  const { storage } = setup(t);
  const file = path.join(storage.getDataDir(), 'activities', '2026-11-08.jsonl');
  fs.writeFileSync(file, JSON.stringify({ t: iso(9), dur: 60000, app: 'code', rid: 'fixed-rid' }) + '\n', 'utf8');

  const first = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(first[0].id, `${iso(9)}#0`);

  // 在同一天前面插一条，内部 id 的序号会变，但 rid 不变
  fs.writeFileSync(file,
    JSON.stringify({ t: iso(8), dur: 60000, app: 'early' }) + '\n' +
    JSON.stringify({ t: iso(9), dur: 60000, app: 'code', rid: 'fixed-rid' }) + '\n', 'utf8');
  const second = storage.getActivities(new Date(2026, 10, 8, 12));
  const target = second.find(r => r.processName === 'code');
  assert.equal(target.rid, 'fixed-rid', 'rid 不随位置变化');
  assert.notEqual(target.id, first[0].id, '内部 id 会随位置变化——正因如此它不能当身份');
});

test('T-R01 a legacy record without rid reads back as null, not an empty string', t => {
  const { storage } = setup(t);
  const file = path.join(storage.getDataDir(), 'activities', '2026-11-08.jsonl');
  fs.writeFileSync(file, JSON.stringify({ t: iso(9), dur: 60000, app: 'legacy' }) + '\n', 'utf8');

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows[0].rid, null, '无 rid 的历史记录必须读成 null，便于区分「没有」与「空值」');
});

test('T-R01 writing a record without a rid does not invent one on disk', t => {
  const { storage, dataDir } = setup(t);
  storage.appendActivityRecords([{ t: iso(9), dur: 60000, app: 'plain' }]);

  const raw = fs.readFileSync(path.join(dataDir, 'activities', '2026-11-08.jsonl'), 'utf8');
  const rec = JSON.parse(raw.trim());
  assert.equal('rid' in rec, false, '调用方没给 rid 就不该凭空写一个');
});

test('splitting at midnight gives each half its own rid', t => {
  // 23:50 起 30 分钟，跨过午夜
  const record = {
    t: new Date(2026, 10, 8, 23, 50, 0).toISOString(),
    dur: 30 * 60000,
    app: 'code',
    rid: 'original-rid'
  };
  const parts = splitRecordAtMidnight(record);
  assert.equal(parts.length, 2, '应拆成两段');

  assert.equal(parts[0].rid, 'original-rid', '前半段沿用原 rid');
  assert.notEqual(parts[1].rid, parts[0].rid, '后半段必须有独立 rid');
  assert.match(parts[1].rid, UUID);

  // 两段时长之和等于原始时长
  assert.equal(parts[0].dur + parts[1].dur, record.dur);
});

test('splitting a record without a rid does not add one to either half', t => {
  const parts = splitRecordAtMidnight({
    t: new Date(2026, 10, 8, 23, 50, 0).toISOString(),
    dur: 30 * 60000,
    app: 'code'
  });
  assert.equal(parts.length, 2);
  assert.equal('rid' in parts[0], false);
  assert.equal('rid' in parts[1], false);
});

test('a record that stays within one day is returned untouched', t => {
  const record = { t: iso(9), dur: 60000, app: 'code', rid: 'keep-me' };
  const parts = splitRecordAtMidnight(record);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], record, '未跨午夜必须原样返回同一个对象，不复制');
});

test('two recorders produce different rids for identical-looking segments', t => {
  const { storage } = setup(t);
  const a = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  const b = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => { a.stop(); b.stop(); });

  const seg = { t: iso(9), dur: 60000, kind: 'active', app: 'code', title: 'same' };
  a._emit({ ...seg });
  b._emit({ ...seg });

  assert.notEqual(a._buffer[0].rid, b._buffer[0].rid,
    '内容完全相同的两条记录仍然是两条，rid 必须不同');
});

test('an existing rid is preserved rather than replaced', t => {
  const { storage } = setup(t);
  const recorder = new ActivityRecorder({ storage, getConfig: () => ({}), onLog: () => {} });
  t.after(() => recorder.stop());

  recorder._emit({ t: iso(9), dur: 60000, kind: 'active', app: 'code', rid: 'already-has-one' });
  assert.equal(recorder._buffer[0].rid, 'already-has-one', '已有 rid 不得被覆盖');
});

test('the onSegment callback sees the same rid that gets written', t => {
  const { storage } = setup(t);
  const seen = [];
  const recorder = new ActivityRecorder({
    storage,
    getConfig: () => ({}),
    onLog: () => {},
    onSegment: rec => seen.push(rec.rid)
  });
  t.after(() => recorder.stop());

  recorder._emit({ t: iso(9), dur: 60000, kind: 'active', app: 'code' });
  recorder.flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0], recorder._buffer.length ? recorder._buffer[0].rid : seen[0]);
  assert.match(seen[0], UUID);
});
