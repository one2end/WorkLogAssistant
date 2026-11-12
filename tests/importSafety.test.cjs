const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { planImport, executeImport, collectDoneIdx, readTask } = require('../electron/importSafety');
const { computeFingerprint, fingerprintId } = require('../electron/importFingerprint');

/**
 * 导入安全（T-I01 ~ T-I15）。
 *
 * 这一组用例守的是一条底线：**导入不能删数据，也不能悄悄重复写**。
 * 所以每个用例都同时检查「总数对不对」和「原记录还在不在」，
 * 只看返回值是否 success 是不够的。
 */

function setup(t) {
  // writeGate 的状态是模块级的。前一用例若因断言中断而没释放锁，
  // 后面的写入会全部被拒，表现为「记录数莫名是 0 或翻倍」。
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 必须清缓存：storageManager 在模块加载时就把 `app.getPath` 的结果固定下来了，
  // require 缓存命中时后续用例会继续用第一个用例的目录，
  // 表现为「所有用例都在往同一个 tmpdir 里写」。
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) {
      delete require.cache[key];
    }
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
  const dataDir = storage.getDataDir();
  for (const d of ['activities', 'summaries', 'summaries_md']) {
    fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  }
  return { storage, dataDir };
}

const iso = (d, h = 9) => new Date(2026, 10, d, h, 0, 0).toISOString();

function source(n = 3) {
  return {
    version: '1.0',
    exportDate: '2026-11-12T01:00:00Z',
    activities: Array.from({ length: n }, (_, i) => ({
      timestamp: iso(5 + (i % 3), 9 + i),
      processName: 'app' + i,
      windowTitle: '标题 ' + i,
      durationMs: 60000
    })),
    summaries: [
      { timestamp: iso(5, 21), summary: '摘要一', activityCount: 5 },
      { timestamp: iso(6, 21), summary: '摘要二', activityCount: 8 }
    ]
  };
}

function countAll(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(rows)) n += rows.length;
    } catch (_) { /* 坏文件不计 */ }
  }
  return n;
}

function runImport(ctx) {
  const plan = planImport(ctx);
  const result = executeImport({ ...ctx, plan });
  return { plan, result };
}

test('T-I01 a merge import never clears the records already there', t => {
  const { storage, dataDir } = setup(t);

  const existing = [
    { timestamp: iso(1), processName: 'old-a' },
    { timestamp: iso(1, 10), processName: 'old-b' }
  ];
  fs.writeFileSync(path.join(dataDir, 'activities', '2026-11-01.json'),
    JSON.stringify(existing, null, 2), 'utf8');

  const before = countAll(path.join(dataDir, 'activities'));
  assert.equal(before, 2);

  runImport({ dataDir, storage, sourceJson: source(3), sourceName: 'export.json' });

  const after = countAll(path.join(dataDir, 'activities'));
  assert.equal(after, 5, '2 条原有 + 3 条导入 = 5，绝不能被清空');
  assert.ok(after > before, '记录数必须增加而不是归零');
});

test('T-I02 the snapshot covers all three directories with matching counts', t => {
  const { storage, dataDir } = setup(t);

  fs.writeFileSync(path.join(dataDir, 'activities', '2026-11-01.json'),
    JSON.stringify([{ timestamp: iso(1), processName: 'a' }]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'summaries', '2026-11-01.json'),
    JSON.stringify([{ timestamp: iso(1), summary: 's' }]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'summaries_md', 'summary_x.md'), '# md', 'utf8');

  const before = {
    activities: fs.readdirSync(path.join(dataDir, 'activities')).length,
    summaries: fs.readdirSync(path.join(dataDir, 'summaries')).length,
    summaries_md: fs.readdirSync(path.join(dataDir, 'summaries_md')).length
  };

  const snap = storage.snapshotBeforeImport('import-merge');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.counts, before, '三目录计数必须与导入前一致');

  for (const d of ['activities', 'summaries', 'summaries_md']) {
    assert.equal(fs.readdirSync(path.join(snap.snapshotPath, d)).length, before[d], `${d} 快照不完整`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(snap.snapshotPath, 'snapshot-manifest.json'), 'utf8'));
  assert.equal(manifest.trigger, 'import-merge');
  assert.deepEqual(manifest.counts, before);
});

test('two snapshots in the same second do not overwrite each other', t => {
  const { storage, dataDir } = setup(t);
  fs.writeFileSync(path.join(dataDir, 'activities', '2026-11-01.json'), '[]', 'utf8');
  const a = storage.snapshotBeforeImport('t1');
  const b = storage.snapshotBeforeImport('t2');
  assert.notEqual(a.snapshotPath, b.snapshotPath);
  assert.ok(fs.existsSync(a.snapshotPath) && fs.existsSync(b.snapshotPath));
});

