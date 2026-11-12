'use strict';

/**
 * importSafety.js — 导入批次、安全续传与逐条统计
 *
 * 设计依据：docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md §3.3 / §3.4 / §3.6
 *
 * 要解决的问题：
 *   导入是把几百上千条记录逐条写进按天文件。中途断电、崩溃、被用户关掉，
 *   都会留下「写了一半」的状态。原来的实现没有留下任何痕迹，重试就是从
 *   第一条重新写一遍——已经写进去的那些会变成两条。
 *
 * 解法：**在数据落盘时就带上可追溯的身份**。
 *   每条导入的记录附一个 imp = { batch, idx }，batch 标识这一次导入，
 *   idx 是它在源数组里的下标。重试时扫描目标文件，收集已有的
 *   imp.batch === 本批次 的 idx，跳过它们。这样「哪些已经写过」由数据本身
 *   回答，不依赖任何事后写的进度文件。
 *
 *   progress.json 仍然写，但它只是加速缓存：它可能滞后，也可能根本没写成，
 *   而数据里的 imp 一定是在写入成功之后才存在的。
 *
 * 边界（不承诺 exactly-once）：
 *   · 崩溃后选「继续」→ 不重复
 *   · 崩溃后选「重新开始」→ 会产生重复（新批次无法与旧批次匹配），必须警告
 *   · 用户手工删掉部分记录再重试 → 会重导（无法区分「已删」与「未导入」）
 *   · saveActivity 返回 true 但实际没落盘 → 可能重复，依赖 atomicFile 的语义
 */

const fs = require('fs');
const path = require('path');

const { computeFingerprint, fingerprintId, FINGERPRINT_VERSION } = require('./importFingerprint');

