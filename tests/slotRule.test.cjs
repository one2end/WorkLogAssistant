const test = require('node:test');
const assert = require('node:assert/strict');

const slotRule = require('../electron/slotRule');

/**
 * slotRule 纯函数测试（方案 §1.4 全部 11 个用例 + §1.8 六个跨日用例）。
 *
 * 断言方式是「起点 / 终点 / 时长三者同时相等」，不是只比时长。
 * 只比时长会放过「起点和终点一起漂了 15 分钟但时长没变」这类错误——
 * 而那恰好是旧算法最典型的问题（起点向下取整、时长独立就近）。
 */

const { snapStart, deriveEnd, snapEnd, snapRange, findOverlaps, snapToStep, STEP, DAY } = slotRule;

/** 把 snapRange 的结果压成「09:00-10:45 (105分)」便于断言 */
function fmt(r) {
  if (r.rejected) return `拒绝:${r.reason}`;
  return `${r.start}-${r.end} (${r.durationMin}分)`;
}

test('the module exports exactly the interface the plan specifies', () => {
  for (const fn of ['snapStart', 'deriveEnd', 'snapEnd', 'snapRange', 'findOverlaps']) {
    assert.equal(typeof slotRule[fn], 'function', `${fn} 必须导出`);
  }
  assert.equal(STEP, 15, '一格必须是 15 分钟');
  assert.equal(DAY, 1440);
});

test('the module is a pure function library with no runtime dependencies', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../electron/slotRule.js'), 'utf8');
  const requires = src.match(/require\(['"][^'"]+['"]\)/g) || [];
  assert.deepEqual(requires, [], 'slotRule 不应 require 任何模块（无 electron / fs / vue）');
  assert.equal(/globalThis|process\.env/.test(src), false, '不应读取全局状态');
});

// ── §1.4 验收表：11 个用例，逐条对齐 ──────────────────────────────

test('T-D02-01 09:07 + 95min becomes 09:00-10:45, 105 minutes', () => {
  // 用户明确给出的样例，必须是这个结果
  assert.equal(fmt(snapRange('2026-11-08', '09:07', 95)), '09:00-10:45 (105分)');
});

test('09:00 + 15min stays 09:00-09:15', () => {
  assert.equal(fmt(snapRange('2026-11-08', '09:00', 15)), '09:00-09:15 (15分)');
});

test('T-D02-02 09:00 + 22min is saved as 15 minutes and flagged as distorted', () => {
  const r = snapRange('2026-11-08', '09:00', 22);
  assert.equal(fmt(r), '09:00-09:15 (15分)');
  assert.equal(r.distorted, true, '必须标记失真，UI 据此提示');
  assert.equal(r.rawDurationMin, 22);
});

test('09:07 + 35min becomes 09:00-09:45', () => {
  assert.equal(fmt(snapRange('2026-11-08', '09:07', 35)), '09:00-09:45 (45分)');
});

test('09:14 + 15min snaps the start up to 09:15', () => {
  // 旧算法在这里给出 09:00（起点一律向下）；新规则就近 → 09:15
  assert.equal(fmt(snapRange('2026-11-08', '09:14', 15)), '09:15-09:30 (15分)');
});

test('T-D02-05 23:50 + 30min crosses midnight correctly', () => {
  const r = snapRange('2026-11-08', '23:50', 30);
  assert.equal(fmt(r), '23:45-00:15 (30分)');
  assert.equal(r.crossMidnight, true);
});

test('T-D02-04 23:45 + 15min ends exactly at midnight', () => {
  const r = snapRange('2026-11-08', '23:45', 15);
  assert.equal(fmt(r), '23:45-00:00 (15分)');
  assert.equal(r.endMin, DAY, '终点允许等于 1440，表示次日 00:00');
  assert.equal(r.crossMidnight, true);
});

test('09:00 + 1440min spans a full day', () => {
  const r = snapRange('2026-11-08', '09:00', 1440);
  assert.equal(r.rejected, undefined);
  assert.equal(r.durationMin, 1440);
  assert.equal(r.startMin, 540);
  assert.equal(r.endMin, 540 + 1440);
});

// ── §1.6 / T-D02-03：用原始时长判定最短 ──────────────────────────

test('T-D02-03 a 3-minute record is rejected, not inflated to 15', () => {
  const r = snapRange('2026-11-08', '09:07', 3);
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'too-short');
  assert.match(r.message, /最短 15 分钟/);
  assert.match(r.message, /当前 3 分钟/);
});

test('8 and 14 minutes are rejected too - the check runs before snapping', () => {
  for (const d of [1, 7, 8, 14]) {
    const r = snapRange('2026-11-08', '09:07', d);
    assert.equal(r.rejected, true, `${d} 分钟必须被拒绝`);
    assert.equal(r.reason, 'too-short');
  }
});

test('exactly 15 minutes is the boundary and passes', () => {
  const r = snapRange('2026-11-08', '09:00', 15);
  assert.equal(r.rejected, undefined);
  assert.equal(r.durationMin, 15);
});

// ── §1.8 / T-D02-09：起点吸附跨日 ───────────────────────────────

