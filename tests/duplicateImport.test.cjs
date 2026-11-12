const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 重复导入与重复读取。
 *
 * 这两个用例原先锁定的是「已知问题」，V0.10.3 之后行为已经修正，
 * 因此断言同步改为断言**正确行为**（不是放宽，而是改对了）。
 *
 * 需要分清的两件事：
 *   1) 同一条记录出现在主文件与副本里 → 应当合并成一条（靠 rid 识别）
 *   2) 导入同一份文件两次 → 应当被指纹拦下，不会翻倍
 *
 * 第二条由 importSafety 的指纹机制保证；这里验证的是底层 saveActivity
 * 本身仍然没有内容去重——那是对的，因为内容相同的两条记录完全可能都是真的。
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

test('saveActivity itself has no content dedupe, and must not gain one', t => {
  const { storage } = withStorage(t);
  const payload = [
    { timestamp: at('09:00'), processName: 'chrome', windowTitle: 'A', durationMs: 600000 },
    { timestamp: at('09:10'), processName: 'code', windowTitle: 'B', durationMs: 600000 }
  ];

  payload.forEach(a => storage.saveActivity(a));
  assert.equal(storage.getActivities('2026-11-08').length, 2);

  // 再写一遍同样的内容：确实会变成 4 条。这是**正确**的——
  // 内容相同的两条记录可能都是真的（同一分钟两个窗口各记一次），
  // 靠内容判断重复就是在删用户数据。
  // 防止重复导入是 importSafety 的指纹与 imp 批次的职责，不是这里的。
  payload.forEach(a => storage.saveActivity(a));
  assert.equal(storage.getActivities('2026-11-08').length, 4,
    '底层不做内容去重；重复导入由指纹层拦截');
});

test('importing the same payload twice is refused by the fingerprint layer', t => {
  const { storage, root } = withStorage(t);
  const importSafety = require('../electron/importSafety');

  const sourceJson = {
    activities: [
      { timestamp: at('09:00'), processName: 'chrome', windowTitle: 'A', durationMs: 600000 }
    ],
    summaries: []
  };

  const plan = importSafety.planImport({
    dataDir: storage.getDataDir(), sourceJson, sourceName: 'export.json'
  });
  importSafety.executeImport({ dataDir: storage.getDataDir(), storage, sourceJson, plan });
  assert.equal(storage.getActivities('2026-11-08').length, 1);

  // 第二次导入同一份文件：应被识别为「已导入」，而不是再写一遍
  const again = importSafety.planImport({
    dataDir: storage.getDataDir(), sourceJson, sourceName: 'export.json'
  });
  assert.equal(again.action, 'already-completed', '同一份文件不应重复导入');
  assert.equal(storage.getActivities('2026-11-08').length, 1, '记录数必须保持不变');
  assert.ok(fs.existsSync(root));
});

test('conflict copies are read alongside the main file, merged only by rid', t => {
  const { storage } = withStorage(t);
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });

  // 同一条记录被同步到副本：带同一个 rid，应当合并成一条
  const row = { t: at('09:00'), dur: 3600000, app: 'chrome', title: 'Same', rid: 'rid-shared' };
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '2026-11-08 2.jsonl'), JSON.stringify(row) + '\n', 'utf8');

  const items = storage.getActivities('2026-11-08');
  assert.equal(items.length, 1, '同一条记录（同 rid）不应被读成两条');
});

test('a copy holding a different record is still read as a second record', t => {
  const { storage } = withStorage(t);
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });

  // 两条内容相同但 rid 不同：并发写入产生的两条真实记录，都要留
  const a = { t: at('09:00'), dur: 3600000, app: 'chrome', title: 'Same', rid: 'rid-a' };
  const b = { t: at('09:00'), dur: 3600000, app: 'chrome', title: 'Same', rid: 'rid-b' };
  fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), JSON.stringify(a) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '2026-11-08 2.jsonl'), JSON.stringify(b) + '\n', 'utf8');

  const items = storage.getActivities('2026-11-08');
  assert.equal(items.length, 2, '不同 rid 是两条记录，即使内容一模一样');
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
