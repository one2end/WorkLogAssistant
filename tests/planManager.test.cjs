const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlanManager, timeToMin, minToTime } = require('../electron/planManager');

function newManager(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, pm: new PlanManager(() => root) };
}

test('a local plan lands in plans/local.json and reads back with a stable key', t => {
  const { root, pm } = newManager(t);
  const saved = pm.upsert({
    date: '2026-11-10', startTime: '09:00', durationMin: 30, label: '写周报', category: '工作'
  });

  assert.equal(saved.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'plans', 'local.json')));

  const [row] = pm.listForDate('2026-11-10');
  assert.equal(row.startMin, 540);
  assert.equal(row.endMin, 570);
  assert.equal(row.durationMin, 30);
  assert.equal(row.source, 'local-plan');
  assert.equal(row.id, `local:${saved.item.localId}:2026-11-10`);
  assert.equal(row.planKey, `local-plan:${saved.item.localId}:2026-11-10`);
  assert.equal(row.actual, null);
});

test('updating by localId keeps one row and preserves createdAt', t => {
  const { pm } = newManager(t);
  const first = pm.upsert({ date: '2026-11-10', startTime: '09:00', durationMin: 30, label: '写周报' });

  pm.upsert({
    localId: first.item.localId, date: '2026-11-10',
    startTime: '10:00', durationMin: 60, label: '改到十点'
  });

  const rows = pm.listForDate('2026-11-10');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startMin, 600);
  assert.equal(rows[0].durationMin, 60);
  assert.equal(rows[0].label, '改到十点');
  assert.equal(rows[0].createdAt, first.item.createdAt);
});

test('markActual shows up on the plan and survives deleting the plan', t => {
  const { pm } = newManager(t);
  const saved = pm.upsert({
    date: '2026-11-10', startTime: '14:00', durationMin: 45, label: '商户走访', category: '工作'
  });
  const [row] = pm.listForDate('2026-11-10');

  const marked = pm.markActual(row, '2026-11-10', { source: 'plan' });
  assert.equal(marked.ok, true);
  assert.equal(pm.listForDate('2026-11-10')[0].actual.source, 'plan');

  const removed = pm.remove(saved.item.localId);
  assert.equal(removed.ok, true);
  assert.equal(pm.listForDate('2026-11-10').length, 0);
  assert.ok(pm.read().actuals[marked.key], 'deleting a plan must not erase its actual history');
});

test('decorate gives dida plans a stable key and merges their actuals', t => {
  const { pm } = newManager(t);
  const external = [{
    id: 'x:2026-11-10', templateId: 'tpl-9', source: 'dida-plan',
    label: '睡觉', startMin: 0, durationMin: 480, category: '睡眠'
  }];

  const [decorated] = pm.decorate(external, '2026-11-10');
  assert.equal(decorated.planKey, 'dida-plan:tpl-9:2026-11-10');
  assert.equal(decorated.actual, null);

  pm.markActual(decorated, '2026-11-10', { source: 'screen', label: '睡觉', startMin: 0, durationMin: 420 });
  const [again] = pm.decorate(external, '2026-11-10');
  assert.equal(again.actual.source, 'screen');
  assert.equal(again.actual.durationMin, 420);
});

test('invalid plans are rejected instead of written', t => {
  const { pm } = newManager(t);
  assert.equal(pm.upsert({ date: '', startTime: '09:00', label: 'x' }).ok, false);
  assert.equal(pm.upsert({ date: '2026-11-10', startTime: '09:00', label: '   ' }).ok, false);
  assert.equal(pm.upsert({ date: '2026-11-10', startMin: 1440, label: 'x' }).ok, false);
  assert.equal(pm.upsert({ date: '2026-11-10', startTime: '24:00', label: 'x' }).ok, false);
  assert.equal(pm.listForDate('2026-11-10').length, 0);
});

