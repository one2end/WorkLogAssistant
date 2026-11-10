const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('replacing a display range keeps raw facts and commits one new annotation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const file = path.join(storage.getDataDir(), 'activities', '2026-11-08.jsonl');
  const at = time => new Date(`2026-11-08T${time}:00`).toISOString();
  fs.writeFileSync(file, [
    { t: at('09:00'), dur: 3600000, app: 'chrome', title: 'Fact' },
    { t: at('09:15'), dur: 1800000, app: 'Old', source: 'manual' }
  ].map(JSON.stringify).join('\n') + '\n');
  const newRecord = { t: at('09:15'), dur: 1800000, app: 'New', source: 'manual' };
  const result = storage.replaceDisplayRanges('2026-11-08',
    [{ start: at('09:15'), end: at('09:45') }], newRecord);
  assert.equal(result.success, true);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Fact');
  assert.equal(rows[1].app, 'New');
});

test('editing either half of an overnight fact updates both dates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-overnight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const at = (day, time) => new Date(`${day}T${time}:00`).toISOString();
  const original = { t: at('2026-11-10', '22:00'), dur: 600 * 60000, app: 'Sleep', source: 'manual', groupId: 'overnight-a' };
  const { splitRecordAtMidnight } = require('../electron/timeSplit');
  assert.equal(storage.appendActivityRecords(splitRecordAtMidnight(original)), true);
  const replacement = { t: at('2026-11-10', '23:00'), dur: 540 * 60000, app: 'Rest', source: 'manual', groupId: 'overnight-b' };
  assert.equal(storage.replaceDisplayRanges('2026-11-10', [{ start: at('2026-11-10', '22:00'), end: at('2026-11-11', '00:00') }], replacement).success, true);
  const read = day => fs.readFileSync(path.join(storage.getDataDir(), 'activities', `${day}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(read('2026-11-10').map(r => [r.app, r.dur]), [['Rest', 60 * 60000]]);
  assert.deepEqual(read('2026-11-11').map(r => [r.app, r.dur]), [['Rest', 480 * 60000]]);
  const analytics = require('../electron/analytics');
  const nextReport = analytics.buildDayReport(storage.getDataDir(), '2026-11-11', {});
  assert.equal(nextReport.slots.find(slot => slot.startMin === 480).filledMin, 0);
  assert.equal(nextReport.slots.find(slot => slot.startMin === 465).filledMin, 15);
  const secondHalf = { t: at('2026-11-11', '00:00'), dur: 420 * 60000, app: 'Late rest', source: 'manual', groupId: 'overnight-c' };
  assert.equal(storage.replaceDisplayRanges('2026-11-11', [{ start: at('2026-11-11', '00:00'), end: at('2026-11-11', '08:00') }], secondHalf).success, true);
  assert.deepEqual(read('2026-11-10').map(r => [r.app, r.dur]), [['Rest', 60 * 60000]]);
  assert.deepEqual(read('2026-11-11').map(r => [r.app, r.dur]), [['Late rest', 420 * 60000]]);
});

test('legacy unsplit overnight record remains visible on the next day', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-legacy-night-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activities = path.join(root, 'activities');
  fs.mkdirSync(activities);
  const start = new Date('2026-11-10T21:00:00').toISOString();
  fs.writeFileSync(path.join(activities, '2026-11-10.jsonl'),
    JSON.stringify({ t: start, dur: 255 * 60000, app: 'Rest', source: 'manual', cat: '生活' }) + '\n');
  const report = require('../electron/analytics').buildDayReport(root, '2026-11-11', {});
  assert.equal(report.slots.find(slot => slot.startMin === 0).filledMin, 15);
  assert.equal(report.slots.find(slot => slot.startMin === 60).filledMin, 15);
  assert.equal(report.slots.find(slot => slot.startMin === 75).filledMin, 0);
});

test('editing the next-day half of a legacy record preserves its first-day half', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-legacy-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const at = (day, time) => new Date(`${day}T${time}:00`).toISOString();
  const firstFile = path.join(storage.getDataDir(), 'activities', '2026-11-10.jsonl');
  fs.writeFileSync(firstFile, JSON.stringify({ t: at('2026-11-10', '21:00'), dur: 255 * 60000,
    app: 'Old', source: 'manual' }) + '\n');
  const replacement = { t: at('2026-11-11', '00:00'), dur: 75 * 60000, app: 'New', source: 'manual' };
  assert.equal(storage.replaceDisplayRanges('2026-11-11',
    [{ start: at('2026-11-11', '00:00'), end: at('2026-11-11', '01:15') }], replacement).success, true);
  const first = JSON.parse(fs.readFileSync(firstFile, 'utf8').trim());
  assert.equal(first.dur, 180 * 60000);
  const second = JSON.parse(fs.readFileSync(path.join(storage.getDataDir(), 'activities', '2026-11-11.jsonl'), 'utf8').trim());
  assert.equal(second.app, 'New');
});

test('summary for a past date is read from that date, not its generation date', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const summary = { id: 1, date: '2026-10-01', timestamp: '2026-11-08T10:00:00.000Z',
    summary: '回顾', activityCount: 0, activities: [] };
  assert.equal(storage.saveSummary(summary), true);
  assert.equal(storage.getSummaries('2026-10-01')[0].summary, '回顾');
  assert.equal(storage.getSummaries('2026-11-08').length, 0);
});
