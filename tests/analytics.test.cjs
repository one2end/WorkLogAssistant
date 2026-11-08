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
  assert.equal(report.recordedApps.length, 1);
  assert.equal(report.recordedApps[0].processName, 'chrome');
  assert.equal(report.recordedApps[0].durationMs, 60 * 60000);
  assert.equal(report.recordedWindows[0].title, 'Research');
  assert.equal(report.recordedWindows[0].durationMs, 60 * 60000);
});

test('recorded time includes life and sleep while effective work remains separate', t => {
  const dir = fixture(t, [
    { t: at('09:00'), dur: 30 * 60000, app: 'chrome', title: 'Research' },
    { t: at('09:30'), dur: 30 * 60000, app: 'Lunch', source: 'manual', cat: '生活事务' },
    { t: at('10:00'), dur: 30 * 60000, app: 'Nap', source: 'manual', cat: '睡眠' }
  ]);
  const report = analytics.buildDayReport(dir, '2026-11-08');
  assert.equal(report.stats.recordedMs, 90 * 60000);
  assert.equal(report.stats.trackedMs, 30 * 60000);
  assert.deepEqual(report.recordedApps.map(a => a.processName), ['chrome']);
  assert.equal(analytics.buildDailyTrackedMs(dir, '2026-11-08', '2026-11-08')[0].trackedMs,
    90 * 60000);
});

test('coverage starts at midnight and counts populated 15 minute slots', t => {
  const date = '2026-11-07';
  // 自动录制占满一整格才算「这一格有记录」：
  // 打开软件十分钟就关掉，那一格仍是空的，可以手工补记。
  const dir = fixture(t, [{ t: new Date(`${date}T00:00:00`).toISOString(), dur: 15 * 60000,
    app: 'chrome', title: 'Early activity' }], date);
  const report = analytics.buildDayReport(dir, date);
  assert.equal(report.stats.coveredSlots, 1);
  assert.equal(report.stats.elapsedSlots, 96);
  assert.equal(report.stats.coverage, 1 / 96);
  assert.equal(report.slots[0].filledMin, 15);
});

test('a short auto sample leaves the slot open for manual annotation', t => {
  const date = '2026-11-07';
  const dir = fixture(t, [{ t: new Date(`${date}T00:04:00`).toISOString(), dur: 3 * 60000,
    app: 'chrome', title: 'Early activity' }], date);
  const report = analytics.buildDayReport(dir, date);
  assert.equal(report.stats.coveredSlots, 0, '三分钟的采样不算这一格已记录');
  assert.equal(report.slots[0].filledMin, 0);
  assert.ok(report.stats.blankSlotCount > 0, '这格应算空白，可以补记');
});

/*
 * 回归：曾经要求自动录制占满整格（100%）才算已记录。
 * 但真实录制永远凑不满——切应用、游戏加载、采样间隔都会留几秒空隙，
 * 结果是一小时游戏四格覆盖 51.7% / 94.1% / 97.8% / 74.2%，全部判成空白，
 * 表现为「一直在玩，一分钟都没记上」。
 * 现在的规则是占满 60%（9 分钟）即可，这几条覆盖真实取值。
 */
test('a nearly-full auto slot counts even with a few seconds of gap', t => {
  const date = '2026-11-07';
  const dir = fixture(t, [
    // 14 分钟连续停留：模拟切换应用留下的 1 分钟空隙
    { t: new Date(`${date}T10:00:00`).toISOString(), dur: 14 * 60000, app: 'game', title: 'Match' }
  ], date);
  const report = analytics.buildDayReport(dir, date);
  const slot = report.slots.find(s => s.startMin === 600);
  assert.equal(slot.filledMin, 15, '覆盖 93% 应算已记录');
  assert.equal(report.stats.coveredSlots, 1);
});

test('an auto slot below the fill ratio stays blank', t => {
  const date = '2026-11-07';
  const dir = fixture(t, [
    // 8 分钟：不足九分钟，仍应留作空白
    { t: new Date(`${date}T10:00:00`).toISOString(), dur: 8 * 60000, app: 'game', title: 'Match' }
  ], date);
  const report = analytics.buildDayReport(dir, date);
  const slot = report.slots.find(s => s.startMin === 600);
  assert.equal(slot.filledMin, 0, '覆盖 53% 不算已记录');
  assert.equal(slot.sampledMin, 8, '但采样值仍保留，时间轴上要能看到');
});

test('custom manual category remains visible in time slots and composition', t => {
  const dir = fixture(t, [
    { t: at('11:00'), dur: 30 * 60000, app: '画画', source: 'manual', cat: '创作' }
  ]);
  const report = analytics.buildDayReport(dir, '2026-11-08');
  assert.equal(report.slots.find(s => s.startMin === 660).category, '创作');
  assert.equal(report.categoriesGrouped.find(c => c.name === '创作').durationMs, 30 * 60000);
});

test('app mappings reclassify historical auto records while manual labels stay authoritative', async t => {
  const dir = fixture(t, [
    { t: at('09:00'), dur: 30 * 60000, app: 'chrome.exe', title: 'Project notes', cat: '浏览检索' },
    { t: at('09:30'), dur: 30 * 60000, app: 'chrome.exe', title: 'Video lesson', cat: '浏览检索' },
    { t: at('10:00'), dur: 30 * 60000, app: '自修', source: 'manual', cat: '学习' }
  ]);
  const report = analytics.buildDayReport(dir, '2026-11-08', {
    appCategoryMap: { chrome: '工作' },
    windowCategoryRules: [{ app: 'chrome', titleContains: 'Video', category: '学习' }]
  });
  assert.equal(report.slots.find(s => s.startMin === 540).category, '工作');
  assert.equal(report.slots.find(s => s.startMin === 570).category, '学习');
  assert.equal(report.slots.find(s => s.startMin === 600).category, '学习');
  assert.ok(analytics.listRecordedApps(dir).some(a => a.key === 'chrome'));
  assert.ok(!analytics.listRecordedApps(dir).some(a => a.name === '自修'));
  assert.deepEqual(await analytics.listRecordedAppsAsync(dir), analytics.listRecordedApps(dir));
});

