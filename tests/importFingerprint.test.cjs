const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeFingerprint,
  FINGERPRINT_VERSION,
  VOLATILE_BY_TYPE,
  isComparable,
  fingerprintId
} = require('../electron/importFingerprint');

/**
 * 指纹测试（T-I05 ~ T-I08）。
 *
 * 指纹只有一个用途：判断「这份文件导过没有」。所以这里关心的不是哈希值本身，
 * 而是它的两个边界：**该变的必须变**（否则漏判成已导入，丢数据），
 * **不该变的必须不变**（否则误判成新文件，重复导入）。
 */

const fp = src => computeFingerprint(src).fingerprint;

function baseSource() {
  return {
    version: '1.0',
    exportDate: '2026-11-12T01:00:00Z',
    activities: [
      { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code', windowTitle: '编辑', durationMs: 600000 },
      { timestamp: '2026-11-05T02:00:00.000Z', processName: 'chrome', windowTitle: '文档', durationMs: 300000 }
    ],
    summaries: [
      { timestamp: '2026-11-05T13:00:00.000Z', summary: '今天做了两件事', activityCount: 12 }
    ],
    arhatSessions: [{ id: 'x', note: '不该参与' }],
    arhatNotes: [{ title: '也不该参与' }],
    config: { theme: 'dark' }
  };
}

test('T-I05 the fingerprint covers every non-volatile field', () => {
  const cases = [
    ['top-level activity field', s => { s.activities[0].durationMs = 900000; }],
    ['window title', s => { s.activities[0].windowTitle = '改了标题'; }],
    ['process name', s => { s.activities[1].processName = 'excel'; }],
    ['a field added to an activity', s => { s.activities[0].note = '新增备注'; }],
    ['a category field', s => { s.activities[0].cat = '工作'; }],
    ['summary text', s => { s.summaries[0].summary = '改了一个字'; }],
    ['summary count', s => { s.summaries[0].activityCount = 13; }],
    ['an extra record', s => { s.activities.push({ timestamp: '2026-11-06T01:00:00.000Z', processName: 'new' }); }],
    ['a removed record', s => { s.activities.pop(); }]
  ];

  for (const [label, mutate] of cases) {
    const a = baseSource();
    const b = baseSource();
    mutate(b);
    assert.notEqual(fp(a), fp(b), `改动「${label}」后指纹必须变化`);
  }
});

test('T-I05 a nested id inside slots participates in the fingerprint', () => {
  // v3 的错误是全局排除 id，把嵌套里的合法 id 也抹掉了。
  const a = baseSource();
  a.summaries[0].slots = [{ id: 'slot-1', label: '上午' }, { id: 'slot-2', label: '下午' }];
  const b = baseSource();
  b.summaries[0].slots = [{ id: 'slot-1', label: '上午' }, { id: 'slot-CHANGED', label: '下午' }];

  assert.notEqual(fp(a), fp(b), '嵌套 slots[].id 是内容，必须参与指纹');
});

test('T-I05 a nested field change is detected at any depth', () => {
  const make = deep => {
    const s = baseSource();
    s.activities[0].meta = { a: { b: { c: deep } } };
    return fp(s);
  };
  assert.notEqual(make('x'), make('y'), '深层嵌套的变化也必须被发现');
});

test('T-I07 only activities and summaries are fingerprinted', () => {
  const cases = [
    ['arhatSessions', s => { s.arhatSessions = [{ id: 'y', note: '不同' }]; }],
    ['arhatNotes', s => { s.arhatNotes.push({ title: '新笔记' }); }],
    ['config', s => { s.config = { theme: 'light', customPath: 'D:/x' }; }],
    ['exportDate', s => { s.exportDate = '2026-12-31T23:59:59Z'; }],
    ['version', s => { s.version = '2.0'; }],
    ['summariesMd', s => { s.summariesMd = [{ path: 'a.md' }]; }]
  ];

  const base = fp(baseSource());
  for (const [label, mutate] of cases) {
    const s = baseSource();
    mutate(s);
    assert.equal(fp(s), base, `只改「${label}」时指纹必须不变——它并没有被导入`);
  }
});

test('T-I06 array order and legitimate duplicates are preserved', () => {
  const one = baseSource();
  const two = baseSource();
  // 两条完全相同的记录：这是合法数据，不是重复
  two.activities = [one.activities[0], { ...one.activities[0] }];
  assert.notEqual(fp(one), fp(two), '多一条相同记录必须改变指纹');

  const dupA = baseSource();
  dupA.activities = [{ timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' },
    { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' }];
  const dupB = baseSource();
  dupB.activities = [{ timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' },
    { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' }];
  assert.equal(fp(dupA), fp(dupB), '两条相同的记录应稳定算出同一指纹');

  // 顺序调换必须改变指纹：两条不同的记录换位，内容集合相同但顺序不同
  const recA = { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' };
  const recB = { timestamp: '2026-11-05T02:00:00.000Z', processName: 'chrome' };

  const inOrder = baseSource();
  inOrder.activities = [recA, recB];
  const reversed = baseSource();
  reversed.activities = [recB, recA];

  assert.notEqual(fp(inOrder), fp(reversed), '记录顺序本身是内容');
});

test('duplicated records count twice — the fingerprint does not deduplicate', () => {
  const one = baseSource();
  one.activities = [{ timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' }];
  const two = baseSource();
  two.activities = [
    { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' },
    { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code' }
  ];
  const r1 = computeFingerprint(one);
  const r2 = computeFingerprint(two);
  assert.equal(r1.activityCount, 1);
  assert.equal(r2.activityCount, 2);
  assert.notEqual(r1.fingerprint, r2.fingerprint);
});

test('T-I05 volatile fields are excluded at the top level only', () => {
  const a = baseSource();
  a.activities[0].id = 'aa#1';
  a.activities[0].editedAt = '2026-11-06T00:00:00Z';
  a.summaries[0].id = 'summary-1';
  const b = baseSource();

  assert.equal(fp(a), fp(b), 'id / editedAt 属于 volatile，不参与指纹');

  // 但同一个键在嵌套层出现时，必须参与
  const c = baseSource();
  c.activities[0].nested = { id: 'inner-1' };
  const d = baseSource();
  d.activities[0].nested = { id: 'inner-2' };
  assert.notEqual(fp(c), fp(d), '嵌套层的 id 不是 volatile');
});

test('key insertion order does not change the fingerprint', () => {
  const a = baseSource();
  a.activities[0] = { timestamp: '2026-11-05T01:00:00.000Z', processName: 'code', note: 'n' };
  const b = baseSource();
  b.activities[0] = { processName: 'code', note: 'n', timestamp: '2026-11-05T01:00:00.000Z' };
  assert.equal(fp(a), fp(b), '对象键序不应影响指纹');
});

test('T-I08 a mismatched fingerprint version is not treated as comparable', () => {
  const src = baseSource();
  const v4 = computeFingerprint(src);
  assert.equal(v4.version, FINGERPRINT_VERSION);

  const asOld = { fingerprint: v4.fingerprint, fingerprintVersion: 3 };
  assert.equal(isComparable(asOld), false, '旧版本指纹不能用来判定已导入');

  const asCurrent = { fingerprint: v4.fingerprint, fingerprintVersion: FINGERPRINT_VERSION };
  assert.equal(isComparable(asCurrent), true);

  assert.equal(isComparable(null), false);
  assert.equal(isComparable({}), false, '缺少版本号视为无法确认');
});

test('a different version yields a different fingerprint', () => {
  const src = baseSource();
  const v4 = computeFingerprint(src, { version: 4 });
  const v5 = computeFingerprint(src, { version: 5 });
  assert.notEqual(v4.fingerprint, v5.fingerprint, '版本号参与哈希，不能混用');
});

test('an empty file still produces a stable fingerprint', () => {
  const a = computeFingerprint({});
  const b = computeFingerprint({ activities: [], summaries: [] });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.activityCount, 0);
  assert.equal(a.summaryCount, 0);
});

test('the short id is a stable prefix used for task file names', () => {
  const { fingerprint } = computeFingerprint(baseSource());
  assert.equal(fingerprintId(fingerprint).length, 16);
  assert.equal(fingerprintId(fingerprint), fingerprint.slice(0, 16));
  assert.match(fingerprintId(fingerprint), /^[0-9a-f]{16}$/);
});

test('volatile sets only name fields that were verified against the code', () => {
  assert.deepEqual(Array.from(VOLATILE_BY_TYPE.activity).sort(), ['editedAt', 'id']);
  assert.deepEqual(Array.from(VOLATILE_BY_TYPE.summary).sort(), ['generatedAt', 'id']);
});
