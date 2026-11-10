const test = require('node:test');
const assert = require('node:assert/strict');
const { splitRecordAtMidnight } = require('../electron/timeSplit');

test('cross-midnight manual fact is split at local midnight without losing duration or metadata', () => {
  const start = new Date('2026-11-10T23:15:00');
  const record = { t: start.toISOString(), dur: 180 * 60000, app: '工作', cat: '工作', project: 'A' };
  const parts = splitRecordAtMidnight(record);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].dur, 45 * 60000);
  assert.equal(parts[1].dur, 135 * 60000);
  assert.equal(parts[1].t, new Date('2026-11-11T00:00:00').toISOString());
  assert.equal(parts[1].project, 'A');
});