test('T-I03 per-record statistics are accurate when a write fails', t => {
  const { storage, dataDir } = setup(t);
  const src = source(5);

  // 让第 2、4 条（0 基）写入失败
  const originalSave = storage.saveActivity.bind(storage);
  let calls = 0;
  storage.saveActivity = rec => {
    const n = calls;
    calls += 1;
    if (n === 2 || n === 4) return false;
    return originalSave(rec);
  };

  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  assert.equal(result.activities.total, 5);
  assert.equal(result.activities.succeeded, 3);
  assert.equal(result.activities.failed, 2);
  assert.equal(result.activities.skipped, 0);
  assert.equal(countAll(path.join(dataDir, 'activities')), 3, '只有成功的 3 条落盘');
});

test('T-I03 records missing required fields count as failed, not silently dropped', t => {
  const { storage, dataDir } = setup(t);
  const src = {
    activities: [
      { timestamp: iso(5), processName: 'ok' },
      { timestamp: iso(5) },
      { processName: 'no-time' },
      null
    ],
    summaries: []
  };
  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(result.activities.total, 4);
  assert.equal(result.activities.succeeded, 1);
  assert.equal(result.activities.failed, 3);
  assert.equal(countAll(path.join(dataDir, 'activities')), 1);
});

test('T-I04 no production code calls clearActivities', () => {
  const root = path.resolve(__dirname, '..');
  const offenders = [];

  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'dist-electron', 'tests'].includes(name)) continue;
        scan(p);
        continue;
      }
      if (!/\.(js|cjs|mjs|vue)$/.test(name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      // 只找调用，不找定义
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/\.clearActivities\s*\(/.test(line)) return;
        if (/^\s*clearActivities\s*\(/.test(line)) return;
        offenders.push(`${path.relative(root, p)}:${i + 1}`);
      });
    }
  };
  scan(path.join(root, 'electron'));
  scan(path.join(root, 'src'));
  scan(path.join(root, 'mcp'));

  assert.deepEqual(offenders, [], `以下位置仍在调用 clearActivities：${offenders.join(', ')}`);
});

test('T-I09 resuming after a crash skips everything already written', t => {
  const { storage, dataDir } = setup(t);
  const src = source(10);

  // 写到第 4 条之后「崩溃」：抛出后调用方视为中断
  let crash = true;
  const hooks = {
    afterWrite: (list, idx) => {
      if (crash && idx === 3) {
        crash = false;
        const err = new Error('SIMULATED_CRASH');
        err.simulatedCrash = true;
        throw err;
      }
    }
  };

  let crashed = false;
  try {
    const plan = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
    executeImport({ dataDir, storage, sourceJson: src, plan, hooks });
  } catch (error) {
    assert.equal(error.simulatedCrash, true);
    crashed = true;
  }
  assert.equal(crashed, true, '需要在第 4 条后中断');

  const afterCrash = countAll(path.join(dataDir, 'activities'));
  assert.equal(afterCrash, 4, '前 4 条已落盘');

  // 重启后继续
  const { plan, result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json', mode: 'continue' });
  assert.equal(plan.mode, 'continue', '默认应走继续');
  assert.equal(result.activities.skipped, 4, '前 4 条应被识别为已完成');
  assert.equal(result.activities.succeeded, 6);

  assert.equal(countAll(path.join(dataDir, 'activities')), 10, '总数必须是 10，不是 14');
});

test('T-I10 data written but progress not flushed is still detected via imp', t => {
  const { storage, dataDir } = setup(t);
  const src = source(6);

  const plan = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  executeImport({ dataDir, storage, sourceJson: src, plan });

  // 人为把任务文件退回到「一条都没做」的状态，模拟 progress 没写成功
  const taskFile = path.join(dataDir, '.import-tasks', `${plan.fingerprintId}.json`);
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  task.status = 'in_progress';
  task.doneIdx = { activities: [], summaries: [] };
  task.counts.activities.done = 0;
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');

  // 再跑一次「继续」：应以数据里的 imp 为准，不重复写
  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json', mode: 'continue' });
  assert.equal(result.activities.skipped, 6, 'progress 陈旧时以 imp 判定');
  assert.equal(countAll(path.join(dataDir, 'activities')), 6);
});

test('T-I11 two identical records in one file both get imported', t => {
  const { storage, dataDir } = setup(t);
  const same = { timestamp: iso(5, 10), processName: 'same', windowTitle: '一模一样' };
  const src = { activities: [{ ...same }, { ...same }], summaries: [] };

  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(result.activities.succeeded, 2);
  assert.equal(countAll(path.join(dataDir, 'activities')), 2, '合法的重复必须保留，不能合并成 1 条');

  const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'activities', '2026-11-05.json'), 'utf8'));
  const idxs = rows.map(r => r.imp.idx).sort();
  assert.deepEqual(idxs, [0, 1], '两条的 imp.idx 必须不同');
});

