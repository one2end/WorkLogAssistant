const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ActivityRecorder = require('../electron/activityRecorder');

/**
 * 写盘持续失败时的缓冲溢出（V0.10.5 任务 3）。
 *
 * 旧行为：`this._buffer = batch.concat(this._buffer).slice(-200)`
 * —— 超过 200 条的片段直接消失，日志里只有一句「写入失败」，
 * 用户不会知道少了哪些时段。这不是「防止内存无限增长」，
 * 是拿数据换内存，而且没有告知。
 *
 * 新行为：超出的部分落进 activities/<date>.overflow.jsonl，
 * 缓冲维持上限，数据一条不丢，并通过 onOverflow 让上层有机会提示。
 */

function makeRecorder(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-overflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const logs = [];
  const overflows = [];

  // 一个总失败的 storage 桩，模拟磁盘满 / 目录被锁
  const storage = {
    getDataDir: () => root,
    appendActivityRecords: () => { throw new Error('ENOSPC: no space left on device'); }
  };

  const recorder = new ActivityRecorder({
    storage,
    getConfig: () => ({}),
    onLog: (msg, level) => logs.push({ msg, level }),
    onOverflow: evt => overflows.push(evt),
    ...opts
  });
  t.after(() => recorder.stop());

  return { recorder, root, logs, overflows };
}

const at = (i) => new Date(2026, 10, 8, 9, 0, 0).toISOString();

/**
 * 直接把记录塞进缓冲，绕过 _emit 的自动 flush。
 *
 * _emit 在缓冲达到 flushBufferSize（30）时会自己 flush，所以「连续 emit 300 条
 * 再检查缓冲」看到的只是一个批次，测不出溢出上限的行为。
 * 这里要验证的是「一次 flush 面对远超上限的记录」这个场景。
 */
function emitMany(recorder, count, prefix = 'app') {
  for (let i = 0; i < count; i += 1) {
    recorder._buffer.push({ t: at(i), dur: 1000, kind: 'active', app: `${prefix}${i}`, title: '', rid: `rid-${prefix}-${i}` });
  }
}

test('records beyond the buffer cap land in an overflow file instead of vanishing', t => {
  const { recorder, root, overflows } = makeRecorder(t);

  emitMany(recorder, 300);
  assert.equal(recorder._buffer.length, 300);

  const flushed = recorder.flush();
  assert.equal(flushed, 0, '写盘失败时 flush 应报告 0 条成功');

  assert.equal(recorder._buffer.length, 200, '缓冲必须维持在上限内，不能无限增长');

  const overflowFile = path.join(root, 'activities', '2026-11-08.overflow.jsonl');
  assert.ok(fs.existsSync(overflowFile), '多出的 100 条必须落到溢出文件');

  const lines = fs.readFileSync(overflowFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 100, '溢出条数必须精确等于超出上限的部分');

  const rows = lines.map(JSON.parse);
  // 溢出的是最早的那批，顺序不能乱
  assert.equal(rows[0].app, 'app0', '最先录到的片段先溢出，保持时间顺序');
  assert.equal(rows[99].app, 'app99');

  assert.equal(overflows.length, 1);
  assert.equal(overflows[0].count, 100);
  assert.equal(overflows[0].day, '2026-11-08');
});

test('nothing is lost: overflow plus buffer equals what was recorded', t => {
  const { recorder, root } = makeRecorder(t);
  emitMany(recorder, 500);
  recorder.flush();

  const overflowFile = path.join(root, 'activities', '2026-11-08.overflow.jsonl');
  const spilled = fs.existsSync(overflowFile)
    ? fs.readFileSync(overflowFile, 'utf8').trim().split('\n').length
    : 0;

  assert.equal(spilled + recorder._buffer.length, 500,
    '溢出 + 缓冲必须等于产生的总条数，一条都不能少');
});

test('the overflow file is appended to, not overwritten, across repeated failures', t => {
  const { recorder, root } = makeRecorder(t);

  emitMany(recorder, 300);
  recorder.flush();   // 缓冲留 200，溢出 100

  // 再产生一批，再次失败。此时缓冲里已有 200（上一轮的），加 300 共 500，
  // 所以第二轮溢出 500 - 200 = 300 条。
  emitMany(recorder, 300, 'second');
  recorder.flush();

  const overflowFile = path.join(root, 'activities', '2026-11-08.overflow.jsonl');
  const lines = fs.readFileSync(overflowFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 100 + 300, '两轮渗出的总和，追加而非覆盖');

  const apps = lines.map(l => JSON.parse(l).app);
  assert.ok(apps.includes('app0'), '第一轮的记录仍在');
  assert.ok(apps.includes('second0'), '第二轮的记录也在');
  assert.equal(recorder._buffer.length, 200, '缓冲始终维持在上限内');
});

test('the overflow itself failing is reported as an error, not swallowed', t => {
  const { recorder, logs } = makeRecorder(t);
  // 让数据目录不可写：把根目录指向一个不存在的深层路径并在后面打断
  recorder.storage = {
    getDataDir: () => '/nonexistent-path-for-test\x00/flat',
    appendActivityRecords: () => { throw new Error('ENOSPC'); }
  };
  // 同时让 fs.mkdirSync 抛错
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = () => { throw new Error('EACCES: permission denied'); };
  let spilledOk;
  try {
    emitMany(recorder, 300);
    recorder.flush();
    spilledOk = recorder._buffer.length;
  } finally {
    fs.mkdirSync = originalMkdir;
  }

  assert.equal(spilledOk, 200);
  const errLog = logs.find(l => l.level === 'error' && /溢出文件不可写|仅存于内存/.test(l.msg));
  assert.ok(errLog, '溢出也失败时必须明确报错，不能静默');
});

test('a normal successful write does not create an overflow file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-ok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const written = [];
  const recorder = new ActivityRecorder({
    storage: {
      getDataDir: () => root,
      appendActivityRecords: rows => { written.push(...rows); return true; }
    },
    getConfig: () => ({}),
    onLog: () => {}
  });
  t.after(() => recorder.stop());

  emitMany(recorder, 300);
  assert.equal(recorder.flush(), 300);
  assert.equal(written.length, 300);
  assert.equal(fs.existsSync(path.join(root, 'activities', '2026-11-08.overflow.jsonl')), false,
    '正常写入不应产生溢出文件');
});

test('the migration gate still keeps every record without spilling', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const recorder = new ActivityRecorder({
    storage: {
      getDataDir: () => root,
      appendActivityRecords: () => {
        const err = new Error('迁移中');
        err.code = 'MIGRATION_IN_PROGRESS';
        throw err;
      }
    },
    getConfig: () => ({}),
    onLog: () => {}
  });
  t.after(() => recorder.stop());

  emitMany(recorder, 300);
  recorder.flush();

  // 迁移是可控的短时状态，全部留在内存，不落溢出文件
  assert.equal(recorder._buffer.length, 300, '迁移期间不截断、不溢出');
  assert.equal(fs.existsSync(path.join(root, 'activities', '2026-11-08.overflow.jsonl')), false);
});