test('start and duration snap to 15 minutes and can extend past midnight', t => {
  const { pm } = newManager(t);
  pm.upsert({ date: '2026-11-10', startMin: 547, durationMin: 22, label: '对齐测试' });
  const [row] = pm.listForDate('2026-11-10');
  assert.equal(row.startMin, 540);
  assert.equal(row.durationMin, 15);

  pm.upsert({ date: '2026-11-10', startMin: 1430, durationMin: 60, label: '跨午夜' });
  const late = pm.listForDate('2026-11-10').find(r => r.startMin === 1425);
  assert.equal(late.endMin, 1440);
  assert.equal(late.fullEndMin, 1485);
  assert.equal(late.durationMin, 60);

  pm.upsert({ date: '2026-11-10', startMin: 1320, durationMin: 600, label: '跨夜睡眠' });
  const overnight = pm.listForDate('2026-11-10').find(r => r.label === '跨夜睡眠');
  assert.equal(overnight.endMin, 1440);
  assert.equal(overnight.fullEndMin, 1920);
  assert.equal(overnight.durationMin, 600);
  const nextDay = pm.listForDate('2026-11-11');
  const continuation = nextDay.find(r => r.label === '跨夜睡眠');
  assert.equal(continuation.startMin, 0);
  assert.equal(continuation.endMin, 480);
  assert.equal(continuation.source, 'carryover-plan');
  assert.equal(continuation.originDate, '2026-11-10');
  pm.upsert({ localId: overnight.localId, date: '2026-11-10', startMin: 1380,
    durationMin: 600, label: '跨夜睡眠', project: '睡眠计划' });
  assert.equal(pm.listForDate('2026-11-10').find(r => r.localId === overnight.localId).startMin, 1380);
  const changedContinuation = pm.listForDate('2026-11-11').find(r => r.localId === overnight.localId);
  assert.equal(changedContinuation.endMin, 540);
  assert.equal(changedContinuation.project, '睡眠计划');
});

test('identical legacy daily sleep halves merge into one overnight series with a backup', t => {
  const { root, pm } = newManager(t);
  pm.upsert({ date: '2026-11-10', startMin: 0, durationMin: 450, label: '睡觉', category: '睡眠', repeat: 'daily' });
  pm.upsert({ date: '2026-11-10', startMin: 1350, durationMin: 90, label: '睡觉', category: '睡眠', repeat: 'daily' });
  assert.equal(pm.mergeLegacyOvernightPlans(), 1);
  assert.equal(pm.mergeLegacyOvernightPlans(), 0);
  const firstDay = pm.listForDate('2026-11-10');
  assert.equal(firstDay.find(item => item.startMin === 0).repeat, 'none');
  assert.equal(firstDay.find(item => item.startMin === 1350).fullEndMin, 1890);
  const nextDay = pm.listForDate('2026-11-11');
  assert.equal(nextDay.filter(item => item.startMin === 0).length, 1);
  assert.equal(nextDay.find(item => item.startMin === 0).source, 'carryover-plan');
  assert.equal(fs.readdirSync(path.join(root, 'plans')).filter(name => name.endsWith('.bak')).length, 1);
});

test('legacy overnight migration leaves confirmed plans unchanged', t => {
  const { pm } = newManager(t);
  const early = pm.upsert({ date: '2026-11-10', startMin: 0, durationMin: 450,
    label: '睡觉', category: '睡眠', repeat: 'daily' }).item;
  pm.upsert({ date: '2026-11-10', startMin: 1350, durationMin: 90,
    label: '睡觉', category: '睡眠', repeat: 'daily' });
  pm.markActual(early, '2026-11-10', { source: 'plan' });
  assert.equal(pm.mergeLegacyOvernightPlans(), 0);
  assert.equal(pm.listForDate('2026-11-11').filter(item => item.startMin === 0).length, 1);
  assert.equal(pm.listForDate('2026-11-11').some(item => item.source === 'carryover-plan'), false);
});

test('time helpers keep HH:mm round trips inside one day', () => {
  assert.equal(timeToMin('00:00'), 0);
  assert.equal(timeToMin('23:59'), 1439);
  assert.equal(timeToMin('24:00'), null);
  assert.equal(timeToMin('9:5'), null);
  assert.equal(minToTime(0), '00:00');
  assert.equal(minToTime(539.6), '09:00');
  assert.equal(minToTime(5000), '23:59');
});