test('T-I12 restarting a completed import creates a new batch and warns', t => {
  const { storage, dataDir } = setup(t);
  const src = source(3);

  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  const firstBatch = readTask(dataDir, fingerprintId(computeFingerprint(src).fingerprint)).batch;

  const again = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(again.action, 'already-completed', '第二次应先提示已导入');

  const forced = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json', mode: 'restart' });
  assert.equal(forced.action, 'restart-completed');
  assert.notEqual(forced.batch, firstBatch, '新批次必须与旧批次不同');
  assert.match(forced.warning, /重复/, '必须明确警告会产生重复');

  // 强制执行，重复是已知且被允许的后果
  executeImport({ dataDir, storage, sourceJson: src, plan: forced });
  assert.equal(countAll(path.join(dataDir, 'activities')), 6, '强制重导会让记录翻倍，这是已警告的后果');
});

test('T-I13 a summary whose Markdown failed is not rewritten on resume', t => {
  const { storage, dataDir } = setup(t);
  const src = source(2);

  // 让 MD 写入失败
  const originalMd = storage.rebuildSummaryMarkdown.bind(storage);
  let mdCalls = 0;
  storage.rebuildSummaryMarkdown = s => { mdCalls += 1; return originalMd(s); };

  const originalWrite = storage.saveSummaryDetailed.bind(storage);
  storage.saveSummaryDetailed = summary => {
    const r = originalWrite(summary);
    // 强行把 md 标记为失败，模拟 MD 目录不可写
    return { ...r, mdOk: false };
  };

  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(result.summaries.succeeded, 2, 'JSON 成功即算已导入');
  assert.equal(result.summaries.mdFailed, 2, 'MD 失败单独计数');

  const jsonCountBefore = countAll(path.join(dataDir, 'summaries'));
  assert.equal(jsonCountBefore, 2);

  // 第一次全部成功（JSON 层面），任务应标记为 completed；
  // 再次导入应提示「已导入」，而不是重写 JSON
  const { plan: again, result: second } = runImport({
    dataDir, storage, sourceJson: src, sourceName: 'x.json'
  });
  assert.equal(again.action, 'already-completed', '应识别为已导入过');
  assert.equal(second.summaries.skipped, 2, '已导入的摘要应被跳过');
  assert.equal(countAll(path.join(dataDir, 'summaries')), 2, 'JSON 条数不能因续传而增加');
});

test('T-I13 rebuilding Markdown does not add JSON records', t => {
  const { storage, dataDir } = setup(t);
  const src = source(2);
  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const before = countAll(path.join(dataDir, 'summaries'));
  const { rebuildMissingMarkdown } = require('../electron/importSafety');
  // 先删掉 MD，模拟半成功
  const mdDir = path.join(dataDir, 'summaries_md');
  for (const f of fs.readdirSync(mdDir)) fs.unlinkSync(path.join(mdDir, f));
  assert.equal(fs.readdirSync(mdDir).length, 0);

  const r = rebuildMissingMarkdown({ dataDir, storage, sourceJson: src });
  assert.equal(r.rebuilt, 2);
  assert.equal(fs.readdirSync(mdDir).length, 2, 'MD 应被重建');
  assert.equal(countAll(path.join(dataDir, 'summaries')), before, 'JSON 条数不能变');
});

test('T-I14 every original field survives byte for byte, plus imp', t => {
  const { storage, dataDir } = setup(t);
  const original = {
    timestamp: iso(5, 10),
    processName: 'code',
    windowTitle: '一个标题',
    durationMs: 123456,
    kind: 'active',
    platform: 'windows',
    cat: '工作',
    project: '项目 A',
    source: 'manual',
    nested: { deep: { value: 42 }, list: [1, 2, 3] },
    unicode: '中文·标点「」'
  };
  const src = { activities: [original], summaries: [] };

  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'activities', '2026-11-05.json'), 'utf8'));
  assert.equal(rows.length, 1);
  const saved = rows[0];

  for (const key of Object.keys(original)) {
    assert.deepEqual(saved[key], original[key], `字段 ${key} 必须原样保留`);
  }
  assert.ok(saved.imp, '必须附加 imp');
  assert.equal(typeof saved.imp.batch, 'string');
  assert.equal(saved.imp.idx, 0);

  // 除 imp 外不应有新增字段
  const extra = Object.keys(saved).filter(k => k !== 'imp' && !(k in original));
  assert.deepEqual(extra, [], `不应引入额外字段：${extra.join(', ')}`);
});

