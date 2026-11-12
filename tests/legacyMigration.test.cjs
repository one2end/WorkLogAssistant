const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/migrationFixture.cjs');

/**
 * 活动迁移故障注入（F 系列 11 点：F1、F2、F3、F4、F4a、F5、F5a、F6、F7、F8、F9）。
 *
 * 每个注入点的断言都不是「没抛错」或「状态是 done」，而是：
 *   恢复后的目标目录与「一次跑完」的结果**逐字节相同**。
 * 这一条能同时挡住重复写入、漏写、以及字段顺序漂移三种毛病。
 */

const ACT = [
  { id: 'a1', timestamp: h.isoLocal(2026, 11, 5, 9), processName: 'code', windowTitle: '编辑中' },
  { id: 'a2', timestamp: h.isoLocal(2026, 11, 5, 10), processName: 'chrome', windowTitle: '文档' },
  { id: 'a3', timestamp: h.isoLocal(2026, 11, 6, 9), processName: 'code', windowTitle: '继续' },
  { id: 'a4', timestamp: h.isoLocal(2026, 11, 7, 14), processName: 'excel', windowTitle: '表格' }
];

/** 参照组：同一个源数据、同一个已有数据，一次跑完的哈希 */
function reference(t, existingByDate) {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: ACT, existingByDate });
  const { result } = h.runClean(fx);
  assert.equal(result.ok, true, '参照组必须成功');
  return h.snapshotDir(fx.targetDir);
}

function fixtureWith(t, existingByDate) {
  return h.makeFixture(t, { kind: 'activities', sourceRecords: ACT, existingByDate });
}

test('T-M01 F1 crash right after the manifest is written resumes and matches the clean run', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F1: () => h.crash() }));
  assert.equal(first.crashed, true, 'F1 应在写 manifest 后中断');
  assert.equal(h.workspaceDirs(fx.dataDir).length, 1, '工作区应已建立，供续跑');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected, '结果必须与一次成功逐字节相同');
});

test('T-M01 F2 crash while building the second staging file keeps the first and regenerates the rest', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F2: () => h.crash() }));
  assert.equal(first.crashed, true);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const stagingBefore = require('node:fs').readdirSync(require('node:path').join(ws, 'staging'))
    .filter(n => n.endsWith('.json') && !n.includes('pre-replace'));
  assert.equal(stagingBefore.length, 2, '前两个 staging 应已生成，第三个还没轮到');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M01 F3 crash after all staging is built goes straight to replacing', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F3: () => h.crash() }));
  assert.equal(first.crashed, true);

  const beforeReplace = h.totalRecords(fx.targetDir);
  assert.equal(beforeReplace, 0, '中断时目标目录还不该有数据');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M01 F4 crash on the second rename does not repeat the first one', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F4: () => h.crash() }));
  assert.equal(first.crashed, true);

  // 中断时第 1 个文件已就位（11-05 有两条记录）
  assert.equal(h.totalRecords(fx.targetDir), 2, '第一个日期（2 条记录）应已替换');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected, '第 1 个文件不得被再写一次');
  assert.equal(h.totalRecords(fx.targetDir), 4, '总共 4 条，不是 6 条');
});

test('T-M01 F4a crash after a rename but before status is written is detected by expectedSha256', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  // 在「rename 成功、即将写 status」之后中断：模拟 status 没写上
  const first = h.runCatching(h.makeEngine(fx, {
    F4a: (payload) => {
      // 只崩第一次，避免续跑时又被同一个钩子打断
      if (!global.__f4aTripped) {
        global.__f4aTripped = true;
        h.crash();
      }
    }
  }));
  assert.equal(first.crashed, true);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const status = h.readStatus(ws);
  assert.ok(status, 'status 文件应存在');
  assert.notEqual(status.phase, 'done');

  delete global.__f4aTripped;
  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M01 F5 a source rename that fails leaves targets placed and finishes on the next start', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  // 让归档 rename 失败：目标已全部就位，但源文件还在
  const fs = require('node:fs');
  const originalRename = fs.renameSync;
  let blocked = 0;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith('.migrated') && blocked === 0) {
      blocked += 1;
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
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

  assert.equal(first.result.ok, false, '第一次应因改名失败而不算完成');
  assert.equal(first.result.reason, 'rename-failed');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件必须还在');
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected, '目标文件此时已全部就位');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, true, '重启后应直接完成改名');
  assert.equal(fs.existsSync(fx.sourcePath), false);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M01 F5a crash after the source was archived but before status is written is recognised as done', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, {
    F5a: (payload) => {
      if (!global.__f5aTripped) {
        global.__f5aTripped = true;
        // 把刚写上的 done 抹掉，模拟「改名成功、status 未更新」
        const fs = require('node:fs');
        const path = require('node:path');
        const statusFile = path.join(payload.dir, 'status.json');
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        status.phase = 'finishing';
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
        h.crash();
      }
    }
  }));
  assert.equal(first.crashed, true);

  const archives = require('node:fs').readdirSync(fx.dataDir).filter(n => n.includes('migrated'));
  assert.equal(archives.length, 1, '归档文件应已存在');
  assert.equal(require('node:fs').existsSync(fx.sourcePath), false, '源文件应已不在原处');

  delete global.__f5aTripped;
  const second = h.runClean(fx);
  assert.equal(second.result.ok, true);
  assert.equal(second.result.phase, 'done');

  const fs = require('node:fs');
  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 1,
    '不得再生成第二份归档');
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M01 F6 two consecutive crashes still end byte-identical to a single clean run', t => {
  const expected = reference(t);
  const fx = fixtureWith(t);

  let trip = 0;
  const engine1 = h.makeEngine(fx, {
    F4: () => {
      if (trip === 0) { trip += 1; h.crash(); }
    }
  });
  const first = h.runCatching(engine1);
  assert.equal(first.crashed, true);

  // 第二次中断在第二个 staging 上
  const engine2 = h.makeEngine(fx, {
    F4: () => {
      if (trip === 1) { trip += 1; h.crash(); }
    },
    F2: () => {
      if (trip === 1) { trip += 1; h.crash(); }
    }
  });
  h.runCatching(engine2);

  const last = h.runClean(fx);
  assert.equal(last.result.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected, '两次中断后仍需逐字节等同');
});