test('T-D02-09 a start that snaps past midnight is rejected, not date-shifted', () => {
  for (const start of ['23:53', '23:59']) {
    const r = snapRange('2026-11-08', start, 15);
    assert.equal(r.rejected, true, `${start} 必须被拒绝`);
    assert.equal(r.reason, 'start-crosses-day');
    assert.match(r.message, /会改变记录日期/);
  }
});

test('T-D02-09 23:45 and 23:52 are still accepted with a start on the same day', () => {
  for (const start of ['23:45', '23:52']) {
    const r = snapRange('2026-11-08', start, 15);
    assert.equal(r.rejected, undefined, `${start} 应当可以通过`);
    assert.ok(r.startMin < DAY, `${start} 的起点必须在当天内`);
  }
  assert.equal(fmt(snapRange('2026-11-08', '23:52', 15)), '23:45-00:00 (15分)');
});

test('T-D02-09 the same two starts also work with 30 minutes', () => {
  assert.equal(fmt(snapRange('2026-11-08', '23:45', 30)), '23:45-00:15 (30分)');
  assert.equal(fmt(snapRange('2026-11-08', '23:52', 30)), '23:45-00:15 (30分)');
  assert.equal(snapRange('2026-11-08', '23:53', 30).reason, 'start-crosses-day');
});

// ── 边界与异常 ────────────────────────────────────────────────

test('ties round away from zero so the rule is deterministic', () => {
  // 正好落在两个刻度中间 → 取较大的（向后）。
  // 22.5 这条尤其关键：浮点下 22.5/15 === 1.4999999999999998，
  // 用 Math.round(x/15)*15 会得到 15，与约定相反。整数运算才能得到 30。
  assert.equal(snapToStep(0), 0);
  assert.equal(snapToStep(7), 0);
  assert.equal(snapToStep(7.5), 15);
  assert.equal(snapToStep(8), 15);
  assert.equal(snapToStep(22), 15);
  assert.equal(snapToStep(22.5), 30, '中间值必须向后取，浮点除法在这里会算错');
  assert.equal(snapToStep(52.5), 60);
  assert.equal(snapToStep(1432), 1425);   // 23:52 → 23:45
  assert.equal(snapToStep(1433), 1440);   // 23:53 → 次日 00:00
});

test('an out-of-range duration is rejected with a clear reason', () => {
  for (const d of [0, -5, 1441, 1.5, NaN]) {
    const r = snapRange('2026-11-08', '09:00', d);
    assert.equal(r.rejected, true, `${d} 应被拒绝`);
    assert.equal(r.reason, 'duration-out-of-range');
  }
});

test('a malformed start time is rejected rather than guessed', () => {
  for (const s of ['', '9', '09:60', '24:00', 'abc', null, undefined, '09-00']) {
    const r = snapRange('2026-11-08', s, 30);
    assert.equal(r.rejected, true, `${JSON.stringify(s)} 应被拒绝`);
    assert.equal(r.reason, 'bad-start-format');
  }
});

test('snapStart reports cross-day and invalid input separately', () => {
  assert.deepEqual(snapStart('2026-11-08', '09:07'), { startMin: 540, crossDay: false });
  assert.deepEqual(snapStart('2026-11-08', '23:53'), { startMin: 1440, crossDay: true });
  const bad = snapStart('2026-11-08', 'nope');
  assert.equal(bad.invalid, true);
  assert.equal(bad.reason, 'bad-start-format');
});

test('deriveEnd only adds, it never snaps', () => {
  assert.deepEqual(deriveEnd(540, 15), { endRaw: 555, crossMidnight: false });
  assert.deepEqual(deriveEnd(1432, 15), { endRaw: 1447, crossMidnight: true });
  // 终点正好等于 1440 就是次日 00:00，属跨日边界
  assert.deepEqual(deriveEnd(1430, 10), { endRaw: 1440, crossMidnight: true });
  assert.deepEqual(deriveEnd(1425, 15), { endRaw: 1440, crossMidnight: true });
  // 差一分钟就到午夜：不跨日
  assert.deepEqual(deriveEnd(1429, 10), { endRaw: 1439, crossMidnight: false });
  // 关键：23:52 的终点 1447 未吸附，跨日判据才准确
  assert.equal(deriveEnd(1432, 15).endRaw, 1447, '终点不能被提前吸附');
});

test('snapEnd preserves the out-of-day offset instead of drifting', () => {
  assert.equal(snapEnd(555).endMin, 555);
  assert.equal(snapEnd(1447).endMin, 1440);   // 次日 00:07 → 00:00
  assert.equal(snapEnd(1470).endMin, 1470);   // 次日 00:30
  assert.equal(snapEnd(1455).endMin, 1455);   // 次日 00:15
  // 若错误地直接对 1455 吸附会得到 1455 也对，但对 1447 会算成 1440，
  // 用 1445..1459 建一组验证偏移不漂
  for (const raw of [1445, 1450, 1455, 1460]) {
    const got = snapEnd(raw).endMin;
    assert.ok(got >= 1440, '跨日终点必须仍在次日');
    assert.equal(got % 15, 0, '必须落在刻度上');
  }
});

