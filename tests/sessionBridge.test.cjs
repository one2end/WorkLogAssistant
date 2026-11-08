/**
 * 会话折叠的「跨碎片桥接」。
 *
 * 背景：一场游戏里前台会在游戏本体、客户端、反作弊之间来回跳，
 * 每次只有几秒到几十秒。旧的折叠规则只合并「同进程且相邻」，
 * 于是一场 15 分钟的游戏会被切成 8 分钟 + 5 分钟两段，
 * 用户在时间线上看到的是「一堆几分钟的碎片」，而不是「打了一局」。
 */

const test = require('node:test');
const assert = require('node:assert');
const analytics = require('../electron/analytics.js');

const { foldSessions } = analytics;
const T0 = new Date('2026-11-08T14:00:00').getTime();
const MIN = 60 * 1000;

/** 按「起止分钟 + 应用 + 分类」造原子记录 */
function atoms(spec) {
  return spec.map(([from, to, app, category]) => ({
    ms: T0 + from * MIN,
    durationMs: Math.max(0, (to - from) * MIN),
    app,
    category: category || '游戏',
    title: app,
    source: 'auto',
    durationExact: true
  }));
}

test('a short interruption does not split the same app in two', () => {
  const sessions = foldSessions(atoms([
    [0, 15, 'League of Legends'],
    [15, 15.5, 'LeagueClientUx'],       // 30 秒的客户端窗口
    [15.5, 30, 'League of Legends']
  ]));

  assert.equal(sessions.length, 1, '应折叠成一整段，而不是两段');
  assert.equal(Math.round(sessions[0].durationMs / MIN), 30);
});

test('a long interruption still stands on its own', () => {
  const sessions = foldSessions(atoms([
    [0, 15, 'League of Legends'],
    [15, 22, 'chrome', '浏览检索'],      // 7 分钟真的去看别的东西了
    [22, 40, 'League of Legends']
  ]));

  assert.equal(sessions.length, 3, '七分钟的离开不该被吞掉');
  assert.deepEqual(sessions.map(s => s.app), ['League of Legends', 'chrome', 'League of Legends']);
});

test('adjacent segments of the same category merge across apps', () => {
  const sessions = foldSessions(atoms([
    [0, 15, 'League of Legends'],
    [15, 16, 'LeagueClientUx'],          // 首尾相接，只是换了进程
    [16, 40, 'League of Legends']
  ]));

  assert.equal(sessions.length, 1);
  assert.equal(Math.round(sessions[0].durationMs / MIN), 40);
  assert.equal(sessions[0].app, 'League of Legends', '代表进程取待得最久的那个');
});

test('the fallback category is not glued together', () => {
  // 「其他」里什么杂项都有，按分类粘合会把不相干的东西糊成一团
  const sessions = foldSessions(atoms([
    [0, 5, 'pallas', '其他'],
    [5, 10, 'ShellHost', '其他'],
    [10, 15, 'Widgets', '其他']
  ]));

  assert.equal(sessions.length, 3, '兜底分类应各自独立');
});

test('bridging does not chain indefinitely across a long gap', () => {
  // 两次游戏之间隔了 8 分钟，中间只有一段 20 秒的碎片：
  // 碎片本身够短，但跨度太大，不该把两场游戏接成一场
  const sessions = foldSessions(atoms([
    [0, 10, 'League of Legends'],
    [10, 10.33, 'LeagueClientUx'],
    [18, 28, 'League of Legends']
  ]));

  assert.equal(sessions.length, 2, '跨度过大时不应桥接');
});