test('a broken local.json degrades to an empty plan list', t => {
  const { root, pm } = newManager(t);
  fs.mkdirSync(path.join(root, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plans', 'local.json'), '{not json', 'utf8');

  assert.deepEqual(pm.read(), { items: [], actuals: {} });
  assert.deepEqual(pm.listForDate('2026-11-10'), []);
});

test('a daily series expands to every day after its start date', t => {
  const { pm } = newManager(t);
  pm.upsert({ date: '2026-11-09', startTime: '08:00', durationMin: 30, label: '晨会', repeat: 'daily' });

  assert.equal(pm.listForDate('2026-11-09').length, 1);
  assert.equal(pm.listForDate('2026-11-10').length, 1);
  assert.equal(pm.listForDate('2026-11-20').length, 1);
  assert.equal(pm.listForDate('2026-11-08').length, 0, '系列开始前不出现');

  const [row] = pm.listForDate('2026-11-10');
  assert.equal(row.date, '2026-11-10', '实例日期是当天');
  assert.equal(row.seriesDate, '2026-11-09', '系列起始日单独保留');
  assert.equal(row.repeat, 'daily');
});

test('workday skips weekends and legal holidays but keeps makeup workdays', t => {
  const { pm } = newManager(t);
  pm.upsert({ date: '2026-09-01', startTime: '08:00', durationMin: 210, label: '工作', repeat: 'workday' });

  assert.equal(pm.listForDate('2026-09-01').length, 1, '周二上班');
  assert.equal(pm.listForDate('2026-09-05').length, 0, '周六不上班');
  assert.equal(pm.listForDate('2026-10-01').length, 0, '国庆是法定假日');
  assert.equal(pm.listForDate('2026-10-10').length, 1, '10-10 是调休上班的周六');
});

test('holiday covers weekends and legal holidays but not makeup workdays', t => {
  const { pm } = newManager(t);
  pm.upsert({ date: '2026-09-01', startTime: '10:00', durationMin: 60, label: '休息', repeat: 'holiday' });

  assert.equal(pm.listForDate('2026-09-05').length, 1, '周六算休息日');
  assert.equal(pm.listForDate('2026-10-01').length, 1, '国庆算节假日');
  assert.equal(pm.listForDate('2026-09-01').length, 0, '周二不是休息日');
  assert.equal(pm.listForDate('2026-10-10').length, 0, '调休上班日不算休息日');
});

test('repeatEnd and exceptions stop a series on specific days', t => {
  const { pm } = newManager(t);
  const saved = pm.upsert({
    date: '2026-11-09', startTime: '09:00', durationMin: 30,
    label: '日报', repeat: 'daily', repeatEnd: '2026-11-11'
  });

  assert.equal(pm.listForDate('2026-11-11').length, 1);
  assert.equal(pm.listForDate('2026-11-12').length, 0, '结束日之后不再出现');

  const skipped = pm.removeOccurrence(saved.item.localId, '2026-11-10');
  assert.equal(skipped.ok, true);
  assert.equal(pm.listForDate('2026-11-10').length, 0, '例外日期被跳过');
  assert.equal(pm.listForDate('2026-11-09').length, 1, '其他日期不受影响');
  assert.deepEqual(pm.read().items[0].exceptions, ['2026-11-10']);
});

test('updating a series keeps its exceptions and new time', t => {
  const { pm } = newManager(t);
  const saved = pm.upsert({
    date: '2026-11-09', startTime: '09:00', durationMin: 30, label: '日报', repeat: 'daily'
  });
  pm.removeOccurrence(saved.item.localId, '2026-11-10');
  pm.upsert({
    localId: saved.item.localId, date: '2026-11-09',
    startTime: '09:30', durationMin: 45, label: '日报', repeat: 'daily'
  });

  assert.equal(pm.listForDate('2026-11-10').length, 0, '更新后仍跳过例外日');
  const [row] = pm.listForDate('2026-11-09');
  assert.equal(row.startMin, 570);
  assert.equal(row.durationMin, 45);
});

test('editing one recurring occurrence leaves future occurrences unchanged', t => {
  const { pm } = newManager(t);
  const saved = pm.upsert({ date: '2026-11-09', startMin: 540, durationMin: 60, label: '晨会', repeat: 'daily', project: '甲' });
  const edited = pm.upsert({ localId: saved.item.localId, occurrenceDate: '2026-11-10', scope: 'single',
    date: '2026-11-10', startMin: 600, durationMin: 90, label: '改期晨会', repeat: 'daily', project: '乙' });
  assert.equal(edited.ok, true);
  assert.equal(pm.listForDate('2026-11-10').length, 1);
  assert.equal(pm.listForDate('2026-11-10')[0].project, '乙');
  assert.equal(pm.listForDate('2026-11-11')[0].startMin, 540);
  assert.equal(pm.listForDate('2026-11-11')[0].project, '甲');
});

test('editing this and future occurrences splits the recurring series', t => {
  const { pm } = newManager(t);
  const saved = pm.upsert({ date: '2026-11-09', startMin: 540, durationMin: 60, label: '晨会', repeat: 'daily' });
  const edited = pm.upsert({ localId: saved.item.localId, occurrenceDate: '2026-11-11', scope: 'future',
    date: '2026-11-11', startMin: 600, durationMin: 90, label: '新晨会', repeat: 'daily' });
  assert.equal(edited.ok, true);
  assert.equal(pm.listForDate('2026-11-10')[0].startMin, 540);
  assert.equal(pm.listForDate('2026-11-11')[0].startMin, 600);
  assert.equal(pm.listForDate('2026-11-12')[0].startMin, 600);
  assert.equal(pm.listForDate('2026-11-12').length, 1);
});
