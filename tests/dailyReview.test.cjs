const test = require('node:test');
const assert = require('node:assert/strict');

const dailyReview = require('../electron/dailyReview');

/**
 * 日复盘生成器。
 *
 * 这个模块的价值在于「把散落的记录整理成人话」，风险也在这里：
 * 一句读起来很顺的总结，如果数据不支持，就是在编造。
 * 所以测试的重点不是「有没有输出」，而是「输出里的每个数字能不能对上」。
 */

/** 造一份最小可用的报告，字段与 buildDayReport 一致 */
function makeReport(over = {}) {
  const base = {
    date: '2026-11-12',
    stats: {
      trackedMs: 2 * 3600000,
      recordedMs: 2 * 3600000,
      idleMs: 0,
      coverage: 0.12,
      sessionCount: 2
    },
    apps: [
      { processName: 'code', durationMs: 2 * 3600000, percent: 1, sessionCount: 2, titles: ['main.js', 'test.js'] }
    ],
    categories: [
      { name: '开发编码', durationMs: 2 * 3600000, percent: 1 }
    ],
    activityThreads: [
      {
        id: 'a', start: '2026-11-12T01:00:00.000Z', end: '2026-11-12T02:00:00.000Z',
        durationMs: 3600000, label: 'main.js', project: 'WorkLog', category: '开发编码',
        confidence: 0.95, needsConfirmation: false
      }
    ],
    slots: [],
    layers: {}
  };
  return { ...base, ...over };
}

/** 造一段从前一天 9 点到第二段结束的 slots，用于测试空档 */
function slotsWithGap() {
  const slots = [];
  for (let i = 0; i < 96; i += 1) {
    const startMin = i * 15;
    // 9:00-10:00 与 14:00-15:00 有记录，其余为空
    const filled = (startMin >= 540 && startMin < 600) || (startMin >= 840 && startMin < 900);
    slots.push({ startMin, filledMin: filled ? 15 : 0 });
  }
  return slots;
}