test('T-I15 a partially failed import defaults to continue, not restart', t => {
  const { storage, dataDir } = setup(t);
  const src = source(6);

  const originalSave = storage.saveActivity.bind(storage);
  let n = 0;
  storage.saveActivity = rec => {
    n += 1;
    if (n === 3) return false;
    return originalSave(rec);
  };

  const { result } = runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(result.activities.failed, 1);
  assert.equal(result.taskStatus, 'in_progress');

  const plan = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(plan.action, 'resume-available');
  assert.equal(plan.mode, 'continue', '默认必须是继续，不能是重新开始');
});

test('a mismatched fingerprint version does not claim the file was imported', t => {
  const { storage, dataDir } = setup(t);
  const src = source(2);
  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const fp16 = fingerprintId(computeFingerprint(src).fingerprint);
  const taskFile = path.join(dataDir, '.import-tasks', `${fp16}.json`);
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  task.fingerprintVersion = 3;
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');

  const plan = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });
  assert.equal(plan.action, 'version-mismatch');
  assert.match(plan.warning, /无法确认/);
  assert.notEqual(plan.action, 'already-completed');
});

test('an abort request stops before writing anything', t => {
  const { storage, dataDir } = setup(t);
  const src = source(3);

  // 先制造一个未完成的任务
  let n = 0;
  const originalSave = storage.saveActivity.bind(storage);
  storage.saveActivity = rec => {
    n += 1;
    if (n === 2) return false;
    return originalSave(rec);
  };
  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const before = countAll(path.join(dataDir, 'activities'));
  const plan = planImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json', mode: 'abort' });
  assert.equal(plan.blocked, true);
  assert.equal(countAll(path.join(dataDir, 'activities')), before, '取消不得写入任何数据');
});

test('every new summary write honours the migration gate', t => {
  const { storage, dataDir } = setup(t);
  const writeGate = require('../electron/writeGate');

  const summary = { timestamp: iso(5, 21), summary: '锁测试', activityCount: 1 };

  writeGate.tryAcquire('audit', 'locking');
  try {
    for (const [name, fn] of [
      ['saveSummaryDetailed', () => storage.saveSummaryDetailed(summary)],
      ['rebuildSummaryMarkdown', () => storage.rebuildSummaryMarkdown(summary)],
      ['snapshotBeforeImport', () => storage.snapshotBeforeImport('audit')]
    ]) {
      let code = null;
      try { fn(); } catch (e) { code = e.code; }
      assert.equal(code, 'MIGRATION_IN_PROGRESS', `${name} 必须在迁移期间被拒绝`);
    }
  } finally {
    writeGate.release('audit');
  }

  // 锁释放后应恢复正常
  const r = storage.saveSummaryDetailed(summary);
  assert.equal(r.jsonOk, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'summaries_md')));
});

test('the import task state machine only ever holds two values', t => {
  const { storage, dataDir } = setup(t);
  const src = source(3);
  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const fp16 = fingerprintId(computeFingerprint(src).fingerprint);
  const task = readTask(dataDir, fp16);
  assert.ok(['in_progress', 'completed'].includes(task.status),
    `任务状态只能是 in_progress 或 completed，实际：${task.status}`);
  assert.equal(task.status, 'completed');
  assert.ok(Array.isArray(task.doneIdx.activities));
});

test('importSafety never deletes user data', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../electron/importSafety.js'), 'utf8');
  for (const forbidden of ['unlinkSync', 'rmSync', 'clearActivities', 'truncate']) {
    assert.equal(text.includes(forbidden), false,
      `importSafety 不应出现 ${forbidden}——导入是只增操作`);
  }
});

test('collectDoneIdx reads imp markers across multiple day files', t => {
  const { storage, dataDir } = setup(t);
  const src = source(5);
  runImport({ dataDir, storage, sourceJson: src, sourceName: 'x.json' });

  const task = readTask(dataDir, fingerprintId(computeFingerprint(src).fingerprint));
  const done = collectDoneIdx(path.join(dataDir, 'activities'), task.batch);
  assert.equal(done.size, 5, '跨多个日期文件也要收集完整');
  assert.deepEqual(Array.from(done).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});
