const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const reportRunner = require('../electron/reportRunner');

/**
 * 报表计算迁 worker（V0.10.5 任务 2）。
 *
 * 最关键的一条不是「worker 能跑通」，而是**失败时的行为**：
 * worker 超时或崩溃时必须回退同步计算，绝不能返回空报告。
 * 空报告在界面上表现为「今天没有记录」——用户会以为数据丢了，
 * 而真实情况只是计算没完成。把「算失败」显示成「没数据」是这类
 * 架构改动最容易引入的事故。
 */

function makeData(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'activities');
  fs.mkdirSync(dir, { recursive: true });
  const at = h => new Date(2026, 10, 8, h, 0, 0).toISOString();
  const rows = [
    { t: at(9), dur: 3600000, kind: 'active', app: 'code', title: 'a' },
    { t: at(10), dur: 1800000, kind: 'active', app: 'chrome', title: 'b' }
  ];
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return root;
}

test('a day report runs in the worker and comes back intact', async t => {
  const root = makeData(t);
  const r = await reportRunner.buildDayReportSafe(root, '2026-11-08', {});

  assert.equal(r.degraded, false, '正常情况不应降级');
  assert.ok(r.report, '必须返回报告');
  assert.equal(r.report.date, '2026-11-08');
  assert.ok(r.report.stats, '报告应含 stats');
  // 两段各 60 分钟与 30 分钟，合计 90 分钟被记录
  assert.ok(r.report.stats.recordedMs >= 5400000, '总时长应覆盖两段记录');
});

test('the worker result matches the synchronous result', async t => {
  const root = makeData(t);
  const analytics = require('../electron/analytics');

  const viaWorker = await reportRunner.buildDayReportSafe(root, '2026-11-08', {});
  const direct = analytics.buildDayReport(root, '2026-11-08', {});

  // generatedAt 是时间戳，逐字段比对时要排除
  const strip = rep => {
    const clone = JSON.parse(JSON.stringify(rep));
    delete clone.generatedAt;
    return clone;
  };
  assert.deepEqual(strip(viaWorker.report), strip(direct),
    'worker 与主进程必须算出同一个结果');
});

test('an empty day yields a real empty report, not a failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const r = await reportRunner.buildDayReportSafe(root, '2026-11-08', {});
  assert.equal(r.degraded, false);
  assert.equal(r.report.stats.recordedMs, 0, '确实没有记录时才是 0');
});

test('a worker timeout falls back to a correct report rather than an empty one', async t => {
  const root = makeData(t);
  const logs = [];

  // 把超时压到 1ms：worker 必然来不及完成
  const r = await reportRunner.buildDayReportSafe(
    root, '2026-11-08', {}, { timeoutMs: 1, onLog: (msg, level) => logs.push({ msg, level }) }
  );

  assert.equal(r.degraded, true, '超时后应标记降级');
  assert.match(String(r.reason), /timeout/, '降级原因应说明是超时');
  assert.ok(r.report, '降级时仍必须给出报告');
  assert.ok(r.report.stats, '报告结构必须完整');
  assert.ok(r.report.stats.recordedMs > 0,
    '最关键的断言：降级不等于空数据，真实时长必须在');

  assert.ok(logs.some(l => /回退/.test(l.msg)), '回退必须写日志');
  assert.ok(logs.some(l => l.level === 'error' && /云端/.test(l.msg)),
    '超时提示应指出可能的云端目录问题');
});

test('a worker that cannot start still produces a correct report', async t => {
  const root = makeData(t);
  // 通过注入模拟「起不来」：runInWorker 在本模块内部直接调用，
  // 从外部替换导出属性不会影响闭包里的引用
  const r = await reportRunner.buildDayReportSafe(root, '2026-11-08', {}, {
    runner: async () => ({ ok: false, code: 'worker-start-failed', error: '无法启动' })
  });

  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'worker-start-failed');
  assert.ok(r.report.stats.recordedMs > 0, '起不来也要算出正确结果');
});

test('runInWorker reports an unknown job type instead of returning undefined', async () => {
  const r = await reportRunner.runInWorker('no-such-job', {}, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /未知作业类型/);
});

test('runInWorker surfaces an exception thrown inside the worker', async () => {
  // 传一个不存在的目录也不该崩：analytics 会自己处理成空
  const r = await reportRunner.runInWorker('dayReport', {
    dataDir: path.join(os.tmpdir(), 'definitely-not-here-xyz'),
    dateStr: '2026-11-08',
    options: {}
  }, { timeoutMs: 10000 });

  // 要么成功返回空报告，要么带回明确错误——不能是 undefined
  if (!r.ok) {
    assert.ok(r.error, '失败时必须带错误信息');
  } else {
    assert.ok(r.result, '成功时必须带结果');
  }
});

test('the worker module does not require electron', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/reportWorker.js'), 'utf8');
  assert.equal(/require\(['"]electron['"]\)/.test(src), false,
    'worker 不能依赖 electron，否则在 worker_threads 里会崩');
});

test('the worker only exposes read-only jobs', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/reportWorker.js'), 'utf8');
  for (const forbidden of ['saveActivity', 'appendActivityRecords', 'writeFileSync', 'renameSync', 'unlinkSync']) {
    assert.equal(src.includes(forbidden), false,
      `worker 不应包含写入操作：${forbidden}`);
  }
});
