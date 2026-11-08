const test = require('node:test');
const assert = require('node:assert/strict');
const { hasSameRange, readPushRecords, liveHasRecord, pushKey } = require('../electron/didaSync');

/*
 * 这一组针对「合并后重复推送」的回归。
 *
 * 现场：13:00 推了一条 1 小时（13:00–14:00），14:00 又推一条（14:00–15:00）。
 * 15:00 时用户把两段合并成 13:00–15:00，此时应当把前两条删掉、只留合并后的那条。
 *
 * 判定依据只能是「时间范围」——内容指纹里含时长，合并后必然变化，
 * 用它当判据就会把旧任务永远留在滴答里。
 */

const at = (h, m = 0) => new Date(2026, 10, 8, h, m, 0).getTime();

test('same range within a minute counts as the same task', () => {
  const rec = { start: at(13), end: at(14) };
  assert.equal(hasSameRange(rec, { start: at(13), end: at(14) }), true);
  // 15 秒误差仍算同一条
  assert.equal(hasSameRange(rec, { start: at(13) + 15000, end: at(14) }), true);
  // 结束时间差一小时，是另一条
  assert.equal(hasSameRange(rec, { start: at(13), end: at(15) }), false);
});

test('a merged interval no longer matches either original record', () => {
  const first = { start: at(13), end: at(14) };
  const second = { start: at(14), end: at(15) };
  const merged = { start: at(13), end: at(15) };
  // 合并之后，前两条都不再与任何当前标注同区间 → 都会被判定为过时
  assert.equal(hasSameRange(first, merged), false);
  assert.equal(hasSameRange(second, merged), false);
});

test('a split interval leaves the original record stale', () => {
  const original = { start: at(13), end: at(15) };
  const left = { start: at(13), end: at(14) };
  const right = { start: at(14), end: at(15) };
  assert.equal(hasSameRange(original, left), false);
  assert.equal(hasSameRange(original, right), false);
});

test('records without a stored range are read but cannot be reconciled', () => {
  const records = readPushRecords({ '2026-11-08:29901000': '2026-11-08T05:00:00.000Z' });
  const rec = records['2026-11-08:29901000'];
  assert.equal(rec.start, null);
  assert.equal(rec.id, '');
  // 没有区间就既判断不了过时、也删不掉，对账阶段必须原样跳过
  assert.equal(rec.end, null);
});

test('readPushRecords normalises v1 and v3 entries side by side', () => {
  const records = readPushRecords({
    '2026-11-08:29901000': '2026-11-08T05:00:00.000Z',                 // v1：只有时间戳
    '2026-11-08:29901060': { id: 'abc123', at: '2026-11-08T06:00:00.000Z', start: at(14), end: at(15), date: '2026-11-08' }
  });
  assert.equal(records['2026-11-08:29901000'].id, '', 'v1 记录没有任务 id');
  assert.equal(records['2026-11-08:29901000'].start, null, 'v1 记录没有区间');
  assert.equal(records['2026-11-08:29901060'].id, 'abc123');
  assert.equal(records['2026-11-08:29901060'].start, at(14));
});

test('an existing record blocks re-pushing the same interval', () => {
  const records = {
    [`${'2026-11-08'}:${Math.round(at(13) / 60000)}`]: { id: 'x', at: '', start: at(13), end: at(14), date: '2026-11-08' }
  };
  const live = { date: '2026-11-08', start: at(13), end: at(14) };
  assert.equal(liveHasRecord(records, live), true);
});

test('a changed interval is pushed again', () => {
  const records = {
    [`${'2026-11-08'}:${Math.round(at(13) / 60000)}`]: { id: 'x', at: '', start: at(13), end: at(14), date: '2026-11-08' }
  };
  // 合并成 13:00–15:00：起点相同但终点变了，必须重新推
  const live = { date: '2026-11-08', start: at(13), end: at(15) };
  assert.equal(liveHasRecord(records, live), false);
});

test('legacy keys still block a duplicate for the same start', () => {
  const records = readPushRecords({
    '2026-11-08:780': '2026-11-08T05:00:00.000Z'
  });
  // v1 记录按「日期 + 起始分钟」兜底比对，避免改造后把老数据重推一遍。
  // 注意 pushKey 用的是 epoch 分钟（和线上 pushed.json 里的写法一致）。
  const live = { date: '2026-11-08', start: at(13), end: at(14) };
  const legacyKey = `${live.date}:${Math.round(live.start / 60000)}`;
  assert.equal(pushKey(live.date, live.start), legacyKey);
  const withLegacy = readPushRecords({ [legacyKey]: '2026-11-08T05:00:00.000Z' });
  assert.equal(liveHasRecord(withLegacy, live), true);
  // 没有这条老记录时不应被拦住
  assert.equal(liveHasRecord(records, live), false);
});
