const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const analytics = require('../electron/analytics');

function fixture(t, rows, date = '2026-11-08') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-analytics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const activities = path.join(dir, 'activities');
  fs.mkdirSync(activities);
  fs.writeFileSync(path.join(activities, `${date}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

function at(time) { return new Date(`2026-11-08T${time}:00`).toISOString(); }

test('manual annotation replaces overlapping recorded time without double counting', t => {
  const dir = fixture(t, [
    { t: at('09:00'), dur: 60 * 60000, app: 'chrome', title: 'Research', kind: 'active' },
    { t: at('09:15'), dur: 30 * 60000, app: 'Meeting', title: 'Client', kind: 'active', source: 'manual', cat: '沟通协作' }
  ]);
  const report = analytics.buildDayReport(dir, '2026-11-08');
  assert.equal(report.stats.trackedMs, 60 * 60000);
  assert.equal(report.layers.manualMs, 30 * 60000);
  assert.equal(report.layers.autoMs, 30 * 60000);
});

test('range totals use the same day reports as its daily breakdown', t => {
  const dir = fixture(t, [
    { t: at('10:00'), dur: 45 * 60000, app: 'wps', title: 'Draft', kind: 'active' }
  ]);
  const day = analytics.buildDayReport(dir, '2026-11-08');
  const range = analytics.buildRangeReport(dir, '2026-11-08', '2026-11-08');
  assert.equal(range.stats.trackedMs, day.stats.trackedMs);
  assert.equal(range.days[0].trackedMs, day.stats.trackedMs);
});

test('Dida focus overrides recorded time and is counted once', t => {
  const dir = fixture(t, [
    { t: at('09:00'), dur: 60 * 60000, app: 'chrome', title: 'Research', kind: 'active' }
  ]);
  const focusDir = path.join(dir, 'dida', 'focus');
  fs.mkdirSync(focusDir, { recursive: true });
  fs.writeFileSync(path.join(focusDir, '2026-11-08.json'), JSON.stringify([{
    id: 'focus-1', startMs: new Date(at('09:15')).getTime(),
    durationMs: 30 * 60000, pauseMs: 0, title: 'Writing'
  }]));
  const report = analytics.buildDayReport(dir, '2026-11-08');
  assert.equal(report.stats.trackedMs, 60 * 60000);
  assert.equal(report.layers.autoMs, 30 * 60000);
  assert.ok(report.sessions.some(s => s.category === '专注'));
});

test('AI prompt context respects manual overlap instead of adding both layers', () => {
  const items = [
    { timestamp: at('09:00'), durationMs: 60 * 60000, processName: 'chrome', windowTitle: 'Research', source: 'auto' },
    { timestamp: at('09:15'), durationMs: 30 * 60000, processName: 'Meeting', windowTitle: 'Client', source: 'manual', category: '沟通协作' }
  ];
  const context = analytics.renderPromptContext(items);
  assert.equal(context.totalMs, 60 * 60000);
});
