const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../electron/atomicFile');

test('replaces a JSON file without leaving temporary files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'day.json');
  fs.writeFileSync(file, 'old');
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['day.json']);
});

test('falls back to a direct write when rename is blocked', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-write-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'day.json');
  fs.writeFileSync(file, 'old');

  const realRename = fs.renameSync;
  let attempts = 0;
  // 模拟同步盘（iCloud / OneDrive）短暂锁住目标文件
  fs.renameSync = (...args) => {
    attempts += 1;
    const err = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  t.after(() => { fs.renameSync = realRename; });

  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.ok(attempts >= 2, 'should retry the rename before giving up');

  // 临时文件不应残留
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a non-retryable rename error falls back to a direct write', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-write-fatal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'day.json');
  fs.writeFileSync(file, 'old');

  const realRename = fs.renameSync;
  let attempts = 0;
  // EXDEV 之类不可重试的错误：不应该反复重试，直接走退路
  fs.renameSync = () => {
    attempts += 1;
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };
  t.after(() => { fs.renameSync = realRename; });

  writeFileAtomic(file, 'new');
  assert.equal(attempts, 1, 'should not retry a non-retryable error');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});
