const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const slotRule = require('../electron/slotRule');

/**
 * 重叠检测（方案 §5.3 / §5.4，P3）。
 *
 * 目标不是「去掉重复」，而是分清三件不同的事：
 *   1. 时间格展示冲突 —— 两块在时间轴上叠在一起
 *   2. 原始记录时间重叠 —— 两段真实采样确实有交集（可能是真的）
 *   3. 不同来源之间的优先级 —— 展示层覆盖记录层，但记录层不动
 *
 * 最关键的硬约束（方案 §5.4）：原始自动记录在任何操作前后**逐字节一致**。
 * 这里的用例直接比对记录文件的 SHA，而不是「条数没变」。
 */

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rec = (hour, min, durMin, extra = {}) => ({
  t: new Date(2026, 10, 8, hour, min, 0).toISOString(),
  dur: durMin * 60000,
  kind: 'active',
  app: 'code',
  title: 'x',
  ...extra
});

/** 转成 findOverlaps 需要的记录形状 */
const toRead = r => ({
  timestamp: r.t,
  durationMs: r.dur,
  processName: r.app,
  windowTitle: r.title,
  source: r.source || 'auto'
});

test('two identical spans overlap completely', () => {
  const rows = [toRead(rec(9, 0, 60))];
  const hit = slotRule.findOverlaps('2026-11-08', 540, 600, rows);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 60, '完全重叠应为整段时长');
});

test('a partial overlap reports only the shared minutes', () => {
  const rows = [toRead(rec(9, 0, 60))];   // 09:00-10:00
  const hit = slotRule.findOverlaps('2026-11-08', 570, 660, rows); // 09:30-11:00
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 30);
});

test('touching spans are not an overlap', () => {
  const rows = [toRead(rec(9, 0, 60))];   // 09:00-10:00
  assert.equal(slotRule.findOverlaps('2026-11-08', 600, 660, rows).length, 0, '10:00 起不算重叠');
  assert.equal(slotRule.findOverlaps('2026-11-08', 480, 540, rows).length, 0, '09:00 止不算重叠');
});

test('an overnight span overlaps the early hours of the next day', () => {
  const late = {
    timestamp: new Date(2026, 10, 8, 23, 30, 0).toISOString(),
    durationMs: 90 * 60000,     // 到次日 01:00
    processName: 'late',
    source: 'auto'
  };
  const hit = slotRule.findOverlaps('2026-11-09', 0, 120, [late]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 60, '次日 00:00-01:00 共 60 分钟重叠');
});

test('overlap detection separates record layer from display layer', () => {
  const rows = [
    toRead(rec(9, 0, 30)),                             // 自动采样
    toRead(rec(9, 0, 30, { source: 'manual' })),       // 人工补记
    toRead(rec(9, 0, 30, { source: 'imported' }))      // 导入标注
  ];
  const hit = slotRule.findOverlaps('2026-11-08', 540, 600, rows);
  assert.equal(hit.length, 3);

  const records = hit.filter(h => h.kind === 'record');
  const display = hit.filter(h => h.kind === 'display');
  assert.equal(records.length, 1, '无 source 的属记录层');
  assert.equal(display.length, 2, 'manual 与 imported 属展示层');
});

test('the same source repeated is reported twice, not deduplicated', () => {
  // 同一时间同一来源两条记录：这是两个真实采样，不是重复
  const rows = [
    toRead(rec(9, 0, 30)),
    toRead(rec(9, 0, 30))
  ];
  const hit = slotRule.findOverlaps('2026-11-08', 540, 600, rows);
  assert.equal(hit.length, 2, '重叠检测只报告相交，不做去重');
});

test('a zero-length or malformed record never counts as an overlap', () => {
  const rows = [
    { timestamp: rec(9, 0, 0).t, durationMs: 0, source: 'auto' },
    { timestamp: 'invalid', durationMs: 60000 },
    { durationMs: 60000 },
    null
  ];
  assert.equal(slotRule.findOverlaps('2026-11-08', 0, 1440, rows).length, 0);
});

test('overlap detection does not mutate the records it reads', () => {
  const rows = [toRead(rec(9, 0, 60))];
  const before = JSON.stringify(rows);
  slotRule.findOverlaps('2026-11-08', 0, 1440, rows);
  assert.equal(JSON.stringify(rows), before);
});

// ── 硬约束：记录层逐字节不变 ────────────────────────────────

test('overlap inspection never touches the record files on disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dir = path.join(root, 'Data', 'activities');
  fs.mkdirSync(dir, { recursive: true });

  // 原始自动采样，毫秒级时长带零头
  const original = JSON.stringify({ t: rec(9, 0, 0).t, dur: 1234567, app: 'code', title: 'raw' }) + '\n';
  const file = path.join(dir, '2026-11-08.jsonl');
  fs.writeFileSync(file, original, 'utf8');
  const before = sha(file);

  // 一批重叠检测跑下来
  const rows = [{ timestamp: rec(9, 0, 0).t, durationMs: 1234567, processName: 'code', source: 'auto' }];
  for (const span of [[540, 600], [500, 700], [0, 1440], [560, 565]]) {
    slotRule.findOverlaps('2026-11-08', span[0], span[1], rows);
  }

  assert.equal(sha(file), before, '检测前后文件必须逐字节一致');
  assert.equal(fs.readFileSync(file, 'utf8'), original, '内容也不能有任何变化');
});

test('a manual record written over an auto sample leaves the sample intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-cover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) delete require.cache[key];
  }
  const Module = require('node:module');
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, '2026-11-08.jsonl');
  const rawLine = JSON.stringify({
    t: rec(9, 0, 0).t, dur: 1234567, app: 'code', title: 'raw'
  });
  fs.writeFileSync(file, rawLine + '\n', 'utf8');
  const before = sha(file);

  // 在同一时段补一条人工记录
  storage.appendActivityRecords([{
    t: rec(9, 0, 0).t,
    dur: 15 * 60000,
    kind: 'active',
    app: '手工标注',
    title: '',
    source: 'manual',
    rid: 'manual-rid'
  }]);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '补记是追加，不是替换');
  assert.equal(lines[0], rawLine, '原始采样那一行必须逐字节不变');
  assert.notEqual(sha(file), before, '文件整体因追加而变，但原有行不变');

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.dur, 1234567, '毫秒级时长不能因补记被取整');
});
