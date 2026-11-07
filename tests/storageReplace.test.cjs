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
