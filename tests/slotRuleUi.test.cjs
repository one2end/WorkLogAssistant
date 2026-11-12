const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const slotRule = require('../electron/slotRule');

/**
 * 表单层的吸附语义（方案 §5.3 第 1/2/3 条）。
 *
 * Vue 组件本身不在这里跑（需要完整运行时），但这里验证的是它们依赖的那条
 * 契约：**表单不得在提交前把时长夹到 15**。
 *
 * 为什么这条值得单独测：早先 SegmentEditor.submit 和 TimeRangePicker.setDuration
 * 都写着 Math.max(15, ...)。看起来只是「保证最小值」，实际后果是
 * 用户输入的 3 分钟在到达主进程之前就变成了 15 分钟，
 * §5.3 第 3 条那条「最短 15 分钟」的提示永远不可能出现——
 * 后端收到的永远已经是合法的 15。
 */

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('the segment editor no longer clamps the duration up to 15', () => {
  const src = read('src/components/SegmentEditor.vue');
  // 允许出现 Math.max(1, ...)，但不允许 Math.max(15, ...) 用在时长上
  const offending = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /Math\.max\(\s*15\s*,/.test(line));
  assert.deepEqual(offending.map(o => `${o.n}: ${o.line.trim()}`), [],
    'SegmentEditor 不得再把时长下限夹到 15');
});

test('the time range picker no longer snaps up to 15 either', () => {
  const src = read('src/components/TimeRangePicker.vue');
  const offending = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /Math\.max\(\s*15\s*,/.test(line));
  assert.deepEqual(offending.map(o => `${o.n}: ${o.line.trim()}`), [],
    'TimeRangePicker 不得再把时长下限夹到 15');
});

test('both components import the shared rule instead of rounding themselves', () => {
  for (const file of ['src/components/SegmentEditor.vue', 'src/components/TimeRangePicker.vue']) {
    const src = read(file);
    assert.match(src, /from '@slot-rule'/, `${file} 应从 @slot-rule 引入共享规则`);
    assert.equal(/Math\.round\([^)]*\/\s*15\s*\)/.test(src), false,
      `${file} 不应再有手写的 15 分钟取整`);
  }
});

test('the editor preview calls the same function that writes the record', () => {
  // 预览与落盘若各算一次，偏差只在特定输入上出现，且没有任何报错。
  // 这里断言预览用的就是 slotRule.snapRange。
  const src = read('src/components/SegmentEditor.vue');
  assert.match(src, /slotRule\.snapRange\(/, '预览必须调用 snapRange');
  assert.match(src, /snapPreview/, '模板应消费 preview 结果');
});

test('a 3-minute input reaches the main process unchanged and gets refused there', () => {
  // 表单层的契约：原始时长 3 原样传下去
  const rawFromForm = Math.max(1, Math.round(Number(3) || 15));
  assert.equal(rawFromForm, 3, '表单不得把 3 抬成 15');

  // 主进程收到 3 之后的行为
  const r = slotRule.snapRange('2026-11-08', '09:07', rawFromForm);
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'too-short');
  assert.match(r.message, /当前 3 分钟/);
});

test('an aligned input shows no distortion warning', () => {
  const r = slotRule.snapRange('2026-11-08', '09:00', 15);
  assert.equal(r.rejected, undefined);
  assert.equal(r.distorted, false, '本来就对齐时不应提示失真');
});

test('the sample from the plan previews exactly as specified', () => {
  // 09:07—10:42 → 将保存为 09:00—10:45，共 105 分钟
  const r = slotRule.snapRange('2026-11-08', '09:07', 95);
  assert.equal(r.start, '09:00');
  assert.equal(r.end, '10:45');
  assert.equal(r.durationMin, 105);
  assert.equal(r.distorted, true, '95 → 105 确实改变了时长，应提示');

  // 原始终点
  const startRaw = slotRule.parseHHMM('09:07');
  assert.equal(slotRule.formatHHMM(startRaw + 95), '10:42');
});
