const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const analytics = require('../electron/analytics');

/**
 * 展示层「一格算不算有记录」的判定。
 *
 * 核心主张：打开一个软件一秒、扫一眼、关掉，不应该把那个 15 分钟格占住。
 * 那一格是空的，应该留给手工补记——而那正是最该补的地方。
 * 专注与手工标注是用户明确声明过的，整格都算。
 */

function makeDay(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-slot-'));
  const actDir = path.join(dir, 'activities');
  fs.mkdirSync(actDir, { recursive: true });
  fs.writeFileSync(
    path.join(actDir, '2026-11-08.jsonl'),
    records.map(r => JSON.stringify(r)).join('\n') + '\n'
  );
  return dir;
}

// 用本地时间构造时间戳：这里算的是「本地第几格」，不是 UTC 时刻
const at = (h, m) => {
  const d = new Date(2026, 10, 8, h, m, 0, 0);
  return d.toISOString();
};

test('a one-second auto sample does not fill a slot', (t) => {
  const dir = makeDay([
    { t: at(9, 0), dur: 1000, app: 'chrome', title: '打开一下' }
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = analytics.buildDayReport(dir, '2026-11-08', {});
  const slot = report.slots.find(s => s.startMin === 540);   // 09:00

  assert.equal(slot.filledMin, 0, '一秒的采样不该算这一格有记录');
  assert.equal(slot.app, 'chrome', '但应用信息仍要保留，供时间轴展示');
  assert.equal(report.stats.fullSlots, 0);
  assert.ok(report.stats.blankSlotCount > 0, '这一格应算空白，可以手工补记');
});

test('a full slot of auto recording counts as recorded', (t) => {
  const dir = makeDay([
    { t: at(9, 0), dur: 15 * 60000, app: 'chrome', title: '写代码' }
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = analytics.buildDayReport(dir, '2026-11-08', {});
  const slot = report.slots.find(s => s.startMin === 540);

  assert.equal(slot.filledMin, 15, '占满整格就应算有记录');
  assert.equal(report.stats.fullSlots, 1);
});

test('a manual annotation fills its slot regardless of length', (t) => {
  const dir = makeDay([
    { t: at(9, 0), dur: 15 * 60000, kind: 'active', app: '睡觉', title: '午睡', source: 'manual', cat: '睡眠' }
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = analytics.buildDayReport(dir, '2026-11-08', {});
  const slot = report.slots.find(s => s.startMin === 540);

  assert.equal(slot.filledMin, 15, '手工标注整格都算');
  assert.equal(slot.layer, 'manual');
});

test('a focus session fills its slot even when short', (t) => {
  // 专注会话来自 arhat/sessions 或 dida 镜像，不是 activities 文件
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const focusDir = path.join(dir, 'arhat', 'sessions');
  fs.mkdirSync(focusDir, { recursive: true });
  const start = new Date(2026, 10, 8, 9, 0, 0, 0);
  fs.writeFileSync(path.join(focusDir, '2026-11-08.json'), JSON.stringify([
    { id: 'f1', startTime: start.toISOString(), durationMs: 3 * 60000, focusText: '写方案' }
  ]));

  const report = analytics.buildDayReport(dir, '2026-11-08', {});
  const slot = report.slots.find(s => s.startMin === 540);

  assert.equal(slot.filledMin, 15, '专注是用户明确声明过的，整格都算');
  assert.equal(slot.layer, 'focus');
});

test('a sparse auto slot stays available for manual annotation', (t) => {
  const dir = makeDay([
    { t: at(9, 0), dur: 60 * 1000, app: 'explorer', title: '看一眼' }
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = analytics.buildDayReport(dir, '2026-11-08', {});
  const s = report.stats;

  assert.equal(s.fullSlots, 0, '没占满的格不算已记录');
  assert.equal(s.partialSlots, 0, '也不该再出现「没记满」这种中间状态');
  assert.ok(s.blankSlotCount > 0, '这一格应算空白，可以手工补记');
  assert.ok(s.blankRanges.length > 0, '应能找出连续的空白段');
  // 空白段覆盖到 09:00 这一格
  assert.ok(
    s.blankRanges.some(r => r.startMin <= 540 && r.endMin > 540),
    '09:00 这一格应落在空白段内'
  );
});
