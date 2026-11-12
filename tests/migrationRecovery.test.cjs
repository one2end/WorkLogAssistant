const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/migrationFixture.cjs');

/**
 * 回滚与人工介入（§2.8 五个分支、T-M07、T-M12、T-M13、T-M14、T-M25）。
 *
 * 回滚最危险的写法是「拿备份覆盖回去」——迁移之后用户新录的数据不在任何备份里。
 * 所以这里每个用例都盯着同一件事：**不属于这次迁移的数据一个字都不能动**。
 */

const REC = [
  { id: 'r1', timestamp: h.isoLocal(2026, 11, 5, 9), processName: 'code' },
  { id: 'r2', timestamp: h.isoLocal(2026, 11, 5, 10), processName: 'chrome' },
  { id: 'r3', timestamp: h.isoLocal(2026, 11, 6, 9), processName: 'code' }
];

function migrated(t, existingByDate) {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC, existingByDate });
  const { result } = h.runClean(fx);
  assert.equal(result.ok, true, '前置迁移必须成功');
  return fx;
}

function engineFor(fx) {
  const { MigrationEngine } = require('../electron/legacyMigration');
  return new MigrationEngine({
    kind: fx.kind,
    sourcePath: fx.sourcePath,
    targetDir: fx.targetDir,
    dataDir: fx.dataDir
  });
}

test('T-M07 rollback restores every date and leaves new dates untouched', t => {
  const existing = {
    // 迁移前 11-05 只有 1 条旧记录，迁移后会变成 3 条
    '2026-11-05': [{ id: 'old', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' }]
  };
  const fx = migrated(t, existing);
  const beforeMigration = JSON.parse(fs.readFileSync(path.join(fx.targetDir, '2026-11-05.json'), 'utf8'));
  assert.equal(beforeMigration.length, 3);

  // 迁移期间/之后新增了一个完全不在 manifest 里的日期
  const nextDay = path.join(fx.targetDir, '2026-11-09.json');
  const nextDayContent = JSON.stringify([
    { id: 'new', timestamp: h.isoLocal(2026, 11, 9, 9), processName: 'after-migration' }
  ], null, 2);
  fs.writeFileSync(nextDay, nextDayContent, 'utf8');

  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, true, '无冲突时应回滚成功');
  assert.equal(rb.phase, 'rolledback');

  const day5 = JSON.parse(fs.readFileSync(path.join(fx.targetDir, '2026-11-05.json'), 'utf8'));
  assert.equal(day5.length, 1, '必须回到迁移前的 1 条');
  assert.equal(day5[0].id, 'old');

  // 11-06 是迁移新建的，回滚应删除
  assert.equal(fs.existsSync(path.join(fx.targetDir, '2026-11-06.json')), false);

  // 迁移后新增的日期一个字都不能动
  assert.equal(fs.readFileSync(nextDay, 'utf8'), nextDayContent, '新日期内容必须逐字节不变');
});

test('T-M13 a rolledback workspace is terminal and never migrates again', t => {
  const fx = migrated(t);
  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, true);

  const countsAfterRollback = h.snapshotDir(fx.targetDir);

  // 模拟重启 5 次
  for (let i = 0; i < 5; i += 1) {
    const r = h.runClean(fx);
    assert.equal(r.result.ok !== true || r.result.skipped === true, true,
      `第 ${i + 1} 次重启不得成功重跑迁移`);
  }

  assert.deepEqual(h.snapshotDir(fx.targetDir), countsAfterRollback, '记录数必须不变');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  assert.equal(h.readStatus(ws).phase, 'rolledback', 'rolledback 必须保持终态');
});

test('T-M13 rollback restores the source file name so the data is not stranded', t => {
  const fx = migrated(t);
  assert.equal(fs.existsSync(fx.sourcePath), false, '迁移后源文件已归档');
  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 1);

  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, true);
  assert.ok(fs.existsSync(fx.sourcePath), '源文件应改回原名');
  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 0,
    '归档文件应已改名回去，不留副本');
});