test('window title identifies activity before generic browser category', () => {
  const classify = analytics.buildClassifier();
  assert.equal(classify('chrome.exe', 'ChatGPT - Research'), 'AI 助手');
  assert.equal(classify('chrome.exe', 'Plain web page'), '浏览检索');
  const mapped = analytics.buildClassifier(null, { chrome: '学习' }, [
    { app: 'chrome', titleContains: 'ChatGPT', category: '工作' }
  ]);
  assert.equal(mapped('chrome.exe', 'ChatGPT - Research'), '工作');
  assert.equal(mapped('chrome.exe', 'Plain web page'), '学习');
});

test('mapping an app to life keeps its time out of effective work', t => {
  const dir = fixture(t, [{ t: at('18:00'), dur: 30 * 60000, app: 'music.exe', title: 'Playlist' }]);
  const report = analytics.buildDayReport(dir, '2026-11-08', { appCategoryMap: { music: '娱乐' } });
  assert.equal(report.stats.recordedMs, 30 * 60000);
  assert.equal(report.stats.trackedMs, 0);
  assert.equal(report.stats.lifeMs, 30 * 60000);
});

test('custom category keeps its label and uses its parent group for time accounting', t => {
  const dir = fixture(t, [{ t: at('18:00'), dur: 30 * 60000, app: 'music.exe', title: 'Playlist' }]);
  const report = analytics.buildDayReport(dir, '2026-11-08', {
    appCategoryMap: { music: '听歌' },
    customCategories: [{ key: '听歌', name: '听音乐', color: '#dd8855', group: '娱乐' }]
  });
  assert.equal(report.slots.find(s => s.startMin === 1080).category, '听歌');
  assert.equal(report.dayBalance.life, 30);
  assert.equal(report.stats.lifeMs, 30 * 60000);
  assert.equal(report.stats.trackedMs, 0);
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

test('Dida focus note reaches the display slot alongside its title', t => {
  const dir = fixture(t, [{ t: at('09:00'), dur: 30 * 60000, app: 'chrome', title: 'Background' }]);
  const focusDir = path.join(dir, 'dida', 'focus');
  fs.mkdirSync(focusDir, { recursive: true });
  fs.writeFileSync(path.join(focusDir, '2026-11-08.json'), JSON.stringify([{
    id: 'note-1', startMs: new Date(at('09:00')).getTime(), durationMs: 30 * 60000,
    pauseMs: 0, title: '阅读资料', note: '重点是第三章'
  }]));
  const report = analytics.buildDayReport(dir, '2026-11-08');
  const slot = report.slots.find(s => s.startMin === 540);
  assert.equal(slot.app, '阅读资料');
  assert.equal(slot.note, '重点是第三章');
  assert.equal(slot.focusId, 'dida:note-1');
  assert.equal(report.focus.didaSessions[0].note, '重点是第三章');
});

test('local edit of imported focus survives when source mirror stays unchanged', t => {
  const dir = fixture(t, []);
  const focusDir = path.join(dir, 'dida', 'focus');
  const overrideDir = path.join(dir, 'arhat', 'overrides');
  fs.mkdirSync(focusDir, { recursive: true });
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.writeFileSync(path.join(focusDir, '2026-11-08.json'), JSON.stringify([{
    id: 'focus-1', startMs: new Date(at('09:00')).getTime(), durationMs: 30 * 60000, title: '原标题'
  }]));
  fs.writeFileSync(path.join(overrideDir, '2026-11-08.json'), JSON.stringify([{
    id: 'dida:focus-1', focusText: '修订后的专注', note: '补充备注'
  }]));
  const report = analytics.buildDayReport(dir, '2026-11-08');
  assert.equal(report.focus.didaSessions[0].id, 'dida:focus-1');
  assert.equal(report.focus.didaSessions[0].focusText, '修订后的专注');
  assert.equal(report.focus.didaSessions[0].note, '补充备注');
  assert.equal(report.slots.find(s => s.startMin === 540).note, '补充备注');
});

test('AI prompt context respects manual overlap instead of adding both layers', () => {
  const items = [
    { timestamp: at('09:00'), durationMs: 60 * 60000, processName: 'chrome', windowTitle: 'Research', source: 'auto' },
    { timestamp: at('09:15'), durationMs: 30 * 60000, processName: 'Meeting', windowTitle: 'Client', source: 'manual', category: '沟通协作' }
  ];
  const context = analytics.renderPromptContext(items);
  assert.equal(context.totalMs, 60 * 60000);
});

test('category merge reclassifies historical manual and app records without editing source', t => {
  const dir = fixture(t, [
    { t: at('09:00'), dur: 30 * 60000, app: 'chrome', title: 'Research', cat: '旧分类' },
    { t: at('10:00'), dur: 30 * 60000, app: '手工标注', title: '读书', cat: '旧分类', source: 'manual' }
  ]);
  const report = analytics.buildDayReport(dir, '2026-11-08', { categoryMerges: { 旧分类: '学习' } });
  assert.ok(report.sessions.some(s => s.category === '学习'));
  assert.ok(report.slots.some(s => s.category === '学习'));
  assert.ok(!report.categories.some(c => c.name === '旧分类'));
  const original = analytics.buildDayReport(dir, '2026-11-08');
  assert.ok(original.sessions.some(s => s.category === '旧分类'));
});
