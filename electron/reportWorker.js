'use strict';

/**
 * reportWorker.js — 在 worker_threads 里跑报表计算
 *
 * 为什么需要：
 *   报表读取要遍历 activities/ 与 summaries/ 下的全部文件。数据目录放在
 *   iCloud / OneDrive 时，任何一个「仅在线」文件都会让读取触发云端召回，
 *   而这段读取一直在主进程里同步进行——结果是算一份早报就把整个界面冻住，
 *   用户看到的是「软件无响应」，等几十秒才恢复，或者永远不恢复。
 *
 *   计算本身是纯的：输入 dataDir + dateStr + options，输出一个可 JSON 序列化的
 *   报告对象。这种形状最适合搬到 worker——不需要共享状态，不需要回调。
 *
 * 超时后调用方会 terminate()，所以这里不需要自己处理中断。
 */

const { parentPort, workerData } = require('worker_threads');

/**
 * 支持的作业类型。刻意只开放「读 + 算」两类，
 * 任何会写字或者改状态的操作都不允许进 worker——
 * 那会让写锁与迁移的时序变得无法推理。
 */
const JOBS = {
  dayReport: (analytics, payload) =>
    analytics.buildDayReport(payload.dataDir, payload.dateStr, payload.options),
  rangeReport: (analytics, payload) =>
    analytics.buildRangeReport(payload.dataDir, payload.from, payload.to, payload.options),
  listApps: (analytics, payload) =>
    analytics.listRecordedApps ? analytics.listRecordedApps(payload.dataDir, payload.options) : [],
  // V0.11.0：项目统计与跨日期检索。
  // 月度项目统计在 28800 条记录上约 200ms，检索同量级——
  // 放在主进程里做，切到项目页的那一下会有可感知的停顿。
  projectReport: (analytics, payload) =>
    analytics.buildProjectReport(payload.dataDir, payload.from, payload.to, payload.options),
  search: (analytics, payload) =>
    analytics.searchActivities(payload.dataDir, payload.keyword, payload.from, payload.to, payload.options)
};

function run() {
  const { job, payload } = workerData || {};
  const handler = JOBS[job];
  if (!handler) {
    parentPort.postMessage({ ok: false, error: `未知作业类型: ${job}` });
    return;
  }

  try {
    // analytics 在 worker 里单独加载：它只依赖 fs/path，不依赖 electron
    const analytics = require('./analytics');
    const result = handler(analytics, payload || {});
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error.message,
      code: error.code || null,
      stack: error.stack
    });
  }
}

run();
