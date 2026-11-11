const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../src/utils/compareRange.mjs');

test('dateList includes both ends and rejects broken input', async () => {
  const { dateList } = await mod();
  assert.deepEqual(dateList('2026-11-05', '2026-11-07'), ['2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(dateList('2026-11-07', '2026-11-05'), []);
  assert.deepEqual(dateList('', '2026-11-05'), []);
  assert.deepEqual(dateList('not-a-date', '2026-11-05'), []);
});

test('sparse report days pair by date position, not by array index', async () => {
  const { buildComparison } = await mod();
  // 本期只有 3 天有记录、上期只有 2 天，且都缺日期
  const current = {
    stats: { trackedMs: 6 * 3600000, activeDayCount: 3 },
    days: [
      { date: '2026-11-06', trackedMs: 2 * 3600000 },
      { date: '2026-11-08', trackedMs: 1 * 3600000 },
      { date: '2026-11-10', trackedMs: 3 * 3600000 }
    ],
    categories: []
  };
  const previous = {
    stats: { trackedMs: 4 * 3600000, activeDayCount: 2 },
    days: [
      { date: '2026-10-30', trackedMs: 1 * 3600000 },
      { date: '2026-11-01', trackedMs: 3 * 3600000 }
    ],
    categories: []
  };
  const result = buildComparison({
    current, previous,
    from: '2026-11-05', to: '2026-11-11',
    previousFrom: '2026-10-29', previousTo: '2026-11-04'
  });

  assert.equal(result.days.length, 7);
  const nov6 = result.days.find(d => d.date === '2026-11-06');
  assert.equal(nov6.previousDate, '2026-10-30');
  assert.equal(nov6.currentMs, 2 * 3600000);
  assert.equal(nov6.previousMs, 1 * 3600000);
  assert.equal(nov6.deltaMs, 1 * 3600000);

  // 本期没有记录的日子必须是 0，而不是沿用别天的数字
  const nov7 = result.days.find(d => d.date === '2026-11-07');
  assert.equal(nov7.currentMs, 0);
  assert.equal(nov7.previousMs, 0);
});

test('totals and per-active-day averages stay separate', async () => {
  const { buildComparison } = await mod();
  const result = buildComparison({
    current: { stats: { trackedMs: 10 * 3600000, activeDayCount: 2 }, days: [], categories: [] },
    previous: { stats: { trackedMs: 6 * 3600000, activeDayCount: 3 }, days: [], categories: [] },
    from: '2026-11-01', to: '2026-11-02', previousFrom: '2026-10-30', previousTo: '2026-11-01'
  });

  assert.equal(result.totals.deltaMs, 4 * 3600000);
  assert.equal(result.totals.deltaRatio, 4 / 6);
  assert.equal(result.avgPerActiveDay.current, 5 * 3600000);
  assert.equal(result.avgPerActiveDay.previous, 2 * 3600000);
});

test('no previous data means no ratio instead of 100 percent growth', async () => {
  const { buildComparison } = await mod();
  const result = buildComparison({
    current: { stats: { trackedMs: 3 * 3600000, activeDayCount: 1 }, days: [], categories: [{ name: '工作', durationMs: 3 * 3600000 }] },
    previous: { stats: { trackedMs: 0, activeDayCount: 0 }, days: [], categories: [] },
    from: '2026-11-01', to: '2026-11-01', previousFrom: '2026-10-31', previousTo: '2026-10-31'
  });

  assert.equal(result.totals.deltaRatio, null);
  assert.equal(result.hasPrevious, false);
  assert.equal(result.hasCurrent, true);
  const work = result.categories.find(c => c.name === '工作');
  assert.equal(work.deltaRatio, null);
  assert.equal(work.deltaMs, 3 * 3600000);
});

test('category deltas merge both sides and sort by absolute change', async () => {
  const { buildComparison, topMovers } = await mod();
  const H = 3600000;
  const result = buildComparison({
    current: {
      stats: { trackedMs: 8 * H, activeDayCount: 2 },
      days: [],
      categories: [
        { name: '开发编码', durationMs: 5 * H },
        { name: '娱乐', durationMs: 1 * H },
        { name: '新增分类', durationMs: 2 * H }
      ]
    },
    previous: {
      stats: { trackedMs: 7 * H, activeDayCount: 2 },
      days: [],
      categories: [
        { name: '开发编码', durationMs: 2 * H },
        { name: '娱乐', durationMs: 4 * H },
        { name: '只在上期', durationMs: 1 * H }
      ]
    },
    from: '2026-11-05', to: '2026-11-06', previousFrom: '2026-10-29', previousTo: '2026-10-30'
  });

  // |+3h| = |-3h|，按名字稳定排序，两者都必须排在 +2h 之前
  const names = result.categories.map(c => c.name);
  assert.deepEqual(new Set(names.slice(0, 2)), new Set(['开发编码', '娱乐']));
  assert.equal(result.categories[2].name, '新增分类');

  const coding = result.categories.find(c => c.name === '开发编码');
  assert.equal(coding.currentMs, 5 * H);
  assert.equal(coding.previousMs, 2 * H);
  assert.equal(coding.deltaMs, 3 * H);
  assert.equal(coding.deltaRatio, 1.5);

  const onlyPrevious = result.categories.find(c => c.name === '只在上期');
  assert.equal(onlyPrevious.currentMs, 0);
  assert.equal(onlyPrevious.deltaMs, -1 * H);

  const movers = topMovers(result.categories, 2);
  assert.deepEqual(movers.up.map(x => x.name), ['开发编码', '新增分类']);
  assert.deepEqual(movers.down.map(x => x.name), ['娱乐', '只在上期']);
});

test('projects are compared the same way and missing list does not throw', async () => {
  const { buildComparison } = await mod();
  const H = 3600000;
  const result = buildComparison({
    current: { stats: { trackedMs: 4 * H, activeDayCount: 1 }, days: [], categories: [], projects: [{ name: '商户迁移', durationMs: 4 * H }] },
    previous: { stats: { trackedMs: 1 * H, activeDayCount: 1 }, days: [], categories: [], projects: [{ name: '商户迁移', durationMs: 1 * H }] },
    from: '2026-11-05', to: '2026-11-05', previousFrom: '2026-10-29', previousTo: '2026-10-29'
  });

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].deltaMs, 3 * H);
  assert.deepEqual(result.projects[0].deltaRatio, 3);
});

test('empty input yields zeros rather than NaN', async () => {
  const { buildComparison } = await mod();
  const result = buildComparison({});
  assert.equal(result.totals.currentMs, 0);
  assert.equal(result.totals.previousMs, 0);
  assert.equal(result.totals.deltaRatio, null);
  assert.equal(result.avgPerActiveDay.current, 0);
  assert.deepEqual(result.days, []);
  assert.deepEqual(result.categories, []);
});
