const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const analytics = require('../electron/analytics');

/**
 * 项目维度统计与历史检索。
 *
 * 这两件事有一个共同的风险：数字对不上。
 *   项目统计如果按「每个项目的应用时长求和」，同一段时间会被三个项目
 *   各算一次，所有项目加起来超过一天的总时长。
 *   检索如果只搜应用名，用户写下的话就永远找不回来。
 */

function makeData(t, days) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-proj-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'activities');
  fs.mkdirSync(dir, { recursive: true });

  for (const [dateStr, rows] of Object.entries(days)) {
    const lines = rows.map(r => JSON.stringify({
      t: r.t, dur: r.dur, kind: 'active', app: r.app, title: r.title || '',
      project: r.project, note: r.note, cat: r.cat
    }));
    fs.writeFileSync(path.join(dir, `${dateStr}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }
  return root;
}

const at = (dateStr, h, m = 0) => new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).toISOString();

test('project totals never exceed the total tracked time', t => {
  // 同一天同一时段开着三个应用，都被同一个项目规则匹配到。
  // 正确的实现里，这段时间只算一次。
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'WorkLog' },
      { t: at('2026-11-12', 9), dur: 3600000, app: 'chrome', project: 'WorkLog' },
      { t: at('2026-11-12', 9), dur: 3600000, app: 'slack', project: 'WorkLog' }
    ]
  });
  const r = analytics.buildProjectReport(root, '2026-11-12', '2026-11-12', {});
  assert.ok(r.projectTotalMs <= r.totalMs,
    `项目合计 ${r.projectTotalMs} 不应超过总时长 ${r.totalMs}`);
});

test('each atom lands in exactly one project bucket', t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'A' },
      { t: at('2026-11-12', 10), dur: 1800000, app: 'chrome', project: 'B' },
      { t: at('2026-11-12', 11), dur: 900000, app: 'slack' }
    ]
  });
  const r = analytics.buildProjectReport(root, '2026-11-12', '2026-11-12', {});
  assert.equal(r.projects.length, 2);
  const sum = r.projects.reduce((s, p) => s + p.durationMs, 0);
  assert.equal(sum + r.unassignedMs, r.totalMs,
    '各项目之和加上未归属，应当正好等于总时长');
});

test('unassigned time is reported separately, not hidden in a bucket', t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code' },
      { t: at('2026-11-12', 10), dur: 1800000, app: 'chrome', project: 'X' }
    ]
  });
  const r = analytics.buildProjectReport(root, '2026-11-12', '2026-11-12', {});
  assert.equal(r.unassignedMs, 3600000);
  assert.equal(r.projects.length, 1);
});

test('a project aggregates per-day so week and month views can slice it', t => {
  const root = makeData(t, {
    '2026-11-10': [{ t: at('2026-11-10', 9), dur: 3600000, app: 'code', project: 'P' }],
    '2026-11-11': [{ t: at('2026-11-11', 9), dur: 1800000, app: 'code', project: 'P' }]
  });
  const r = analytics.buildProjectReport(root, '2026-11-10', '2026-11-11', {});
  const p = r.projects[0];
  assert.equal(p.name, 'P');
  assert.equal(p.dayCount, 2);
  assert.equal(p.byDate['2026-11-10'], 3600000);
  assert.equal(p.byDate['2026-11-11'], 1800000);
});

test('a project lists its apps so the user can see why it matched', t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'P' },
      { t: at('2026-11-12', 10), dur: 1800000, app: 'chrome', project: 'P' }
    ]
  });
  const r = analytics.buildProjectReport(root, '2026-11-12', '2026-11-12', {});
  assert.deepEqual(r.projects[0].apps.map(a => a.app).sort(), ['chrome', 'code']);
});

test('an empty range returns zeroes rather than throwing', t => {
  const root = makeData(t, {});
  const r = analytics.buildProjectReport(root, '2026-11-01', '2026-11-30', {});
  assert.equal(r.totalMs, 0);
  assert.deepEqual(r.projects, []);
});

// --- 检索 ---

test('search finds records by project name', t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'WorkLog', title: 'a.js' },
      { t: at('2026-11-12', 14), dur: 1800000, app: 'chrome', title: 'b' }
    ]
  });
  const r = analytics.searchActivities(root, 'WorkLog', '2026-11-12', '2026-11-12', {});
  assert.equal(r.hitCount, 1);
  assert.equal(r.hits[0].matchedOn, 'project');
});

test('search finds records by the note a person wrote', t => {
  // 这是本次修改的起因：备注只在 slot 聚合里用过，
  // 没有进读取通路，于是「写了备注但搜不到」，用户会以为没保存上。
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', note: '和客户对齐导入流程' },
      { t: at('2026-11-12', 14), dur: 1800000, app: 'chrome' }
    ]
  });
  const r = analytics.searchActivities(root, '导入流程', '2026-11-12', '2026-11-12', {});
  assert.equal(r.hitCount, 1);
  assert.equal(r.hits[0].matchedOn, 'note');
  assert.equal(r.hits[0].note, '和客户对齐导入流程');
});

test('search results carry enough to jump to the segment', t => {
  const root = makeData(t, {
    '2026-11-12': [{ t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'P' }]
  });
  const r = analytics.searchActivities(root, 'code', '2026-11-12', '2026-11-12', {});
  const hit = r.hits[0];
  assert.equal(hit.date, '2026-11-12');
  assert.ok(hit.time, '需要精确开始时间');
  assert.ok(hit.durationMs > 0, '需要时长才能定位时段终点');
  assert.equal(hit.project, 'P');
});

test('search can be limited to one field', t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'chrome', title: 'code 教程' }
    ]
  });
  const byApp = analytics.searchActivities(root, 'code', '2026-11-12', '2026-11-12', { fields: ['app'] });
  const byTitle = analytics.searchActivities(root, 'code', '2026-11-12', '2026-11-12', { fields: ['title'] });
  assert.equal(byApp.hitCount, 0, '应用名不是 chrome-code，不该命中');
  assert.equal(byTitle.hitCount, 1);
});

test('searching by project alone works without a keyword', t => {
  // 「看看这个项目这周都做了什么」是最高频的用法之一
  const root = makeData(t, {
    '2026-11-10': [{ t: at('2026-11-10', 9), dur: 3600000, app: 'code', project: 'P' }],
    '2026-11-11': [
      { t: at('2026-11-11', 9), dur: 1800000, app: 'chrome', project: 'P' },
      { t: at('2026-11-11', 14), dur: 900000, app: 'slack', project: 'Q' }
    ]
  });
  const r = analytics.searchActivities(root, '', '2026-11-10', '2026-11-11', { project: 'P' });
  assert.ok(r.hitCount >= 2);
  assert.ok(r.hits.every(h => h.project === 'P'));
});

test('an empty keyword with no project returns nothing instead of everything', t => {
  const root = makeData(t, {
    '2026-11-12': [{ t: at('2026-11-12', 9), dur: 3600000, app: 'code' }]
  });
  const r = analytics.searchActivities(root, '', '2026-11-12', '2026-11-12', {});
  assert.equal(r.hitCount, 0);
});

// --- worker 降级 ---

const reportRunner = require('../electron/reportRunner');

test('a worker failure falls back to local computation, not to empty results', async t => {
  const root = makeData(t, {
    '2026-11-12': [{ t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'P' }]
  });
  // 注入一个必然失败的 runner
  const failing = async () => ({ ok: false, error: 'worker 起不来', code: 'worker-start-failed' });

  const proj = await reportRunner.buildProjectReportSafe(root, '2026-11-12', '2026-11-12', {}, { runner: failing });
  assert.equal(proj.degraded, true);
  assert.equal(proj.report.projects.length, 1, '降级后数字必须仍然正确');

  const search = await reportRunner.searchSafe(root, 'code', '2026-11-12', '2026-11-12', {}, { runner: failing });
  assert.equal(search.degraded, true);
  assert.equal(search.result.hitCount, 1);
});

test('the worker path returns the same numbers as the local path', async t => {
  const root = makeData(t, {
    '2026-11-12': [
      { t: at('2026-11-12', 9), dur: 3600000, app: 'code', project: 'P' },
      { t: at('2026-11-12', 11), dur: 1800000, app: 'chrome' }
    ]
  });
  const viaWorker = await reportRunner.buildProjectReportSafe(root, '2026-11-12', '2026-11-12', {});
  const local = analytics.buildProjectReport(root, '2026-11-12', '2026-11-12', {});
  assert.equal(viaWorker.degraded, false, '本用例应真的走 worker');
  assert.deepEqual(viaWorker.report.projects.map(p => [p.name, p.durationMs]),
    local.projects.map(p => [p.name, p.durationMs]));
});
