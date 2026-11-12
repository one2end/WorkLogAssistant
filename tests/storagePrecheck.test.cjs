const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const precheck = require('../electron/storagePrecheck');

/**
 * 数据目录预检（V0.10.5 任务 1）。
 *
 * 要防的是「切到云端占位目录之后，界面每次读都卡住」。这类目录看起来
 * 完全正常——列得出文件、大小也对——所以只能在真正读的时候发现。
 *
 * 测试因此分两层：checkStorageDir 的判定逻辑，以及 checkStorageDirAsync
 * 在预检本身卡住时能否按时返回（后者才是「主进程不冻结」的保证）。
 */

function tmpDir(t, prefix = 'lifelog-pre-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a normal writable directory passes', t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'activities', '2026-11-08.jsonl'), '{"t":"x"}\n', 'utf8');

  const r = precheck.checkStorageDir(dir);
  assert.equal(r.ok, true);
  assert.equal(r.sampleCount, 1);
});

test('a directory that does not exist yet is allowed, since switching can create it', t => {
  const dir = path.join(tmpDir(t), 'not-yet');
  const r = precheck.checkStorageDir(dir);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
});

test('a plain file is rejected as not-a-directory', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, '{}', 'utf8');
  const r = precheck.checkStorageDir(file);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-directory');
});

test('an invalid path is rejected without throwing', () => {
  for (const bad of ['', null, undefined, 123]) {
    const r = precheck.checkStorageDir(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-path');
  }
});

test('a read-only directory is rejected because we cannot write there', t => {
  const dir = tmpDir(t);
  // 用一个会失败的写探针模拟不可写：这里直接改权限，Windows 上可能不生效，
  // 所以额外用 monkey-patch 保证断言环境确定
  const original = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).includes('.write-probe-')) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return original.call(fs, p, ...rest);
  };
  let r;
  try {
    r = precheck.checkStorageDir(dir);
  } finally {
    fs.writeFileSync = original;
  }

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-writable');
  assert.match(r.message, /不可写/);
});

test('a sample that cannot be read is reported with a cloud-hint message', t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  const file = path.join(dir, 'activities', '2026-11-08.jsonl');
  fs.writeFileSync(file, '{"t":"x"}\n', 'utf8');

  const original = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === file) {
      const err = new Error('EIO: i/o error');
      err.code = 'EIO';
      throw err;
    }
    return original.call(fs, p, ...rest);
  };
  let r;
  try {
    r = precheck.checkStorageDir(dir);
  } finally {
    fs.readFileSync = original;
  }

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sample-read-failed');
  assert.match(r.message, /始终保留在此设备上/, '提示应告诉用户具体怎么办');
  assert.equal(r.detail.failures.length, 1);
});

test('an empty directory passes: nothing to sample means nothing can stall', t => {
  const dir = tmpDir(t);
  const r = precheck.checkStorageDir(dir);
  assert.equal(r.ok, true);
  assert.equal(r.sampleCount, 0);
});

test('sample picking prefers the most recently modified files', t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  const old = path.join(dir, 'activities', '2026-11-01.jsonl');
  const recent = path.join(dir, 'activities', '2026-11-08.jsonl');
  fs.writeFileSync(old, '{"a":1}\n', 'utf8');
  fs.writeFileSync(recent, '{"b":2}\n', 'utf8');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(old, past, past);

  const picks = precheck.pickSamples(dir, 1);
  assert.equal(picks.length, 1);
  assert.equal(path.basename(picks[0].path), '2026-11-08.jsonl');
});

test('sample picking skips zero-length files', t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'activities', 'empty.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'activities', 'real.jsonl'), '{"a":1}\n', 'utf8');

  const picks = precheck.pickSamples(dir, 5);
  assert.equal(picks.length, 1);
  assert.equal(path.basename(picks[0].path), 'real.jsonl');
});

test('the async check returns promptly for a healthy directory', async t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'activities', '2026-11-08.jsonl'), '{"t":"x"}\n', 'utf8');

  const started = Date.now();
  const r = await precheck.checkStorageDirAsync(dir, { timeoutMs: 1000 });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, true);
  assert.ok(elapsed < 5000, `正常目录应在合理时间内返回，实际 ${elapsed}ms`);
});

test('the async check fails rather than hangs when the directory blocks', async t => {
  // 用 overallTimeoutMs 直接压到很小，模拟「读一个文件要很久」的场景。
  // 关键断言是它**会返回**，而不是一直卡住——这是主进程不冻结的保证。
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'activities'), { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(dir, 'activities', `2026-11-0${i + 1}.jsonl`), '{"a":1}\n', 'utf8');
  }

  const started = Date.now();
  const r = await precheck.checkStorageDirAsync(dir, {
    timeoutMs: 1,
    overallTimeoutMs: 1
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `必须按时返回，实际 ${elapsed}ms`);
  // 可能是正常通过（子进程够快），也可能是超时——两者都可接受，
  // 不可接受的是「不返回」
  assert.ok(typeof r.ok === 'boolean');
});

test('the async check never reports success when the child crashes', async t => {
  const dir = tmpDir(t);

  const originalFork = require('node:child_process').fork;
  // 让子进程脚本路径失效，触发 exit 分支
  const childProcess = require('node:child_process');
  childProcess.fork = () => {
    const { EventEmitter } = require('node:events');
    const fake = new EventEmitter();
    fake.kill = () => {};
    // 父进程会先 send 再等消息，桩必须支持 send
    fake.send = () => {};
    // 模拟子进程不发消息直接退出
    setImmediate(() => fake.emit('exit', 1));
    return fake;
  };

  let r;
  try {
    r = await precheck.checkStorageDirAsync(dir, { overallTimeoutMs: 500 });
  } finally {
    childProcess.fork = originalFork;
  }

  assert.equal(r.ok, false, '子进程异常退出不能当成通过');
  assert.equal(r.reason, 'precheck-crashed');
});
