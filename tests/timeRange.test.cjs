const test = require('node:test');
const assert = require('node:assert/strict');

test('end before start means next day without extending a single day', async () => {
  const { parseClock, clockOf, durationFromClocks } = await import('../src/utils/timeRange.mjs');
  assert.equal(durationFromClocks('22:00', '08:00'), 600);
  assert.equal(durationFromClocks('23:15', '04:00'), 285);
  assert.equal(durationFromClocks('22:00', '22:00'), 1440);
  assert.equal(durationFromClocks('09:00', '10:30'), 90);
  assert.equal(clockOf((parseClock('22:00') + 600) % 1440), '08:00');
  assert.equal(durationFromClocks('25:00', '08:00'), null);
});
