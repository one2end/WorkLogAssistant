const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/migrationFixture.cjs');

/**
 * 摘要迁移故障注入（S 系列 11 点：S1、S2、S3、S4、S4a、S5、S5a、S6、S7、S8、S9）。
 *
 * 与活动侧结构对称，但数值、字段、目录全部独立——共用同一批断言代码会
 * 让「摘要侧漏了某一项」查不出来，而摘要当初恰恰是被漏掉的那一半。
 */

const SUM = [
  { id: 's1', timestamp: h.isoLocal(2026, 11, 5, 21), summary: '做了两件事', activityCount: 12 },
  { id: 's2', timestamp: h.isoLocal(2026, 11, 5, 22), summary: '补记', activityCount: 3 },
  { id: 's3', timestamp: h.isoLocal(2026, 11, 6, 21), summary: '第二天的摘要', activityCount: 8 },
  { id: 's4', timestamp: h.isoLocal(2026, 11, 7, 21), summary: '第三天', activityCount: 5 }
];

function fixtureWith(t, existingByDate) {
  return h.makeFixture(t, { kind: 'summaries', sourceRecords: SUM, existingByDate });
}

function reference(t, existingByDate) {
  const fx = fixtureWith(t, existingByDate);
  const { result } = h.runClean(fx);
  assert.equal(result.ok, true, '参照组必须成功');
  return h.snapshotDir(fx.targetDir);
}

test('S1 crash after the summaries manifest is written reuses the workspace', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F1: () => h.crash() }));
  assert.equal(first.crashed, true);
  assert.equal(h.workspaceDirs(fx.dataDir).length, 1);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'summaries', 'manifest 必须标明是摘要，别与活动混用');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S2 crash on the second summaries staging keeps the first and rebuilds the rest', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  h.runCatching(h.makeEngine(fx, { F2: () => h.crash() }));
  const ws = h.workspaceDirs(fx.dataDir)[0];
  const staging = fs.readdirSync(path.join(ws, 'staging'))
    .filter(n => n.endsWith('.json') && !n.includes('pre-replace'));
  assert.equal(staging.length, 2);

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S3 crash after every summaries staging file exists goes straight to replacing', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  h.runCatching(h.makeEngine(fx, { F3: () => h.crash() }));
  assert.equal(h.totalRecords(fx.targetDir), 0);

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S4 crash on the second summaries rename does not rewrite the first', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  h.runCatching(h.makeEngine(fx, { F4: () => h.crash() }));
  assert.equal(h.totalRecords(fx.targetDir), 2, '11-05 的两条摘要应已切换');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
  assert.equal(h.totalRecords(fx.targetDir), 4, '总计 4 条，不是 6 条');
});

test('S4a crash after a summaries rename but before status is detected by expectedSha256', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const s = { tripped: false };
  const first = h.runCatching(h.makeEngine(fx, {
    F4a: () => {
      if (!s.tripped) { s.tripped = true; h.crash(); }
    }
  }));
  assert.equal(first.crashed, true);

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S5 a blocked summaries source rename finishes on the next start', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const originalRename = fs.renameSync;
  let blocked = 0;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith('.migrated') && blocked === 0) {
      blocked += 1;
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return originalRename.apply(fs, arguments);
  };
  let first;
  try {
    first = h.runClean(fx);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(first.result.ok, false);
  assert.equal(first.result.reason, 'rename-failed');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件必须还在');

  // 关键：不能停在 failed 终态，否则重启不会继续
  const ws = h.workspaceDirs(fx.dataDir)[0];
  assert.equal(h.readStatus(ws).phase, 'finishing', '改名失败只能停在非终态');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.equal(fs.existsSync(fx.sourcePath), false);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S5a crash after the summaries source was archived is recognised by the four-way check', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const s = { tripped: false };
  h.runCatching(h.makeEngine(fx, {
    F5a: (payload) => {
      if (!s.tripped) {
        s.tripped = true;
        const statusFile = path.join(payload.dir, 'status.json');
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        status.phase = 'finishing';
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
        h.crash();
      }
    }
  }));

  assert.equal(fs.existsSync(fx.sourcePath), false);
  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 1);

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.equal(second.result.phase, 'done');
  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 1,
    '不得出现第二份归档');
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S6 two crashes in the summaries run still equal one clean run', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const s = { n: 0 };
  h.runCatching(h.makeEngine(fx, {
    F4: () => { if (s.n === 0) { s.n += 1; h.crash(); } }
  }));
  h.runCatching(h.makeEngine(fx, {
    F4: () => { if (s.n === 1) { s.n += 1; h.crash(); } },
    F2: () => { if (s.n === 1) { s.n += 1; h.crash(); } }
  }));

  const last = h.runClean(fx);
  assert.equal(last.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S7 a summaries source changed mid-migration stops with conflict and no second workspace', t => {
  const fx = fixtureWith(t);

  h.runCatching(h.makeEngine(fx, { F3: () => h.crash() }));
  const workspaces = h.workspaceDirs(fx.dataDir);
  assert.equal(workspaces.length, 1);

  const next = JSON.parse(fs.readFileSync(fx.sourcePath, 'utf8'));
  next.push({ id: 'late', timestamp: h.isoLocal(2026, 11, 8, 21), summary: '新的' });
  fs.writeFileSync(fx.sourcePath, JSON.stringify(next, null, 2), 'utf8');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.reason, 'source-changed');
  assert.equal(h.workspaceDirs(fx.dataDir).length, 1, '不得新建工作区');
  assert.equal(h.readStatus(workspaces[0]).phase, 'conflict');
  assert.equal(h.totalRecords(fx.targetDir), 0);
  assert.ok(fs.existsSync(fx.sourcePath));
});