const TASKS_DIR = '.import-tasks';

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function newBatchId(seed) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${seed}-${t}${r}`;
}

// --- 任务文件 ---

function taskPath(dataDir, fp16) {
  return path.join(dataDir, TASKS_DIR, `${fp16}.json`);
}

function readTask(dataDir, fp16) {
  return readJsonSafe(taskPath(dataDir, fp16), null);
}

function writeTask(dataDir, task) {
  task.updatedAt = nowIso();
  writeJsonSafe(taskPath(dataDir, task.fingerprintId), task);
  return task;
}

/**
 * 读目标目录里已有的 imp 标记，得出「这个批次已经写过哪些 idx」。
 *
 * 这是续传的事实来源。逐文件解析而不是逐行，因为导入写的是
 * activities/<date>.json（JSON 数组），不是 jsonl。
 *
 * @param {string} dir 按天文件目录
 * @param {string} batch 批次号
 * @returns {Set<number>}
 */
function collectDoneIdx(dir, batch) {
  const done = new Set();
  if (!fs.existsSync(dir)) return done;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return done; }

  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const rows = readJsonSafe(path.join(dir, name), null);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || !row.imp || typeof row.imp !== 'object') continue;
      if (row.imp.batch !== batch) continue;
      if (typeof row.imp.idx === 'number') done.add(row.imp.idx);
    }
  }
  return done;
}

// --- 主流程 ---

/**
 * 决定这次导入该怎么走。
 *
 * @param {object} ctx
 * @param {string} ctx.dataDir
 * @param {object} ctx.sourceJson 解析后的导入文件
 * @param {string} ctx.sourceName 文件名，仅用于展示
 * @param {string} [ctx.sourceSha256] 原始字节哈希，仅审计
 * @param {'continue'|'restart'|'auto'|'abort'} [ctx.mode]
 * @returns {object}
 */
function planImport(ctx) {
  const { dataDir, sourceJson } = ctx;
  const fp = computeFingerprint(sourceJson);
  const fp16 = fingerprintId(fp.fingerprint);
  const task = readTask(dataDir, fp16);

  const plan = {
    fingerprint: fp.fingerprint,
    fingerprintVersion: fp.version,
    fingerprintId: fp16,
    activityTotal: fp.activityCount,
    summaryTotal: fp.summaryCount,
    previousTask: task,
    batch: null,
    mode: null,
    alreadyDone: { activities: new Set(), summaries: new Set() },
    action: null,
    warning: null,
    blocked: false
  };

  // 没有历史任务：全新导入
  if (!task) {
    plan.action = 'new';
    plan.mode = 'new';
    plan.batch = fp16;
    return plan;
  }

  // 版本不一致：无法判断是否同一份文件，宁可多导一次
  if (task.fingerprintVersion !== FINGERPRINT_VERSION) {
    plan.action = 'version-mismatch';
    plan.mode = 'new';
    plan.batch = newBatchId(fp16);
    plan.warning = '该文件可能曾以旧版本算法导入过，无法确认，将按新导入处理';
    return plan;
  }

  if (task.status === 'completed') {
    plan.action = 'already-completed';
    plan.batch = task.batch;
    // 即便已完成，也把已写入的 idx 收集起来。调用方若在「已导入」提示下
    // 仍走到执行阶段，至少能保证不重复写。
    plan.alreadyDone.activities = collectDoneIdx(path.join(dataDir, 'activities'), task.batch);
    plan.alreadyDone.summaries = collectDoneIdx(path.join(dataDir, 'summaries'), task.batch);
    if (ctx.mode === 'restart') {
      plan.mode = 'restart';
      plan.batch = newBatchId(fp16);
      plan.alreadyDone = { activities: new Set(), summaries: new Set() };
      plan.warning = '该文件此前已完整导入，重新导入会产生重复数据，建议先确认备份';
      plan.action = 'restart-completed';
    } else {
      // 默认不动：已完成就是已完成，不重复写
      plan.mode = 'continue';
    }
    return plan;
  }

  if (task.status === 'in_progress') {
    plan.batch = task.batch;
    plan.alreadyDone.activities = collectDoneIdx(path.join(dataDir, 'activities'), task.batch);
    plan.alreadyDone.summaries = collectDoneIdx(path.join(dataDir, 'summaries'), task.batch);
    plan.action = 'resume-available';

    if (ctx.mode === 'restart') {
      // 新批次与旧批次互不干扰，但旧批次的记录不会被删除 → 会产生重复
      plan.mode = 'restart';
      plan.batch = newBatchId(fp16);
      plan.alreadyDone = { activities: new Set(), summaries: new Set() };
      plan.warning = '重新开始会产生重复数据（旧批次的记录无法安全区分），建议先备份';
      plan.action = 'restart-in-progress';
    } else if (ctx.mode === 'abort') {
      plan.blocked = true;
      return plan;
    } else {
      // 默认走「继续」——方案 §3.4 约束①：默认优先继续而非重新开始
      plan.mode = 'continue';
    }
    return plan;
  }

  // status 是 aborted 或其他值：当新任务处理
  plan.action = 'previous-aborted';
  plan.mode = 'new';
  plan.batch = newBatchId(fp16);
  return plan;
}

/**
 * 执行逐条写入。
 *
 * @param {object} ctx
 * @param {string} ctx.dataDir
 * @param {object} ctx.storage   StorageManager 实例
 * @param {object} ctx.sourceJson
 * @param {object} ctx.plan      planImport() 的返回值
 * @param {Function} [ctx.onProgress] 每当刷进度时回调
 * @param {object} [ctx.hooks]   测试注入：{ beforeWrite(list, idx), afterWrite(list, idx, ok) }
 * @returns {object} 结构化统计
 */
function executeImport(ctx) {
  const { dataDir, storage, sourceJson, plan } = ctx;
  const hooks = ctx.hooks || {};
  const list = Array.isArray(sourceJson.activities) ? sourceJson.activities : [];
  const summaries = Array.isArray(sourceJson.summaries) ? sourceJson.summaries : [];

  const result = {
    activities: { total: list.length, succeeded: 0, failed: 0, skipped: 0 },
    summaries: { total: summaries.length, succeeded: 0, failed: 0, skipped: 0, mdFailed: 0 },
    batch: plan.batch,
    mode: plan.mode,
    warning: plan.warning || null,
    interrupted: false,
    mdIncomplete: false
  };

  // 全新批次：先登记任务，让「导入中」这个事实先落盘
  const task = {
    fingerprint: plan.fingerprint,
    fingerprintVersion: plan.fingerprintVersion,
    fingerprintId: plan.fingerprintId,
    sourceName: ctx.sourceName || null,
    sourceSha256: ctx.sourceSha256 || null,
    batch: plan.batch,
    createdAt: (plan.previousTask && plan.mode === 'continue')
      ? plan.previousTask.createdAt
      : nowIso(),
    updatedAt: nowIso(),
    status: 'in_progress',
    counts: {
      activities: { total: list.length, done: 0, failed: 0, skipped: 0 },
      summaries: { total: summaries.length, done: 0, failed: 0, skipped: 0, mdFailed: 0 }
    },
    doneIdx: { activities: [], summaries: [] }
  };

  // 续传时沿用已有的 doneIdx 作为缓存
  const doneIdx = {
    activities: plan.mode === 'continue'
      ? new Set(plan.alreadyDone.activities)
      : new Set(),
    summaries: plan.mode === 'continue'
      ? new Set(plan.alreadyDone.summaries)
      : new Set()
  };

  if (plan.mode !== 'continue') {
    // 新批次：先落盘，避免「数据写了但任务文件不存在」
    writeTask(dataDir, task);
  }

  let flushCounter = 0;
  const flush = () => {
    task.counts.activities.done = result.activities.succeeded + result.activities.skipped;
    task.counts.activities.failed = result.activities.failed;
    task.counts.summaries.done = result.summaries.succeeded + result.summaries.skipped;
    task.counts.summaries.failed = result.summaries.failed;
    task.counts.summaries.mdFailed = result.summaries.mdFailed;
    task.doneIdx.activities = Array.from(doneIdx.activities).sort((a, b) => a - b);
    task.doneIdx.summaries = Array.from(doneIdx.summaries).sort((a, b) => a - b);
    writeTask(dataDir, task);
    if (typeof ctx.onProgress === 'function') ctx.onProgress(result, task);
  };

  // --- 活动 ---
  for (let idx = 0; idx < list.length; idx += 1) {
    const rec = list[idx];

    if (doneIdx.activities.has(idx)) {
      // 续传：这条之前写过了，跳过。注意 skipped 与 succeeded 分开计数，
      // 用户看到的「导入 N 条」不该把上次的也算进来。
      result.activities.skipped += 1;
      continue;
    }

    if (!rec || !rec.timestamp || !rec.processName) {
      result.activities.failed += 1;
      // 缺字段不算「写过」，不加入 doneIdx：下次重试仍然会被跳过（因为源没变）
      continue;
    }

    if (typeof hooks.beforeWrite === 'function') hooks.beforeWrite(list, idx);

    let ok = false;
    try {
      // imp 是唯一附加字段，原记录其它字段原样写入，不裁剪不重排
      ok = storage.saveActivity({ ...rec, imp: { batch: plan.batch, idx } });
    } catch (_) {
      ok = false;
    }

    if (ok) {
      result.activities.succeeded += 1;
      doneIdx.activities.add(idx);
    } else {
      result.activities.failed += 1;
    }

    if (typeof hooks.afterWrite === 'function') hooks.afterWrite(list, idx, ok);

    flushCounter += 1;
    if (flushCounter % 50 === 0) flush();
  }

  // --- 摘要 ---
  for (let idx = 0; idx < summaries.length; idx += 1) {
    const sum = summaries[idx];

    if (doneIdx.summaries.has(idx)) {
      result.summaries.skipped += 1;
      continue;
    }

    if (!sum || !sum.timestamp || !sum.summary) {
      result.summaries.failed += 1;
      continue;
    }

    if (typeof hooks.beforeWrite === 'function') hooks.beforeWrite(summaries, idx);

    let r;
    try {
      if (typeof storage.saveSummaryDetailed === 'function') {
        r = storage.saveSummaryDetailed({ ...sum, imp: { batch: plan.batch, idx } });
      } else {
        const ok = storage.saveSummary({ ...sum, imp: { batch: plan.batch, idx } });
        r = { jsonOk: ok, mdOk: ok };
      }
    } catch (error) {
      r = { jsonOk: false, mdOk: false, error: error.message };
    }

    if (r.jsonOk) {
      // JSON 是事实来源：JSON 成功即算「已导入」，Markdown 失败只记 mdFailed
      result.summaries.succeeded += 1;
      doneIdx.summaries.add(idx);
      if (!r.mdOk) result.summaries.mdFailed += 1;
    } else {
      result.summaries.failed += 1;
    }

    if (typeof hooks.afterWrite === 'function') hooks.afterWrite(summaries, idx, r.jsonOk);

    flushCounter += 1;
    if (flushCounter % 50 === 0) flush();
  }

  flush();

  task.status = (result.activities.failed === 0 && result.summaries.failed === 0)
    ? 'completed'
    : 'in_progress';
  task.mdIncomplete = result.summaries.mdFailed > 0;
  writeTask(dataDir, task);

  result.taskStatus = task.status;
  result.mdIncomplete = task.mdIncomplete;
  return result;
}

/**
 * 补齐缺失的摘要 Markdown。不重写 JSON，因此不会产生重复记录。
 *
 * @param {object} ctx { dataDir, storage, sourceJson }
 * @returns {{ rebuilt: number, failed: number }}
 */
function rebuildMissingMarkdown(ctx) {
  const { dataDir, storage, sourceJson } = ctx;
  const mdDir = path.join(dataDir, 'summaries_md');
  const summaries = Array.isArray(sourceJson.summaries) ? sourceJson.summaries : [];

  let rebuilt = 0;
  let failed = 0;
  for (const sum of summaries) {
    if (!sum || !sum.timestamp) continue;
    const mdFilename = `summary_${new Date(sum.timestamp).toISOString().replace(/[:.]/g, '-')}.md`;
    if (fs.existsSync(path.join(mdDir, mdFilename))) continue;
    try {
      storage.rebuildSummaryMarkdown(sum);
      rebuilt += 1;
    } catch (_) {
      failed += 1;
    }
  }
  return { rebuilt, failed };
}

module.exports = {
  TASKS_DIR,
  planImport,
  executeImport,
  rebuildMissingMarkdown,
  collectDoneIdx,
  readTask,
  writeTask,
  taskPath
};
