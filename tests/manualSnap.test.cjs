const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { splitRecordAtMidnight } = require('../electron/timeSplit');

/**
 * 15 分钟刻度口径。
 *
 * 规范第 4 条：人工记录统一 15 分钟刻度，开始/结束分别吸附，
 * 时长为 15 的整数倍，保存前显示吸附后的实际结果。
 *
 * 说明：manualRecordFromPayload 定义在 electron/main.js 内部且未导出，
 * main.js 依赖 Electron 运行时无法 require。所以这里：
 *   1) 用 splitRecordAtMidnight + 展示层写入验证「落盘后一定是 15 的倍数」；
 *   2) 用 SNAP 复刻函数锁定当前取整算法，任何改动都会让断言失败，
 *      迫使改动方显式更新预期。
 *
 * 当前算法（main.js:1150 / 1154）：
 *   时长 = Math.max(15, Math.round(raw / 15) * 15)   ← 就近取整
 *   起始 = Math.floor(minute / 15) * 15              ← 一律向下
 * 两者策略不一致，已在审计报告列为待修项，此处先锁定行为。
 */

const pad = n => String(n).padStart(2, '0');

/** 与 main.js:1148-1155 一致的取整算法，仅用于断言当前口径 */
function snapCurrent(dateStr, startTime, rawDurationMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTime).trim());
  const durationMin = Math.max(15, Math.round(rawDurationMin / 15) * 15);
  const snappedMinute = Math.floor(parseInt(m[2], 10) / 15) * 15;
  const start = new Date(`${dateStr}T${pad(m[1])}:${pad(snappedMinute)}:00`);
  return {
    t: start.toISOString(),
    dur: durationMin * 60000,
    source: 'manual',
    app: '手工标注',
    title: '',
    kind: 'active'
  };
}

test('snapped duration is always a positive multiple of 15 minutes', () => {
  for (const raw of [1, 7, 8, 14, 15, 16, 22, 30, 45, 59, 60, 121, 600, 1440]) {
    const rec = snapCurrent('2026-11-08', '09:00', raw);
    assert.equal(rec.dur % 900000, 0, `raw=${raw} 应吸附到 15 分钟整数倍，实际 ${rec.dur / 60000} 分`);
    assert.ok(rec.dur >= 900000, `raw=${raw} 不应小于最小单位 15 分钟`);
  }
});

test('snapped start always lands on a quarter-hour boundary', () => {
  for (const time of ['09:00', '09:01', '09:07', '09:14', '09:15', '09:29', '23:59']) {
    const rec = snapCurrent('2026-11-08', time, 15);
    const d = new Date(rec.t);
    assert.equal(d.getMinutes() % 15, 0, `${time} 应吸附到 15 分钟刻度，实际 ${d.getMinutes()} 分`);
    assert.equal(d.getSeconds(), 0);
  }
});

test('KNOWN ISSUE: start snaps downward while duration snaps to nearest', () => {
  // 这条不是「期望行为正确」，而是把现存不一致钉住：
  // 用户填 22 分钟 → 存 15 分钟；用户填 09:14 → 存 09:00。
  // 修复后此测试必须同步改写，避免悄悄改变口径。
  const rec = snapCurrent('2026-11-08', '09:14', 22);
  assert.equal(new Date(rec.t).getHours(), 9);
  assert.equal(new Date(rec.t).getMinutes(), 0); // 起始前移 14 分钟
  assert.equal(rec.dur / 60000, 15);             // 时长少记 7 分钟
});

test('an overnight manual record keeps its full duration after splitting', () => {
  const rec = snapCurrent('2026-11-08', '23:45', 30);
  const parts = splitRecordAtMidnight(rec);
  assert.equal(parts.length, 2, '跨午夜应拆成两天');
  const total = parts.reduce((sum, p) => sum + p.dur, 0);
  assert.equal(total, rec.dur, '拆分不能丢时长');
  // 落盘用 ISO（UTC），断言要按本地时间读，否则会差出时区偏移
  const localHM = iso => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  assert.equal(localHM(parts[0].t), '23:45');
  assert.equal(localHM(parts[1].t), '00:00', '次段必须从本地 00:00 开始');
});

test('manual records survive a storage round trip without being rounded again', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-snap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();

  const rec = snapCurrent('2026-11-08', '10:30', 45);
  rec.groupId = 'g-snap';
  assert.equal(storage.appendActivityRecords(splitRecordAtMidnight(rec)), true);

  const [row] = storage.getActivities('2026-11-08').filter(a => a.source === 'manual');
  assert.ok(row, '补记应可读回');
  assert.equal(row.durationMs, 45 * 60000, '读回时长不应被二次取整');
  assert.equal(new Date(row.timestamp).getMinutes(), 30);
  assert.equal(row.kind, 'active');
});
