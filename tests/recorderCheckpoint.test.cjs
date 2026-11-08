const test = require('node:test');
const assert = require('node:assert/strict');
const ActivityRecorder = require('../electron/activityRecorder');

/*
 * 回归：长时间不切窗口时，片段必须定期落盘。
 *
 * 现场：18:00 到 21:00 一直在同一个游戏窗口，三小时里文件一条记录都没有。
 * 原因是片段只在「窗口标题变化」或「空闲状态变化」时才关闭并写盘，
 * 一直不动就永远在内存里；应用被杀掉（崩溃 / 任务管理器 / 断电）就整段蒸发。
 *
 * 修法是给当前片段设一个封顶时长，到点关掉重开一段。
 */

function makeRecorder(overrides = {}) {
  const writes = [];
  const sample = { processName: 'game.exe', windowTitle: 'Match', idleMs: 0, platform: 'windows' };
  const recorder = new ActivityRecorder({
    monitor: { isPersistent: () => true, latest: () => sample },
    storage: { appendActivityRecords: (batch) => { writes.push(...batch); return true; } },
    getConfig: () => ({}),
    ...overrides
  });
  recorder.running = true;
  recorder._lastTick = Date.now();
  return { recorder, writes, sample };
}

test('a parked window gets checkpointed instead of living only in memory', async () => {
  const { recorder, writes } = makeRecorder();
  const start = Date.now() - 20 * 60000;   // 假装已经挂了 20 分钟

  // 第一次 tick 建立片段
  await recorder._tick();
  assert.ok(recorder._cur, '应建立当前片段');
  recorder._cur.start = start;

  // 同一窗口、同一状态再 tick：旧实现只会更新 lastSeen，什么都不写
  recorder._lastTick = Date.now();
  await recorder._tick();

  assert.equal(writes.length, 0, '刚超过阈值时片段刚被关闭，还在缓冲区');
  recorder.flush();
  assert.ok(writes.length >= 1, '胶囊化之后必须有记录落盘');
  assert.equal(writes[0].app, 'game.exe');
});

test('a window held beyond the checkpoint interval is closed and reopened', async () => {
  const { recorder } = makeRecorder();
  await recorder._tick();
  assert.ok(recorder._cur);

  // 把片段起点往前推，模拟「已经挂了 6 分钟」
  recorder._cur.start = Date.now() - 6 * 60000;
  recorder._cur.lastSeen = recorder._cur.start;
  const before = recorder._buffer.length;

  recorder._lastTick = Date.now();
  await recorder._tick();

  assert.ok(recorder._cur, '重开后应仍有当前片段');
  // 关键证据：旧段被关闭并进了缓冲区，而不是继续累积在旧片段上
  assert.equal(recorder._buffer.length, before + 1, '旧段应已封口');
});

test('a fresh window is not churned every tick', async () => {
  const { recorder } = makeRecorder();
  await recorder._tick();
  const start = recorder._cur.start;

  recorder._lastTick = Date.now();
  await recorder._tick();

  assert.equal(recorder._cur.start, start, '未到封顶时间不应反复重开');
  assert.equal(recorder._buffer.length, 0, '未封口时不应产生新段');
});

test('switching windows still closes the previous segment immediately', async () => {
  let current = { processName: 'game.exe', windowTitle: 'Match', idleMs: 0, platform: 'windows' };
  const writes = [];
  const recorder = new ActivityRecorder({
    monitor: { isPersistent: () => true, latest: () => current },
    storage: { appendActivityRecords: (b) => { writes.push(...b); return true; } },
    getConfig: () => ({})
  });
  recorder.running = true;
  recorder._lastTick = Date.now();
  await recorder._tick();

  // 让第一段有 30 秒，否则会被 minSegmentMs 当碎片并掉
  recorder._cur.start = Date.now() - 30000;

  current = { processName: 'editor.exe', windowTitle: 'notes.md', idleMs: 0, platform: 'windows' };
  recorder._lastTick = Date.now();
  await recorder._tick();
  recorder.flush();

  assert.ok(writes.some(w => w.app === 'game.exe'), '切走时应立刻落盘上一段');
  assert.equal(recorder._cur.app, 'editor.exe');
});