test('S8 existing summaries are merged and conservation holds', t => {
  const existing = {
    '2026-11-05': [{ id: 'olds', timestamp: h.isoLocal(2026, 11, 5, 20), summary: '早就有了' }],
    '2026-11-06': [
      { id: 'olds2', timestamp: h.isoLocal(2026, 11, 6, 8), summary: 'a' },
      { id: 'olds3', timestamp: h.isoLocal(2026, 11, 6, 9), summary: 'b' }
    ]
  };
  const expected = reference(t, existing);
  const fx = fixtureWith(t, existing);

  const before = h.totalRecords(fx.targetDir);
  const { result } = h.runClean(fx);
  assert.equal(result.ok, true);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'manifest.json'), 'utf8'));
  const sumPre = manifest.targets.reduce((n, x) => n + x.preReplaceRecordCount, 0);
  const sumExpected = manifest.targets.reduce((n, x) => n + x.expectedRecordCount, 0);

  assert.equal(sumPre, before);
  assert.equal(sumExpected, sumPre + SUM.length, '摘要守恒：预期 = 替换前 + 源条数');
  assert.equal(h.totalRecords(fx.targetDir), sumExpected);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('S9 cross-volume is refused for summaries too', t => {
  const fx = fixtureWith(t);

  const originalRename = fs.renameSync;
  fs.renameSync = function () {
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };
  let result;
  try {
    result = h.runClean(fx);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(result.result.ok, false);
  assert.equal(result.result.code, 'EXDEV');
  assert.equal(h.totalRecords(fx.targetDir), 0);
  assert.ok(fs.existsSync(fx.sourcePath));
});

test('summaries and activities workspaces never collide', t => {
  const fx = h.makeFixture(t, {
    kind: 'activities',
    sourceRecords: [{ id: 'a', timestamp: h.isoLocal(2026, 11, 5, 9), processName: 'code' }]
  });
  // 同一个 dataDir 下再放一份摘要源
  const sumSource = path.join(fx.dataDir, 'summaries.json');
  fs.writeFileSync(sumSource, JSON.stringify([
    { id: 's', timestamp: h.isoLocal(2026, 11, 5, 21), summary: 'x' }
  ]), 'utf8');

  h.runClean(fx);
  const { MigrationEngine } = require('../electron/legacyMigration');
  const sum = new MigrationEngine({
    kind: 'summaries',
    sourcePath: sumSource,
    targetDir: path.join(fx.dataDir, 'summaries'),
    dataDir: fx.dataDir
  });
  const r = sum.run({ auto: true });
  assert.equal(r.ok, true);

  const ids = fs.readdirSync(path.join(fx.dataDir, '.migration'));
  assert.equal(ids.filter(n => n.startsWith('activities-')).length, 1);
  assert.equal(ids.filter(n => n.startsWith('summaries-')).length, 1, '两套工作区必须各自独立');
  assert.equal(h.totalRecords(path.join(fx.dataDir, 'activities')), 1);
  assert.equal(h.totalRecords(path.join(fx.dataDir, 'summaries')), 1);
});
