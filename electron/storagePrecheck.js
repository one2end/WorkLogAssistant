'use strict';

/**
 * storagePrecheck.js — 切换数据目录前的可用性预检
 *
 * 要防的是什么：
 *   把数据目录指到 iCloud / OneDrive 的「仅在线」文件上时，文件本体不在本地，
 *   读取会触发同步进程去云端拉取。网络差的时候这个读操作会阻塞很久，
 *   而数据读取在主进程里同步进行——读一个文件就能让整个界面卡住，
 *   用户看到的是「软件无响应」。
 *
 *   更糟的是这种目录看起来完全正常：目录存在、文件列得出来、大小也对，
 *   只有在真正读内容时才会卡住。所以预检必须真的去读一次。
 *
 * 两个检查：
 *   1. 目录可写（真的建一个文件再删掉，不只看权限位）
 *   2. 抽样读：挑几个真实数据文件读一遍并计时
 *
 * 关于 Windows 的 0x400000（FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS）属性：
 *   Node 的 fs.stat 拿不到 Windows 文件属性位，要拿就得引入 native 模块。
 *   与其写一个永远返回 false 的 isCloudOnly() 让人误以为检查过了，
 *   不如用「实际读一次并计时」来判断——它测的正是真正会让界面卡住的那个操作，
 *   而且跨平台都成立。慢就是慢，与文件是云占位还是机械硬盘无关。
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * 在给定毫秒内同步读一个文件。
 *
 * 为什么是同步：Electron 主进程里真正的阻塞发生在同步 fs 调用上。
 * 若这里改成异步，就测不出「实际会让主线程卡住的那个操作」。
 * 但同步读没有超时能力——所以放在子进程里跑（见 withTimeout）。
 */
function readWithin(filePath) {
  const started = Date.now();
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, bytes: buf.length, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code, elapsedMs: Date.now() - started };
  }
}

/**
 * 列出候选抽样文件：数据目录下的 .json / .jsonl，按修改时间取最近的几个。
 * 取最近的，因为用户最可能马上打开最近有数据的那天。
 */
function pickSamples(dir, count) {
  const out = [];
  const collect = (sub) => {
    const d = sub ? path.join(dir, sub) : dir;
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const name of names) {
      if (!/\.(json|jsonl)$/.test(name)) continue;
      const p = path.join(d, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0) continue;
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch (_) { /* 读不到就跳过，不影响其它候选 */ }
    }
  };
  collect('activities');
  collect('summaries');
  collect('');

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, count);
}

/**
 * 检查目录能否当数据目录用。
 *
 * @param {string} dir 候选目录
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 单个文件读取超时
 * @param {number} [options.sampleCount] 抽样文件数
 * @returns {{ ok: boolean, reason?: string, message?: string, detail?: object }}
 */
function checkStorageDir(dir, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const sampleCount = opts.sampleCount || DEFAULT_SAMPLE_COUNT;

  if (!dir || typeof dir !== 'string') {
    return { ok: false, reason: 'invalid-path', message: '数据目录路径无效' };
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 目录不存在不算错——切换时可以由应用创建
      return { ok: true, created: true, message: '目录尚不存在，将在切换时创建' };
    }
    return { ok: false, reason: 'unreadable', message: `无法访问该目录：${error.message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not-a-directory', message: '所选路径不是文件夹' };
  }

  // 1. 可写性：建一个临时文件再删掉。
  //    只检查 access(W_OK) 不够——同步盘、只读挂载、权限继承异常的目录
  //    常常通过权限检查但写不进去。
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'probe', 'utf8');
    fs.unlinkSync(probe);
  } catch (error) {
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch (_) { /* 清理失败不改变结论 */ }
    return {
      ok: false,
      reason: 'not-writable',
      message: `该目录不可写（${error.code || error.message}），无法作为数据目录`
    };
  }

  // 2. 抽样读：真的读一次内容。
  //    这是唯一能发现「仅在线文件」的办法——属性位拿不到，但读会卡住。
  const samples = pickSamples(dir, sampleCount);
  const slow = [];
  const failed = [];
  for (const s of samples) {
    const r = readWithin(s.path);
    if (!r.ok) {
      failed.push({ file: path.basename(s.path), error: r.error, code: r.code });
      continue;
    }
    if (r.elapsedMs > timeoutMs) {
      slow.push({ file: path.basename(s.path), elapsedMs: r.elapsedMs, size: s.size });
    }
  }

  if (failed.length) {
    // 读失败但能列出文件名，最常见的原因就是「仅在线」且当前离线
    return {
      ok: false,
      reason: 'sample-read-failed',
      message: `目录里有 ${failed.length} 个文件读不出来。` +
        '如果该目录在 iCloud / OneDrive 里，请先在文件管理器里把它设为「始终保留在此设备上」。',
      detail: { failures: failed, sampleCount: samples.length }
    };
  }

  if (slow.length) {
    return {
      ok: false,
      reason: 'sample-read-slow',
      message: `读取测试文件耗时过长（${slow.map(x => `${x.file} ${x.elapsedMs}ms`).join('，')}）。` +
        '这类目录通常是云端占位文件，会让界面卡住。请先下载到本地再切换。',
      detail: { slow, sampleCount: samples.length }
    };
  }

  return {
    ok: true,
    sampleCount: samples.length,
    detail: { samples: samples.map(s => path.basename(s.path)) }
  };
}

/**
 * 在子进程里跑预检，超时就杀掉。
 *
 * 为什么必须开子进程：预检的核心是「真的读一次文件」。如果这个读会卡住
 * （云端占位文件），在主进程里同步做就等于把主进程也卡住——那正是我们要防的事。
 * 同步 fs 调用没有超时能力，唯一能中断它的办法是把它放到另一个进程里，
 * 时间到了直接 kill。
 *
 * 子进程只做只读检查，不写任何数据文件。
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 整体超时（默认取单个文件超时的 3 倍 + 1s 余量）
 * @returns {Promise<object>} 与 checkStorageDir 相同的结构，超时时多一个 timedOut 标记
 */
function checkStorageDirAsync(dir, options) {
  const opts = options || {};
  const perFile = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const overall = opts.overallTimeoutMs || perFile * 3 + 1000;

  return new Promise((resolve) => {
    let child;
    try {
      // 运行时取 fork（而不是顶层解构），便于测试替换并观察异常分支
      child = childProcess.fork(path.join(__dirname, 'storagePrecheckWorker.js'), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // 不继承环境中的敏感变量；预检只需要文件系统
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    } catch (error) {
      // 起不了子进程（极少数受限环境）：退回同步检查，至少给出结论
      resolve({ ...checkStorageDir(dir, opts), degraded: true, reason_detail: error.message });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* 已经退出 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        reason: 'precheck-timeout',
        message: `检查该目录超过 ${overall}ms 没有返回，可能有文件需要从云端下载。` +
          '请先把目录设为「始终保留在此设备上」再切换。'
      });
    }, overall);

    child.on('message', msg => finish(msg));
    child.on('error', error => finish({
      ok: false,
      reason: 'precheck-failed',
      message: `目录检查失败：${error.message}`
    }));
    child.on('exit', code => {
      // 子进程没发结果就退出：不当作通过
      finish({
        ok: false,
        reason: 'precheck-crashed',
        message: `目录检查进程异常退出（code ${code}）`
      });
    });

    child.send({ dir, options: opts });
  });
}

module.exports = {
  checkStorageDir,
  checkStorageDirAsync,
  pickSamples,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SAMPLE_COUNT
};