test('a day with data produces all the expected sections', () => {
  const out = dailyReview.buildDailyReview({ report: makeReport(), plans: [], date: '2026-11-12' });
  assert.match(out.markdown, /### 今天做了什么/);
  assert.match(out.markdown, /### 时间投入/);
  assert.match(out.markdown, /### 计划与实际/);
  assert.deepEqual(out.warnings, []);
});

test('a day with no records says so instead of inventing a morning', () => {
  const empty = makeReport({
    stats: { trackedMs: 0, recordedMs: 0, idleMs: 0, coverage: 0, sessionCount: 0 },
    apps: [],
    categories: [],
    activityThreads: []
  });
  const out = dailyReview.buildDailyReview({ report: empty, plans: [], date: '2026-11-12' });

  assert.match(out.markdown, /没有记录到活动/);
  // 关键：不能说「今天主要在休息」之类听起来合理、实际无依据的话
  assert.equal(/主要在/.test(out.markdown), false);
  assert.equal(/完成得不错|效率/.test(out.markdown), false);
  assert.ok(out.warnings.length > 0);
});

test('durations in the draft match the underlying report exactly', () => {
  const report = makeReport();
  const out = dailyReview.buildDailyReview({ report, plans: [], date: '2026-11-12' });
  // 2 小时是报告里的 trackedMs，不是估出来的
  assert.match(out.markdown, /记录时长：\*\*2 小时\*\*/);
});

test('activity threads are listed with their real time range', () => {
  const report = makeReport();
  const out = dailyReview.buildDailyReview({ report, plans: [], date: '2026-11-12' });
  // start/end 是 ISO，转换成当地时间显示
  assert.match(out.markdown, /main\.js/);
  assert.match(out.markdown, /WorkLog/, '项目名应跟在活动名后面');
  assert.match(out.markdown, /\d{2}:\d{2}–\d{2}:\d{2}/);
});

test('when threads are missing it falls back to apps and says the summary is rough', () => {
  const report = makeReport({ activityThreads: [] });
  const out = dailyReview.buildDailyReview({ report, plans: [], date: '2026-11-12' });
  assert.match(out.markdown, /code/);
  assert.ok(out.warnings.some(w => /粗略/.test(w)),
    '退回按应用归纳时必须说明这是粗粒度结果');
});

// --- 计划对照 ---

const plan = (title, durationMin, actual) => ({ title, durationMin, actual });

test('plans are classified into done, partial and unrecorded', () => {
  const plans = [
    plan('写文档', 60, { durationMs: 55 * 60000 }),
    plan('改代码', 60, { durationMs: 20 * 60000 }),
    plan('开会', 30, null)
  ];
  const cmp = dailyReview.planComparison(plans, makeReport());
  assert.equal(cmp.done.length, 1);
  assert.equal(cmp.partial.length, 1);
  assert.equal(cmp.missed.length, 1);
});

test('an unrecorded plan is never described as not done', () => {
  // 离开电脑做的事不会出现在记录里。把「没记录」说成「没完成」
  // 是这种工具最伤人的一种错误。
  const plans = [plan('见客户', 60, null)];
  const out = dailyReview.buildDailyReview({ report: makeReport(), plans, date: '2026-11-12' });

  assert.match(out.markdown, /没有对应的记录/);
  assert.match(out.markdown, /没有记录不等于没有做/);
  assert.equal(/未完成$|没做/.test(out.markdown), false);
});

test('a day without plans says so plainly', () => {
  const out = dailyReview.buildDailyReview({ report: makeReport(), plans: [], date: '2026-11-12' });
  assert.match(out.markdown, /这一天没有安排计划/);
});

// --- 值得注意 ---

test('long gaps are measured only between the first and last record', () => {
  // 全天 96 格大部分为空。若不裁剪到首末记录之间，
  // 会得出「22 小时空白」这种既没用也吓人的数字。
  const report = makeReport({ slots: slotsWithGap() });
  const notable = dailyReview.notableItems(report, {});
  const gap = notable.find(n => n.kind === 'gap');
  assert.ok(gap, '应有空档提示');
  // 9:00-10:00 与 14:00-15:00 之间是 4 小时
  assert.match(gap.text, /4 小时/);
  assert.equal(/2[0-9] 小时/.test(gap.text), false, '不该统计午夜前后的时段');
});

test('no notable items are produced when nothing notable happened', () => {
  // 一条都不触发时就应该没有这一段，而不是放一句「今天一切正常」
  const report = makeReport({
    stats: { trackedMs: 3600000, idleMs: 0, coverage: 0.5 },
    apps: [{ processName: 'code', durationMs: 3600000, percent: 0.4, sessionCount: 2 }],
    activityThreads: [],
    slots: []
  });
  const notable = dailyReview.notableItems(report, {});
  assert.equal(notable.length, 0);
});

test('a dominant app is only called out when the day is long enough', () => {
  const short = makeReport({
    stats: { trackedMs: 3600000, idleMs: 0 },
    apps: [{ processName: 'code', durationMs: 3600000, percent: 0.95, sessionCount: 2 }]
  });
  assert.equal(dailyReview.notableItems(short, {}).some(n => n.kind === 'dominant'), false,
    '只有一个小时的数据不足以说「占了大头」');

  const long = makeReport({
    stats: { trackedMs: 6 * 3600000, idleMs: 0 },
    apps: [{ processName: 'code', durationMs: 5.5 * 3600000, percent: 0.92, sessionCount: 5 }]
  });
  assert.equal(dailyReview.notableItems(long, {}).some(n => n.kind === 'dominant'), true);
});

test('pending threads are surfaced with a pointer to act on them', () => {
  const report = makeReport({
    activityThreads: [{ id: 'x', label: '?', durationMs: 1800000, needsConfirmation: true }]
  });
  const notable = dailyReview.notableItems(report, {});
  const pending = notable.find(n => n.kind === 'pending');
  assert.ok(pending);
  assert.equal(pending.action, 'review-threads');
});

// --- 输出形态 ---

test('the draft is valid markdown with a heading per section', () => {
  const out = dailyReview.buildDailyReview({ report: makeReport(), plans: [], date: '2026-11-12' });
  assert.match(out.markdown, /^## 2026-11-12 复盘/);
  const headings = out.markdown.match(/^### .+$/gm) || [];
  assert.ok(headings.length >= 3, '至少三个阶段标题');
});

test('a missing report is reported, not silently rendered as empty', () => {
  const out = dailyReview.buildDailyReview({ report: null });
  assert.equal(out.markdown, '');
  assert.ok(out.warnings.length > 0);
});

test('humanDuration reads naturally at every scale', () => {
  const f = dailyReview.humanDuration;
  assert.equal(f(0), '0 分钟');
  assert.equal(f(60 * 1000), '1 分钟');
  assert.equal(f(60 * 60000), '1 小时');
  assert.equal(f(90 * 60000), '1 小时 30 分钟');
  assert.equal(f(-5), '0 分钟', '负数不该输出负时长');
});

test('reviewing does not modify the report it was given', () => {
  const report = makeReport({ slots: slotsWithGap() });
  const snapshot = JSON.stringify(report);
  dailyReview.buildDailyReview({ report, plans: [plan('x', 30, null)], date: '2026-11-12' });
  assert.equal(JSON.stringify(report), snapshot);
});

// --- 计划外的时间 ---

test('a thread outside every planned window is reported as unplanned, not as waste', () => {
  const report = makeReport({
    activityThreads: [
      { id: '1', start: '2026-11-12T09:00:00', end: '2026-11-12T10:00:00', durationMs: 3600000, label: '写文档', category: '文档' },
      { id: '2', start: '2026-11-12T15:00:00', end: '2026-11-12T16:00:00', durationMs: 3600000, label: '紧急修线上问题', category: '开发编码' }
    ]
  });
  const plans = [{ title: '写文档', durationMin: 60, startMin: 540, endMin: 600, actual: { durationMs: 3600000 } }];
  const out = dailyReview.buildDailyReview({ report, plans, date: '2026-11-12' });

  assert.match(out.markdown, /计划外的时间/);
  assert.match(out.markdown, /紧急修线上问题/);
  assert.match(out.markdown, /计划外的时间不一定是浪费/,
    '计划外不等于浪费时间，措辞不能带评判');
  assert.equal(/分心|不专注|效率低/.test(out.markdown), false);
});

test('a thread overlapping a plan is not counted as unplanned', () => {
  const report = makeReport({
    activityThreads: [
      // 10:00-11:00，与 10:00 开始的那段计划重叠
      { id: '1', start: '2026-11-12T10:00:00', end: '2026-11-12T11:00:00', durationMs: 3600000, label: '写文档' }
    ]
  });
  const plans = [{ title: '写文档', durationMin: 60, startMin: 600, endMin: 660, actual: { durationMs: 3600000 } }];
  const cmp = dailyReview.planComparison(plans, report);
  assert.equal(cmp.extra.length, 0);
});

test('a short interruption is not elevated to an unplanned activity', () => {
  // 10 分钟的临时插话很常见，把它列为「计划外的活动」会制造噪音
  const report = makeReport({
    activityThreads: [
      { id: '1', start: '2026-11-12T15:00:00', end: '2026-11-12T15:10:00', durationMs: 10 * 60000, label: '回了个消息' }
    ]
  });
  const plans = [{ title: '写文档', durationMin: 60, startMin: 540, endMin: 600 }];
  const cmp = dailyReview.planComparison(plans, report);
  assert.equal(cmp.extra.length, 0);
});

test('dropping capacity for a cancelled afternoon is not called a failure', () => {
  // 一个下午的会打断了原计划。草稿要陈述事实，不要下结论。
  const plans = [{ title: '写文档', durationMin: 120, startMin: 840, endMin: 960, actual: null }];
  const out = dailyReview.buildDailyReview({ report: makeReport(), plans, date: '2026-11-12' });
  assert.equal(/未完成|失败|没做到/.test(out.markdown), false);
  assert.match(out.markdown, /没有对应的记录/);
});