test('T-M14 a target modified after the migration is isolated, never overwritten', t => {
  const existing = { '2026-11-05': [{ id: 'old', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' }] };
  const fx = migrated(t, existing);

  // 迁移之后，用户又往 11-05 里录了一条（不在任何备份里）
  const day5 = path.join(fx.targetDir, '2026-11-05.json');
  const rows = JSON.parse(fs.readFileSync(day5, 'utf8'));
  rows.push({ id: 'user-added', timestamp: h.isoLocal(2026, 11, 5, 15), processName: 'manual' });
  const edited = JSON.stringify(rows, null, 2);
  fs.writeFileSync(day5, edited, 'utf8');

  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, false, '有冲突时不能宣称回滚完成');
  assert.equal(rb.phase, 'conflict');

  assert.equal(fs.readFileSync(day5, 'utf8'), edited, '被改过的目标文件必须原样保留');

  const isolated = path.join(h.workspaceDirs(fx.dataDir)[0], 'conflict-files', '2026-11-05.json');
  assert.ok(fs.existsSync(isolated), '冲突文件应复制到 conflict-files/');
  assert.equal(fs.readFileSync(isolated, 'utf8'), edited, '隔离副本也应是同一份内容');
});

test('T-M25 a target that disappeared unexpectedly is not silently restored', t => {
  const existing = { '2026-11-05': [{ id: 'old', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' }] };
  const fx = migrated(t, existing);

  const day5 = path.join(fx.targetDir, '2026-11-05.json');
  fs.unlinkSync(day5);

  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, false);
  assert.equal(rb.phase, 'conflict');
  assert.equal(fs.existsSync(day5), false,
    '文件原本存在、现在缺失，原因无法确认——不得擅自用备份重建');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const status = h.readStatus(ws);
  const files = status.conflictDetail.files;
  assert.equal(files.length, 1);
  assert.equal(files[0].reason, 'target-missing-unexpectedly');

  // 备份必须保留，供人工决定；内容是「替换前」那一份，不是迁移后的
  assert.ok(fs.existsSync(files[0].backupPath), '备份必须留在 staging 里');
  const backupRows = JSON.parse(fs.readFileSync(files[0].backupPath, 'utf8'));
  assert.equal(backupRows.length, 1);
  assert.equal(backupRows[0].id, 'old');
});

test('rolling back twice is idempotent and reports the terminal state', t => {
  const fx = migrated(t);
  const engine = engineFor(fx);

  const first = engine.rollback({});
  assert.equal(first.ok, true);
  const snap = h.snapshotDir(fx.targetDir);

  const second = engineFor(fx).rollback({});
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'already-rolled-back');
  assert.deepEqual(h.snapshotDir(fx.targetDir), snap);
});

test('a partially rolled-back run skips files that are already back to their original state', t => {
  const existing = {
    '2026-11-05': [{ id: 'old', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'slack' }],
    '2026-11-06': [{ id: 'old2', timestamp: h.isoLocal(2026, 11, 6, 7), processName: 'mail' }]
  };
  const fx = migrated(t, existing);

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'manifest.json'), 'utf8'));
  const target05 = manifest.targets.find(x => x.date === '2026-11-05');

  // 手动把 11-05 恢复成替换前的样子，模拟「上次回滚走到一半」
  fs.copyFileSync(path.join(ws, target05.preReplaceBackup), path.join(fx.targetDir, '2026-11-05.json'));

  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, true, '已回到原状态的文件应被跳过而不是判冲突');
  assert.ok(rb.skipped.some(x => x.date === '2026-11-05' && x.reason === 'already-pre-replace'));

  const day6 = JSON.parse(fs.readFileSync(path.join(fx.targetDir, '2026-11-06.json'), 'utf8'));
  assert.equal(day6.length, 1, '11-06 也应恢复成替换前的 1 条');
});

test('accepting the current result archives the workspace without touching data', t => {
  const fx = migrated(t);
  const snap = h.snapshotDir(fx.targetDir);

  const engine = engineFor(fx);
  const accepted = engine.archiveWorkspace('accepted', {});
  assert.equal(accepted.ok, true);
  assert.match(path.basename(accepted.workspace), /\.accepted-\d/);

  assert.deepEqual(h.snapshotDir(fx.targetDir), snap, '「接受结果」不得改动任何数据文件');
  const status = h.readStatus(accepted.workspace);
  assert.equal(status.archivedOutcome, 'accepted');
});

test('abandoning keeps the current data and renames the workspace', t => {
  const fx = migrated(t);
  const snap = h.snapshotDir(fx.targetDir);

  const engine = engineFor(fx);
  const abandoned = engine.archiveWorkspace('abandoned', {});
  assert.equal(abandoned.ok, true);
  assert.deepEqual(h.snapshotDir(fx.targetDir), snap, '放弃不等于还原（§2.14 必须写明）');

  // 放弃之后，源已归档、工作区已改名，再次启动应是干净的 skipped
  const r = h.runClean(fx);
  assert.equal(r.result.skipped, true);
});

test('rollback refuses while another migration holds the gate', t => {
  const fx = migrated(t);
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  writeGate.tryAcquire('someone-else', 'busy');
  const rb = engineFor(fx).rollback({});
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, 'another-migration-running');
});
