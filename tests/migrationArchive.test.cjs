const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/migrationFixture.cjs');

/**
 * 归档、冲突与并发（T-M08、T-M11、T-M15、T-M23、T-M24，以及写入锁与迁移的配合）。
 *
 * 这一批用例针对的是「别人同时动文件」这类最难复现的情况。它们不是假想：
 * 数据目录放在 iCloud 或 OneDrive 里，同步进程随时可能插进来。
 */

const REC = [
  { id: 'c1', timestamp: h.isoLocal(2026, 11, 5, 9), processName: 'code' },
  { id: 'c2', timestamp: h.isoLocal(2026, 11, 6, 9), processName: 'chrome' }
];

function engineFor(fx, extra = {}) {
  const { MigrationEngine } = require('../electron/legacyMigration');
  return new MigrationEngine({
    kind: fx.kind,
    sourcePath: fx.sourcePath,
    targetDir: fx.targetDir,
    dataDir: fx.dataDir,
    ...extra
  });
}

test('T-M11 a target changed between prepare and replace stops the migration as conflict', t => {
  const fx = h.makeFixture(t, {
    kind: 'activities',
    sourceRecords: REC,
    existingByDate: { '2026-11-05': [{ id: 'old', timestamp: h.isoLocal(2026, 11, 5, 8), processName: 'x' }] }
  });

  // 在 staging 全部建好、开始替换之前，外部进程改掉了 11-05
  const result = h.runCatching ? null : null;
  let outcome;
  try {
    engineFor(fx, {
      hooks: {
        F3: () => {
          const file = path.join(fx.targetDir, '2026-11-05.json');
          const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
          rows.push({ id: 'external', timestamp: h.isoLocal(2026, 11, 5, 12), processName: 'sync' });
          fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
          h.crash();
        }
      }
    }).run({ auto: true });
  } catch (error) {
    assert.equal(h.isCrash(error), true);
  }

  // 重启：staging 已就绪，但目标文件不再是「替换前那个」
  outcome = engineFor(fx).run({ auto: true });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'conflict');
  assert.equal(outcome.stage, 'pre-replace');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const status = h.readStatus(ws);
  assert.equal(status.phase, 'conflict');
  assert.equal(status.conflictDetail.date, '2026-11-05');

  // 外部写入的那条必须还在
  const rows = JSON.parse(fs.readFileSync(path.join(fx.targetDir, '2026-11-05.json'), 'utf8'));
  assert.ok(rows.some(r => r.id === 'external'), '外部新增的记录不得被覆盖');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件必须保留');
});

test('T-M15 a source that changes during finishing is neither renamed nor marked done', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });

  const outcome = engineFor(fx, {
    hooks: {
      F7: () => {
        // 目标文件已全部就位，正要做归档改名时，源文件被追加了一条
        const rows = JSON.parse(fs.readFileSync(fx.sourcePath, 'utf8'));
        rows.push({ id: 'late', timestamp: h.isoLocal(2026, 11, 7, 9), processName: 'new' });
        fs.writeFileSync(fx.sourcePath, JSON.stringify(rows, null, 2), 'utf8');
      }
    }
  }).run({ auto: true });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'conflict');
  assert.equal(outcome.detail.stage, 'pre-rename');

  assert.ok(fs.existsSync(fx.sourcePath), '源文件不得改名');
  const rows = JSON.parse(fs.readFileSync(fx.sourcePath, 'utf8'));
  assert.equal(rows.length, 3, '源文件内容必须原样保留（含新追加那条）');

  assert.equal(fs.readdirSync(fx.dataDir).filter(n => n.includes('migrated')).length, 0,
    '不得产生任何归档文件');

  // 目标文件保持已替换状态（不回退）
  assert.equal(h.totalRecords(fx.targetDir), 2, '目标文件保持已替换');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  assert.equal(h.readStatus(ws).phase, 'conflict');
});

test('T-M23 an existing .migrated is never overwritten; a unique name is used instead', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });

  // 上一次迁移留下的完整历史备份
  const oldArchive = fx.sourcePath + '.migrated';
  const oldContent = JSON.stringify([{ id: 'ancient', timestamp: h.isoLocal(2025, 1, 1, 9) }], null, 2);
  fs.writeFileSync(oldArchive, oldContent, 'utf8');

  const outcome = engineFor(fx).run({ auto: true });
  assert.equal(outcome.ok, true);
  assert.notEqual(outcome.archivedPath, oldArchive, '不能复用旧归档名');

  assert.equal(fs.readFileSync(oldArchive, 'utf8'), oldContent, '旧归档内容必须一字不改');

  const archives = fs.readdirSync(fx.dataDir).filter(n => n.startsWith('activities.json.migrated'));
  assert.equal(archives.length, 2, '两份归档必须都在');
});

test('T-M24 an archive whose hash disagrees with the source is a conflict, not done', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });

  const outcome = engineFor(fx, {
    hooks: {
      // 在 rename 刚完成、做改名后校验之前，把归档文件改掉。
      // 这模拟「rename 与校验之间被外部进程写入」。
      F5a: ({ candidate }) => {
        fs.writeFileSync(candidate, JSON.stringify([{ id: 'changed', timestamp: h.isoLocal(2026, 1, 1, 0) }]), 'utf8');
      }
    }
  }).run({ auto: true });

  assert.equal(outcome.ok, false, '改名后哈希不符不能算完成');
  assert.equal(outcome.reason, 'conflict');
  assert.equal(outcome.detail.stage, 'post-rename');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const status = h.readStatus(ws);
  assert.equal(status.phase, 'conflict');
  assert.notEqual(status.phase, 'done');

  // 三份数据全部保留
  assert.ok(fs.existsSync(outcome.detail.archivedPath), '归档文件必须保留');
  assert.equal(h.totalRecords(fx.targetDir), 2, '目标文件必须保留');
  assert.ok(fs.existsSync(path.join(ws, 'manifest.json')), '工作区必须保留');
});

