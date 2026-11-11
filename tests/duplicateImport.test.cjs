const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 重复导入与重复读取。
 *
 * 规范第 4 条要求外部导入保留来源且不重复累计。
 * 这里锁定两类现状：
 *   1) iCloud 冲突副本会被一起读进来（有意设计），但同一条记录若同时存在
 *      于主文件和副本中，会**按文件各算一次**——当前没有跨文件去重。
 *   2) 旧版 JSON 导入走 saveActivity()，没有任何去重键，重复导入会翻倍。
 * 两者都写进审计报告的风险清单，测试用于防止行为被无意改变。
 */

function withStorage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-dup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  // 每次都要拿到一套全新的类：node 会缓存 require 结果，
  // 不清缓存会让第二个测试复用第一个测试的 root（已被 after 删掉）。
  const key = require.resolve('../electron/storageManager');
  delete require.cache[key];
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  return { storage: new StorageManager(), root };
}

const at = time => new Date(`2026-11-08T${time}:00`).toISOString();

test('importing the same JSON payload twice doubles the stored rows', t => {
  const { storage } = withStorage(t);
  const payload = [
    { timestamp: at('09:00'), processName: 'chrome', windowTitle: 'A', durationMs: 600000 },
    { timestamp: at('09:10'), processName: 'code', windowTitle: 'B', durationMs: 600000 }
  ];

  // 与 main.js import-data 的 overwrite=false 分支同样的写法
  payload.forEach(a => storage.saveActivity(a));
  const first = storage.getActivities('2026-11-08').length;
  payload.forEach(a => storage.saveActivity(a));
  const second = storage.getActivities('2026-11-08').length;

  assert.equal(first, 2);
  assert.equal(second, 4, 'KNOWN ISSUE: 无去重键，重复导入会翻倍累计');
});

test('conflict copies are read alongside the main file and are not merged', t => {
  const { storage } = withStorage(t);
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });

  const row = { t: at('09:00'), dur: 3600000, app: 'chrome', title: 'Same' };
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '2026-11-08 2.jsonl'), JSON.stringify(row) + '\n', 'utf8');

  const items = storage.getActivities('2026-11-08');
  assert.equal(items.length, 2, 'KNOWN ISSUE: 同一条记录存在于主文件与副本时会被读成两条');
});

test('records on a corrupted line do not break the rest of the file', t => {
  const { storage } = withStorage(t);
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });

  const good1 = { t: at('09:00'), dur: 900000, app: 'chrome', title: 'ok1' };
  const good2 = { t: at('09:30'), dur: 900000, app: 'code', title: 'ok2' };
  fs.writeFileSync(
    path.join(dir, '2026-11-08.jsonl'),
    `${JSON.stringify(good1)}\n{ this is not json }\n${JSON.stringify(good2)}\n`,
    'utf8'
  );

  const items = storage.getActivities('2026-11-08');
  assert.equal(items.length, 2, '单行损坏不应丢掉整份文件');
  assert.deepEqual(items.map(i => i.windowTitle), ['ok1', 'ok2']);
});

test('a checkpoint split that crosses midnight lands each part on its own day', t => {
  // 录制器每 5 分钟封口一次，熬夜到零点的记录会被切成两天的段。
  // 这里验证按本地时区分文件的归属是对的，不会丢也不会错位。
  const { storage } = withStorage(t);
  const base = new Date('2026-11-08T23:50:00');
  const segs = [0, 5, 10, 15].map(off => ({
    t: new Date(base.getTime() + off * 60000).toISOString(),
    dur: 5 * 60000,
    kind: 'active',
    app: 'code',
    title: '熬夜'
  }));
  assert.equal(storage.appendActivityRecords(segs), true);

  const day8 = storage.getActivities('2026-11-08');
  const day9 = storage.getActivities('2026-11-09');
  assert.equal(day8.length, 2, '23:50 与 23:55 应落在 11-08');
  assert.equal(day9.length, 2, '00:00 与 00:05 应落在 11-09');

  const total = [...day8, ...day9].reduce((n, r) => n + r.durationMs, 0);
  assert.equal(total, 20 * 60000, '跨午夜封口不能丢时长');

  const firstOnDay9 = new Date(day9[0].timestamp);
  assert.equal(firstOnDay9.getHours(), 0);
  assert.equal(firstOnDay9.getMinutes(), 0, '次日第一段应从本地 00:00 起');
});