test('the duration comes from subtracting the two snapped ends, never re-rounded', () => {
  // 这是本模块最核心的不变量。逐一核对：duration === endMin - startMin
  const cases = [
    ['09:00', 15], ['09:00', 22], ['09:07', 95], ['09:07', 35],
    ['09:14', 15], ['23:50', 30], ['23:45', 15], ['09:00', 1440],
    ['10:03', 47], ['10:08', 8 + 7], ['13:37', 121]
  ];
  for (const [start, dur] of cases) {
    const r = snapRange('2026-11-08', start, dur);
    assert.equal(r.durationMin, r.endMin - r.startMin,
      `${start}+${dur} 的时长必须等于两端相减`);
    assert.equal(r.durationMin % 15, 0, '结果必须落在刻度上');
  }
});

test('snapRange never mutates its inputs', () => {
  const dateStr = '2026-11-08';
  const start = '09:07';
  const dur = 95;
  const before = JSON.stringify([dateStr, start, dur]);
  snapRange(dateStr, start, dur);
  assert.equal(JSON.stringify([dateStr, start, dur]), before);
});

test('snapRange is deterministic - same input, same output, every time', () => {
  const a = snapRange('2026-11-08', '09:07', 95);
  const b = snapRange('2026-11-08', '09:07', 95);
  assert.deepEqual(a, b);
});

test('a non-integer duration is rejected rather than silently floored', () => {
  assert.equal(snapRange('2026-11-08', '09:00', 22.5).reason, 'duration-out-of-range');
  assert.equal(snapRange('2026-11-08', '09:00', '30').rejected, undefined,
    '数字字符串应可用（来自表单）');
});

// ── findOverlaps ─────────────────────────────────────────────

const rec = (t, durMin, extra = {}) => ({
  timestamp: new Date(2026, 10, 8, Math.floor(t / 60), t % 60, 0).toISOString(),
  durationMs: durMin * 60000,
  processName: 'x',
  ...extra
});

test('findOverlaps reports a fully contained record', () => {
  const rows = [rec(10 * 60, 30)];
  const hit = findOverlaps('2026-11-08', 9 * 60, 11 * 60, rows);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 30);
  assert.equal(hit[0].index, 0);
});

test('findOverlaps reports a partial overlap with the right amount', () => {
  const rows = [rec(10 * 60, 60)];  // 10:00-11:00
  const hit = findOverlaps('2026-11-08', 10 * 60, 10 * 60 + 30, rows);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 30);
});

test('touching end-to-start is not an overlap', () => {
  const rows = [rec(10 * 60, 60)];  // 10:00-11:00
  // 09:00-10:00 与它首尾相接
  assert.equal(findOverlaps('2026-11-08', 9 * 60, 10 * 60, rows).length, 0);
  // 11:00-12:00 也首尾相接
  assert.equal(findOverlaps('2026-11-08', 11 * 60, 12 * 60, rows).length, 0);
});

test('findOverlaps handles a record that crosses midnight', () => {
  // 前一天 23:30 起 60 分钟，会延续到当天 00:30
  const late = {
    timestamp: new Date(2026, 10, 7, 23, 30, 0).toISOString(),
    durationMs: 60 * 60000,
    processName: 'late'
  };
  const hit = findOverlaps('2026-11-08', 0, 60, [late]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].overlapMin, 30, '当天 00:00-00:30 这一段重叠');
});

test('findOverlaps distinguishes record layer from display layer', () => {
  const rows = [
    rec(10 * 60, 30),                                   // 自动录制
    rec(10 * 60, 30, { source: 'manual' }),             // 人工补记
    rec(10 * 60, 30, { source: 'imported' })            // 导入标注
  ];
  const hit = findOverlaps('2026-11-08', 10 * 60, 11 * 60, rows);
  assert.equal(hit.length, 3);
  assert.equal(hit[0].kind, 'record', '无 source 属记录层');
  assert.equal(hit[1].kind, 'display', 'manual 属展示层');
  assert.equal(hit[2].kind, 'display', 'imported 属展示层');
});

test('findOverlaps ignores zero-length, empty and malformed records', () => {
  const rows = [
    rec(10 * 60, 0),
    { timestamp: 'not a date', durationMs: 60000 },
    { durationMs: 60000 },
    null
  ];
  assert.equal(findOverlaps('2026-11-08', 0, 1440, rows).length, 0);
});

test('findOverlaps returns an empty list for an inverted or empty range', () => {
  const rows = [rec(10 * 60, 30)];
  assert.deepEqual(findOverlaps('2026-11-08', 660, 660, rows), []);
  assert.deepEqual(findOverlaps('2026-11-08', 700, 600, rows), []);
  assert.deepEqual(findOverlaps('2026-11-08', 0, 1440, []), []);
  assert.deepEqual(findOverlaps('2026-11-08', 0, 1440, null), []);
});

test('findOverlaps never modifies the records it inspects', () => {
  const rows = [rec(10 * 60, 30)];
  const before = JSON.stringify(rows);
  findOverlaps('2026-11-08', 9 * 60, 12 * 60, rows);
  assert.equal(JSON.stringify(rows), before);
});