test('T-M08 a custom data directory works: source in default dir, target elsewhere', t => {
  // 源文件在「默认目录」，目标在「自定义目录」——这正是 customPath 场景
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lm-custom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const defaultDir = path.join(root, 'default', 'Data');
  const customDir = path.join(root, 'custom', 'Data');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(customDir, { recursive: true });

  const sourcePath = path.join(defaultDir, 'activities.json');
  fs.writeFileSync(sourcePath, JSON.stringify(REC, null, 2), 'utf8');
  const targetDir = path.join(customDir, 'activities');
  fs.mkdirSync(targetDir, { recursive: true });

  const outcome = engineFor({ kind: 'activities', sourcePath, targetDir, dataDir: customDir }).run({ auto: true });
  assert.equal(outcome.ok, true);
  assert.equal(h.totalRecords(targetDir), 2, '数据必须落到自定义目录');

  // 源文件在它自己的目录里就地改名，不能搬到自定义目录去
  assert.equal(fs.existsSync(sourcePath), false);
  assert.ok(fs.existsSync(sourcePath + '.migrated'), '源文件的归档必须留在源目录内');
  assert.equal(fs.existsSync(path.join(customDir, 'activities.json.migrated')), false,
    '不得把归档搬到目标目录');

  // 工作区必须建在目标目录（自定义目录）下，才能保证同卷
  const ws = path.join(customDir, '.migration');
  assert.ok(fs.existsSync(ws), '.migration 必须建在 dataDir 下');
});

test('a manifest records both the source and target absolute paths', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });
  engineFor(fx).run({ auto: true });

  const ws = h.workspaceDirs(fx.dataDir)[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'manifest.json'), 'utf8'));

  assert.equal(path.resolve(manifest.sourcePath), path.resolve(fx.sourcePath));
  assert.equal(path.resolve(manifest.targetDir), path.resolve(fx.targetDir));
  assert.equal(typeof manifest.sourceSha256, 'string');
  assert.equal(manifest.sourceSha256.length, 64);
  assert.equal(manifest.sourceRecordCount, 2);
  assert.ok(Array.isArray(manifest.targets));
  assert.ok(manifest.targets.every(x => typeof x.expectedSha256 === 'string' && x.expectedSha256.length === 64));
});

test('the write gate is held during the migration and released afterwards', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  let lockedDuringStaging = null;
  let contextDuringStaging = null;
  engineFor(fx, {
    hooks: {
      F3: () => {
        lockedDuringStaging = writeGate.isLocked();
        contextDuringStaging = writeGate.inMigrationContext();
      }
    }
  }).run({ auto: true });

  assert.equal(lockedDuringStaging, true, '迁移进行中必须持锁');
  assert.equal(contextDuringStaging, true, '迁移自身必须在特权上下文内');
  assert.equal(writeGate.isLocked(), false, '迁移结束必须释放');
});

test('the gate is released even when the migration throws an unexpected error', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: REC });
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const outcome = engineFor(fx, {
    hooks: {
      F3: () => { throw new Error('磁盘突然不可写'); }
    }
  }).run({ auto: true });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'exception');
  assert.equal(writeGate.isLocked(), false, '异常路径也必须释放锁');

  const ws = h.workspaceDirs(fx.dataDir)[0];
  assert.equal(h.readStatus(ws).phase, 'failed', '不可恢复错误应进 failed 终态');
  assert.ok(fs.existsSync(fx.sourcePath), '源文件绝不能丢');
});

test('a corrupt source is left alone and nothing is migrated', t => {
  const fx = h.makeFixture(t, { kind: 'activities', withSource: false });
  fs.writeFileSync(fx.sourcePath, '{"not":"an array"}', 'utf8');

  const outcome = engineFor(fx).run({ auto: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'source-not-array');
  assert.equal(outcome.noAction, true);

  assert.equal(fs.existsSync(fx.sourcePath), true);
  assert.equal(fs.readFileSync(fx.sourcePath, 'utf8'), '{"not":"an array"}', '损坏的源文件不得被改写');
  assert.equal(h.totalRecords(fx.targetDir), 0);
});

test('an unparsable source is reported instead of guessed at', t => {
  const fx = h.makeFixture(t, { kind: 'activities', withSource: false });
  const broken = '[{"id":"a", "timestamp":';
  fs.writeFileSync(fx.sourcePath, broken, 'utf8');

  const outcome = engineFor(fx).run({ auto: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'source-unparsable');
  assert.equal(fs.readFileSync(fx.sourcePath, 'utf8'), broken);
});

test('records without a timestamp block the migration instead of being assigned a date', t => {
  const fx = h.makeFixture(t, {
    kind: 'activities',
    sourceRecords: [{ id: 'ok', timestamp: h.isoLocal(2026, 11, 5, 9) }, { id: 'no-time' }]
  });

  const outcome = engineFor(fx).run({ auto: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'source-records-without-timestamp');
  assert.equal(outcome.detail.missingTimestamp, 1);
  assert.equal(fs.existsSync(fx.sourcePath), true);
});

test('an empty source is archived so the check does not repeat on every start', t => {
  const fx = h.makeFixture(t, { kind: 'activities', sourceRecords: [] });

  const first = engineFor(fx).run({ auto: true });
  assert.equal(first.ok, true);
  assert.equal(first.phase, 'done');
  assert.equal(fs.existsSync(fx.sourcePath), false);
  assert.ok(fs.existsSync(fx.sourcePath + '.migrated'));

  const second = engineFor(fx).run({ auto: true });
  assert.equal(second.skipped, true);
});
