const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDayBalance } = require('../electron/timeBalance');

test('a full day is split into explained time and truly unknown time', () => {
  const totals = buildDayBalance([
    { category: '工作', filledMin: 15 },
    { category: '生活', filledMin: 10 },
    { category: '睡眠', filledMin: 15 },
    { category: '其他', filledMin: 5 }
  ]);
  assert.deepEqual(totals, { work: 15, life: 10, sleep: 15, other: 5, unknown: 1395 });
  assert.equal(Object.values(totals).reduce((a, b) => a + b, 0), 1440);
});
