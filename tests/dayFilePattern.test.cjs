const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 副本文件名的严格匹配（V0.10.3 §4.5 / 验收第 5 条）。
 *
 * 这一条单独测，因为它的失败方式很隐蔽：多读了一个备份文件，用户看到的是
 * 「那天的记录莫名其妙多了一倍」，而界面上没有任何东西指向一个叫
 * `2026-11-08-backup.jsonl` 的文件。
 */

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-copies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) delete require.cache[key];
  }

  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try {
    StorageManager = require('../electron/storageManager');
  } finally {
    Module._load = originalLoad;
  }
  const storage = new StorageManager();
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });
  return { storage, dir };
}

const seg = (app, t) => JSON.stringify({ t, dur: 60000, app, title: app + '-title' }) + '\n';
const AT = new Date(2026, 10, 8, 9, 0, 0).toISOString();

function write(dir, name, rows) {
  fs.writeFileSync(path.join(dir, name), rows.map(r => seg(r.app, r.t)).join(''), 'utf8');
}

test('only the two real iCloud copy shapes are read alongside the main file', t => {
  const { storage, dir } = setup(t);

  write(dir, '2026-11-08.jsonl', [{ app: 'main', t: AT }]);
  write(dir, '2026-11-08 2.jsonl', [{ app: 'copy-num', t: AT }]);
  write(dir, '2026-11-08 (1).jsonl', [{ app: 'copy-paren', t: AT }]);

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  const apps = rows.map(r => r.processName).sort();
  assert.deepEqual(apps, ['copy-num', 'copy-paren', 'main']);
});

test('backup and old copies of the same day are not read as that day', t => {
  const { storage, dir } = setup(t);

  write(dir, '2026-11-08.jsonl', [{ app: 'main', t: AT }]);
  write(dir, '2026-11-08-backup.jsonl', [{ app: 'backup', t: AT }]);
  write(dir, '2026-11-08.old.jsonl', [{ app: 'old', t: AT }]);
  write(dir, '2026-11-08.bak.jsonl', [{ app: 'bak', t: AT }]);

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows.length, 1, '只应读到主文件那一条');
  assert.equal(rows[0].processName, 'main');
});

test('a different date that merely shares a prefix is not read', t => {
  const { storage, dir } = setup(t);

  write(dir, '2026-11-08.jsonl', [{ app: 'main', t: AT }]);
  // 11-080 不是 11-08 的副本，它是另一个（无效的）日期
  write(dir, '2026-11-080.jsonl', [{ app: 'wrong-day', t: AT }]);

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].processName, 'main');
});

test('a copy belonging to another date is not pulled into this day', t => {
  const { storage, dir } = setup(t);

  write(dir, '2026-11-08.jsonl', [{ app: 'main', t: AT }]);
  write(dir, '2026-11-09.jsonl', [{ app: 'next-day', t: new Date(2026, 10, 9, 9).toISOString() }]);
  write(dir, '2026-11-09 2.jsonl', [{ app: 'next-copy', t: new Date(2026, 10, 9, 9).toISOString() }]);

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].processName, 'main');
});

test('the day file pattern accepts the main name and both copy shapes', () => {
  const { storage } = setup({ after: () => {} });
  const StorageManager = storage.constructor;
  const re = StorageManager._dayFileRegex('2026-11-08');

  assert.equal(re.test('2026-11-08.jsonl'), true);
  assert.equal(re.test('2026-11-08 2.jsonl'), true);
  assert.equal(re.test('2026-11-08 13.jsonl'), true);
  assert.equal(re.test('2026-11-08 (1).jsonl'), true);
  assert.equal(re.test('2026-11-08 (12).jsonl'), true);

  assert.equal(re.test('2026-11-08-backup.jsonl'), false);
  assert.equal(re.test('2026-11-08.old.jsonl'), false);
  assert.equal(re.test('2026-11-080.jsonl'), false);
  assert.equal(re.test('2026-11-08.json'), false);
  assert.equal(re.test('2026-11-08x.jsonl'), false);
  assert.equal(re.test('2026-11-08 2 3.jsonl'), false);
});

test('an extension suffix that only looks like a copy is rejected', t => {
  const { storage, dir } = setup(t);
  write(dir, '2026-11-08.jsonl', [{ app: 'main', t: AT }]);
  write(dir, '2026-11-08_2.jsonl', [{ app: 'underscore', t: AT }]);
  write(dir, '2026-11-08-2.jsonl', [{ app: 'dash-num', t: AT }]);

  const rows = storage.getActivities(new Date(2026, 10, 8, 12));
  assert.equal(rows.length, 1, '下划线与连字符后缀都不是同步软件生成的副本');
  assert.equal(rows[0].processName, 'main');
});
