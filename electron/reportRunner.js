'use strict';

/**
 * reportRunner.js — 把报表计算放到 worker 线程，带超时终止
 *
 * 审计要求「数据读取迁 worker_threads，超时 terminate()」。
 * 这里只做调度，不含任何业务逻辑；计算仍在 analytics 里。
 *
 * 一条重要约束：**失败必须回退到同步计算，而不是返回空报告**。
 * 一个空报告会让界面显示「今天没有记录」，而实际情况是「算失败了」——
 * 用户会以为数据丢了。宁可慢一点、在主进程里算出来，也不能给出错误的空结果。
 */

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 在 worker 中执行一个只读作业。
 *
 * @param {'dayReport'|'rangeReport'|'listApps'} job
 * @param {object} payload
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ ok: boolean, result?: any, error?: string, timedOut?: boolean }>}
 */
function runInWorker(job, payload, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'reportWorker.js'), {
        workerData: { job, payload }
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动计算线程：${error.message}`, code: 'worker-start-failed' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        code: 'worker-timeout',
        error: `计算超过 ${timeoutMs}ms 未完成，已中止`
      });
    }, timeoutMs);

    worker.on('message', msg => finish(msg));
    worker.on('error', error => finish({
      ok: false,
      code: 'worker-error',
      error: error.message
    }));
    worker.on('exit', code => {
      // 没发结果就退出：不能当成空结果
      finish({
        ok: false,
        code: 'worker-exited',
        error: `计算线程意外退出（code ${code}）`
      });
    });
  });
}

/**
 * 执行日报计算：优先 worker，失败/超时则回退同步计算。
 *
 * 回退的理由见文件头：空报告是最坏的失败形态。
 * 回退时同样可能慢，但至少结果是正确的——而且这种情况本身会写日志，
 * 便于判断是不是该目录一直有问题。
 *
 * @param {string} dataDir
 * @param {string} dateStr
 * @param {object} options
 * @param {object} [runOptions]
 * @returns {Promise<{ report: any, degraded: boolean, reason?: string }>}
 */
async function buildDayReportSafe(dataDir, dateStr, options, runOptions) {
  const ro = runOptions || {};
  const analytics = require('./analytics');
  // 允许注入 runner：测试要单独验证「worker 起不来」时的降级路径，
  // 而 runInWorker 是在本模块内直接调用的，从外部替换导出属性不会生效。
  const runner = typeof ro.runner === 'function' ? ro.runner : runInWorker;

  const r = await runner('dayReport', { dataDir, dateStr, options }, ro);
  if (r.ok) return { report: r.result, degraded: false };

  if (typeof ro.onLog === 'function') {
    ro.onLog(
      `报表计算未能在线程中完成（${r.error}），已回退主进程计算。` +
      (r.timedOut ? '如果该目录在云端，请先设为「始终保留在此设备上」。' : ''),
      r.timedOut ? 'error' : 'info'
    );
  }

  // 同步回退：结果正确，只是可能慢
  return {
    report: analytics.buildDayReport(dataDir, dateStr, options),
    degraded: true,
    reason: r.code || r.error
  };
}

/**
 * 项目统计。失败或超时回退到主进程同步计算——与报表同一套理由：
 * 慢一点但数字对，好过快一点但返回空结果。
 */
async function buildProjectReportSafe(dataDir, from, to, options, runOptions) {
  const ro = runOptions || {};
  const analytics = require('./analytics');
  const runner = typeof ro.runner === 'function' ? ro.runner : runInWorker;

  const r = await runner('projectReport', { dataDir, from, to, options }, ro);
  if (r && r.ok) return { report: r.result, degraded: false };

  if (typeof ro.onLog === 'function') {
    ro.onLog(`项目统计在后台线程失败（${r && r.error}），已改为本地计算`, 'error');
  }
  return {
    report: analytics.buildProjectReport(dataDir, from, to, options),
    degraded: true,
    reason: r && r.code ? r.code : 'worker-failed'
  };
}

/** 历史检索。同样的降级策略。 */
async function searchSafe(dataDir, keyword, from, to, options, runOptions) {
  const ro = runOptions || {};
  const analytics = require('./analytics');
  const runner = typeof ro.runner === 'function' ? ro.runner : runInWorker;

  const r = await runner('search', { dataDir, keyword, from, to, options }, ro);
  if (r && r.ok) return { result: r.result, degraded: false };

  if (typeof ro.onLog === 'function') {
    ro.onLog(`检索在后台线程失败（${r && r.error}），已改为本地计算`, 'error');
  }
  return {
    result: analytics.searchActivities(dataDir, keyword, from, to, options),
    degraded: true,
    reason: r && r.code ? r.code : 'worker-failed'
  };
}

module.exports = {
  runInWorker,
  buildDayReportSafe,
  buildProjectReportSafe,
  searchSafe,
  DEFAULT_TIMEOUT_MS
};