test('T-M06 F7 a source changed while the workspace is incomplete stops with conflict and no new workspace', t => {
  const fx = fixtureWith(t);

  const first = h.runCatching(h.makeEngine(fx, { F3: () => h.crash() }));
  assert.equal(first.crashed, true);
  const workspacesBefore = h.workspaceDirs(fx.dataDir);
  assert.equal(workspacesBefore.length, 1);

  // 迁移未完成时源文件被改（新增一条）
  const fs = require('node:fs');
  const next = JSON.parse(fs.readFileSync(fx.sourcePath, 'utf8'));
  next.push({ id: 'late', timestamp: h.isoLocal(2026, 11, 8, 9), processName: 'new' });
  fs.writeFileSync(fx.sourcePath, JSON.stringify(next, null, 2), 'utf8');

  const second = h.runClean(fx);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.reason, 'source-changed');

  assert.equal(h.workspaceDirs(fx.dataDir).length, 1, '不得新建第二个工作区');
  const status = h.readStatus(workspacesBefore[0]);
  assert.equal(status.phase, 'conflict', '旧工作区应标为 conflict');
  assert.equal(h.totalRecords(fx.targetDir), 0, '目标目录不得被写入');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件必须原样保留');
});

test('T-M03 F8 existing data in the target directory is merged, not replaced', t => {
  const existing = {
    '2026-11-05': [
      { id: 'old1', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' },
      { id: 'old2', timestamp: h.isoLocal(2026, 11, 5, 11), processName: 'mail' }
    ]
  };
  const expected = reference(t, existing);
  const fx = fixtureWith(t, existing);

  const { result } = h.runClean(fx);
  assert.equal(result.ok, true);

  const fs = require('node:fs');
  const path = require('node:path');
  const day5 = JSON.parse(fs.readFileSync(path.join(fx.targetDir, '2026-11-05.json'), 'utf8'));
  assert.equal(day5.length, 4, '2 条已有 + 2 条源 = 4 条');
  assert.deepEqual(h.snapshotDir(fx.targetDir), expected);
});

test('T-M03 F8 conservation holds: after == sum(preReplaceRecordCount) + source count', t => {
  const existing = {
    '2026-11-05': [{ id: 'old1', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' }],
    '2026-11-06': [
      { id: 'old2', timestamp: h.isoLocal(2026, 11, 6, 7), processName: 'mail' },
      { id: 'old3', timestamp: h.isoLocal(2026, 11, 6, 8), processName: 'mail' }
    ]
  };
  const fx = fixtureWith(t, existing);

  const before = h.totalRecords(fx.targetDir);
  assert.equal(before, 3);

  const { result } = h.runClean(fx);
  assert.equal(result.ok, true);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(ws, 'manifest.json'), 'utf8'));
  const sumPre = manifest.targets.reduce((n, x) => n + x.preReplaceRecordCount, 0);
  const sumExpected = manifest.targets.reduce((n, x) => n + x.expectedRecordCount, 0);

  assert.equal(sumPre, before, 'manifest 的 preReplace 总数必须等于迁移前目标总数');
  assert.equal(sumExpected, sumPre + ACT.length, '守恒：预期总数 = 替换前 + 源条数');
  assert.equal(h.totalRecords(fx.targetDir), sumExpected, '落盘总数必须等于预期');
});

test('T-M05 F9 a volume that reports EXDEV refuses the migration and writes nothing', t => {
  const fx = fixtureWith(t);

  const fs = require('node:fs');
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
  assert.match(result.result.message, /同一磁盘卷/);

  assert.equal(h.totalRecords(fx.targetDir), 0, '目标目录不得被写入');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件不得被动过');
});

test('T-M05 the probe cleans up its temporary file whether it succeeds or not', t => {
  const { probeSameVolume } = require('../electron/legacyMigration');
  const fs = require('node:fs');
  const path = require('node:path');
  const fx = fixtureWith(t);

  const before = h.snapshotDir(fx.targetDir);
  const ok = probeSameVolume(fx.dataDir, fx.targetDir);
  assert.equal(ok.same, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), before, '探测不得留下残留文件');

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EXDEV'); err.code = 'EXDEV'; throw err;
  };
  let failed;
  try {
    failed = probeSameVolume(fx.targetDir, fx.dataDir);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(failed.same, false);
  assert.equal(failed.reason, 'EXDEV');
  const leftovers = fs.readdirSync(fx.targetDir).filter(n => n.includes('samevol-probe'));
  assert.equal(leftovers.length, 0, '失败路径也必须清理探测文件');
});
