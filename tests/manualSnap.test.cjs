const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const slotRule = require('../electron/slotRule');
const { splitRecordAtMidnight } = require('../electron/timeSplit');

/**
 * 人工补记的 15 分钟口径（方案 §5.5 改造版）。
 *
 * 原来这里有一个人工复刻的 snapCurrent()，把 main.js 的取整算法抄了一遍。
 * 那是最糟的测试形态：生产代码改了，测试里的副本没改，两边一起漂，
 * 而测试仍然是绿的——它验证的只是「副本和自己一致」。
 *
 * 现在直接调用 slotRule，测的就是真正会跑的那份代码。
 * 若 slotRule 改了行为，这里的断言会立刻失败。
 */

const pad = n => String(n).padStart(2, '0');

/** 用真实规则生成一条手工记录，形状与 main.js manualRecordFromPayload 一致 */
function buildRecord(dateStr, startTime, rawDurationMin) {
  const snapped = slotRule.snapRange(dateStr, startTime, rawDurationMin);
  if (snapped.rejected) return { rejected: snapped.reason, message: snapped.message };

  const start = new Date(
    `${dateStr}T${pad(Math.floor(snapped.startMin / 60))}:${pad(snapped.startMin % 60)}:00`
  );
  return {
    snapped,
    record: {
      t: start.toISOString(),
      dur: snapped.durationMin * 60000,
      source: 'manual',
      app: '手工标注',
      title: '',
      kind: 'active'
    }
  };
}

test('snapped duration is always a positive multiple of 15 minutes', () => {
  for (const raw of [15, 16, 22, 30, 45, 59, 60, 121, 600, 1440]) {
    const { record } = buildRecord('2026-11-08', '09:00', raw);
    assert.equal(record.dur % 900000, 0, `raw=${raw} 应吸附到 15 分钟整数倍，实际 ${record.dur / 60000} 分`);
    assert.ok(record.dur >= 900000, `raw=${raw} 不应小于最小单位 15 分钟`);
  }
});

test('snapped start always lands on a quarter-hour boundary', () => {
  for (const time of ['09:00', '09:01', '09:07', '09:14', '09:15', '09:29', '22:59']) {
    const { record } = buildRecord('2026-11-08', time, 15);
    const d = new Date(record.t);
    assert.equal(d.getMinutes() % 15, 0, `${time} 应吸附到 15 分钟刻度，实际 ${d.getMinutes()} 分`);
    assert.equal(d.getSeconds(), 0);
  }
});

test('records shorter than fifteen minutes are refused, not padded to fifteen', () => {
  // 这条原来被标成 KNOWN ISSUE：旧行为是「09:14 + 22min → 09:00，15 分」，
  // 起点前移 14 分钟、时长少记 7 分钟。新规则两端各自就近吸附，并拒绝过短的输入。
  for (const raw of [1, 3, 8, 14]) {
    const out = buildRecord('2026-11-08', '09:07', raw);
    assert.ok(out.rejected, `${raw} 分钟必须被拒绝`);
    assert.equal(out.rejected, 'too-short');
    assert.match(out.message, /最短 15 分钟/);
  }
});

test('both ends snap independently, so the duration is their difference', () => {
  // 09:14 + 22min：起点 09:14 就近到 09:15；终点 09:36 距 09:30 为 6、距 09:45 为 9，
  // 取 09:30，时长 15。这条同时钉住起点和终点——只比时长会漏掉起点漂移。
  const { snapped } = buildRecord('2026-11-08', '09:14', 22);
  assert.equal(snapped.startMin, 555, '09:14 就近到 09:15，不是 09:00');
  assert.equal(snapped.endMin, 570, '09:36 就近到 09:30');
  assert.equal(snapped.durationMin, 15);

  // 用户样例：09:07 + 95min → 09:00-10:45，105 分钟
  const sample = buildRecord('2026-11-08', '09:07', 95).snapped;
  assert.equal(sample.startMin, 540);
  assert.equal(sample.endMin, 645);
  assert.equal(sample.durationMin, 105);
});

test('a distortion is reported when snapping changes the duration', () => {
  const { snapped } = buildRecord('2026-11-08', '09:00', 22);
  assert.equal(snapped.distorted, true, '22 分钟存成 15 分钟必须被标记');
  assert.equal(snapped.rawDurationMin, 22);

  const exact = buildRecord('2026-11-08', '09:00', 15).snapped;
  assert.equal(exact.distorted, false, '本来就对齐的输入不应误报失真');
});

test('an overnight manual record keeps its full duration after splitting', () => {
  const { record } = buildRecord('2026-11-08', '23:45', 30);
  const parts = splitRecordAtMidnight(record);
  assert.equal(parts.length, 2, '跨午夜应拆成两天');
  const total = parts.reduce((sum, p) => sum + p.dur, 0);
  assert.equal(total, record.dur, '拆分不能丢时长');

  const localHM = iso => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  assert.equal(localHM(parts[0].t), '23:45');
  assert.equal(localHM(parts[1].t), '00:00', '次段必须从本地 00:00 开始');
});

test('a start that would snap past midnight is refused rather than date-shifted', () => {
  for (const start of ['23:53', '23:59']) {
    const out = buildRecord('2026-11-08', start, 15);
    assert.ok(out.rejected, `${start} 必须被拒绝`);
    assert.equal(out.rejected, 'start-crosses-day');
    assert.match(out.message, /会改变记录日期/);
  }
  // 23:52 仍然可以，起点留在当天
  const ok = buildRecord('2026-11-08', '23:52', 15);
  assert.equal(ok.rejected, undefined);
  assert.ok(ok.snapped.startMin < 1440);
});

test('manual records survive a storage round trip without being rounded again', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-snap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) delete require.cache[key];
  }
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

  const { record } = buildRecord('2026-11-08', '10:30', 45);
  record.groupId = 'g-snap';
  assert.equal(storage.appendActivityRecords(splitRecordAtMidnight(record)), true);

  const [row] = storage.getActivities('2026-11-08').filter(a => a.source === 'manual');
  assert.ok(row, '补记应可读回');
  assert.equal(row.durationMs, 45 * 60000, '读回时长不应被二次取整');
  assert.equal(new Date(row.timestamp).getMinutes(), 30);
  assert.equal(row.kind, 'active');
});

test('the test uses the same rule object as production, not a copy', () => {
  // 这条防的是「有人又把人肉副本加回来」。
  // 若这里出现第二份取整实现，它与 slotRule 迟早会不一致。
  const src = fs.readFileSync(__filename, 'utf8');
  assert.equal(/function\s+snapCurrent/.test(src), false, '不得再出现复刻函数');
  assert.equal(/Math\.round\([^)]*\/\s*15\s*\)\s*\*\s*15/.test(src), false,
    '测试里不得自己写 15 分钟取整');
  assert.equal(typeof slotRule.snapRange, 'function');
});
