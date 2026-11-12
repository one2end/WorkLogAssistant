const test = require('node:test');
const assert = require('node:assert/strict');

const aiEgress = require('../electron/aiEgress');
const { isExcludedSample } = require('../electron/privacyRules');

/**
 * C1 — AI 数据出口。
 *
 * 录制侧过滤管的是「什么被记下来」，这里管的是「什么被发出去」。
 * 两者不是同一件事，所以不能因为前者做了就假设后者不需要：
 *   · 排除规则可能是后加的，历史数据仍在磁盘上
 *   · 导入的数据没经过录制侧过滤
 *   · 配置可能在读取与发送之间被改过
 */

const rec = (over = {}) => Object.assign({
  timestamp: '2026-11-12T09:00:00.000Z',
  durationMs: 600000,
  processName: 'chrome',
  windowTitle: '某封邮件 - 收件箱',
  category: '工作'
}, over);

// --- 过滤 ---

test('records matching an excluded app are dropped before sending', () => {
  const records = [rec(), rec({ processName: 'banking' })];
  const { kept, dropped } = aiEgress.filterForEgress(
    records, { excludeApps: 'banking' }, isExcludedSample
  );
  assert.equal(dropped, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].processName, 'chrome');
});

test('records matching an excluded title fragment are dropped', () => {
  const records = [
    rec({ windowTitle: '工资条.pdf' }),
    rec({ windowTitle: '会议记录' })
  ];
  const { kept, dropped } = aiEgress.filterForEgress(
    records, { excludeTitleContains: '工资' }, isExcludedSample
  );
  assert.equal(dropped, 1);
  assert.equal(kept[0].windowTitle, '会议记录');
});

test('the filter runs on every send, not once at record time', () => {
  // 同一条记录，规则不同时结果不同——这说明它是「发送时」过滤。
  // 录制侧过滤做不到这一点：那时规则还不存在。
  const records = [rec({ processName: 'banking' })];
  assert.equal(aiEgress.filterForEgress(records, {}, isExcludedSample).kept.length, 1);
  assert.equal(aiEgress.filterForEgress(records, { excludeApps: 'banking' }, isExcludedSample).kept.length, 0);
});

test('filtering never mutates the input', () => {
  const records = [rec()];
  const snapshot = JSON.stringify(records);
  aiEgress.filterForEgress(records, {}, isExcludedSample);
  assert.equal(JSON.stringify(records), snapshot);
});

test('null or malformed entries are counted as dropped, not thrown on', () => {
  const { kept, dropped } = aiEgress.filterForEgress(
    [null, undefined, rec()], {}, isExcludedSample
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped, 2);
});

// --- 字段投影 ---

test('window title is absent when the switch is off, not empty', () => {
  const out = aiEgress.projectForEgress(rec(), { sendAppName: true, sendWindowTitle: false });
  assert.equal('windowTitle' in out, false,
    '关闭时必须不出现该字段；空串仍然占位，也泄露「这里原本有个标题」');
  assert.equal(out.processName, 'chrome');
});

test('window title appears when the switch is on', () => {
  const out = aiEgress.projectForEgress(rec(), { sendAppName: true, sendWindowTitle: true });
  assert.equal(out.windowTitle, '某封邮件 - 收件箱');
});

test('app name is absent when its switch is off', () => {
  const out = aiEgress.projectForEgress(rec(), { sendAppName: false, sendWindowTitle: false });
  assert.equal('processName' in out, false, '关闭时完全不发送 processName');
  assert.equal('windowTitle' in out, false);
});

test('the projection keeps only fields it is supposed to keep', () => {
  const out = aiEgress.projectForEgress(rec(), { sendAppName: true, sendWindowTitle: true });
  const allowed = new Set(['timestamp', 'durationMs', 'category', 'processName', 'windowTitle']);
  for (const k of Object.keys(out)) {
    assert.ok(allowed.has(k), `不该发送 ${k}`);
  }
});

test('both switches off still yields a usable record', () => {
  // 只剩时间和时长——仍然是有效输入，只是模型看不到内容
  const out = aiEgress.projectForEgress(rec(), { sendAppName: false, sendWindowTitle: false });
  assert.equal(out.timestamp, '2026-11-12T09:00:00.000Z');
  assert.equal(out.durationMs, 600000);
});

test('a record with no title is handled without inventing one', () => {
  const out = aiEgress.projectForEgress(rec({ windowTitle: undefined }), { sendWindowTitle: true });
  assert.equal('windowTitle' in out, false, '原本没有的字段不该凭空出现空串');
});

// --- 出口说明 ---

test('the description counts records and lists exactly what will be sent', () => {
  const payload = [
    aiEgress.projectForEgress(rec(), { sendAppName: true, sendWindowTitle: false }),
    aiEgress.projectForEgress(rec(), { sendAppName: true, sendWindowTitle: false })
  ];
  const d = aiEgress.describeEgress(payload);
  assert.equal(d.recordCount, 2);
  assert.equal(d.includesAppName, true);
  assert.equal(d.includesWindowTitle, false);
  assert.deepEqual(d.fields.sort(), ['category', 'durationMs', 'processName', 'timestamp']);
});

test('the end-to-end path drops excluded records and honours the switches', () => {
  // 组合起来跑一遍：这是 summarize 实际会走的顺序
  const records = [
    rec({ processName: 'chrome', windowTitle: '周报.docx' }),
    rec({ processName: 'password-manager', windowTitle: '保险箱' })
  ];
  const { kept } = aiEgress.filterForEgress(
    records, { excludeApps: 'password-manager' }, isExcludedSample
  );
  const payload = kept.map(a => aiEgress.projectForEgress(a, {
    sendAppName: true,
    sendWindowTitle: false
  }));

  assert.equal(payload.length, 1, '被排除的应用不该出现在发送内容里');
  const json = JSON.stringify(payload);
  assert.equal(json.includes('password-manager'), false);
  assert.equal(json.includes('密码'), false);
  assert.equal(json.includes('周报.docx'), false, '窗口标题默认不发送');
});

test('the default config keeps AI off and window titles off', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../electron/configManager.js'), 'utf8');
  const block = src.slice(src.indexOf('ai: {'), src.indexOf('advice:'));
  assert.match(block, /enabled:\s*false/, 'AI 默认关闭的决策不能改');
  assert.match(block, /sendWindowTitle:\s*false/, '窗口标题默认不发送');
  assert.match(block, /sendAppName:\s*true/);
});

test('the settings page states exactly which fields get sent', () => {
  // 用户要能数出来发了什么。「部分数据」「必要的元信息」这类措辞
  // 听起来稳妥，实际上什么都没说。
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/views/SettingsView.vue'), 'utf8');

  assert.match(src, /本次将发送/, '设置页应明确列出会发送的内容');
  assert.match(src, /ai\.sendAppName/, '应有应用名开关');
  assert.match(src, /ai\.sendWindowTitle/, '应有窗口标题开关');
});

test('the settings copy does not claim titles are sent by default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/views/SettingsView.vue'), 'utf8');
  // 旧文案写的是「模型会看到相关应用名、窗口标题」——那句现在是错的
  assert.equal(/模型会看到相关应用名、窗口标题/.test(src), false,
    '旧文案声称一定发送窗口标题，与新的默认值矛盾');
});
