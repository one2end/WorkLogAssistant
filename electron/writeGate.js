'use strict';

/**
 * writeGate.js — 统一写入闸门
 *
 * 迁移期间，任何写 activities/ 与 summaries/ 的路径都必须被拦住，
 * 否则迁移算出来的 expectedSha256 会在落盘瞬间失效。
 *
 * 为什么建在这一层而不是 IPC 层：
 *   activityRecorder 每 15 秒由定时器 flush 一次，完全不经过 IPC。
 *   把锁挂在 IPC 上，flush 就会绕过它，等于没锁。
 *
 * 为什么用同步语义：
 *   StorageManager 的写方法全是同步的（readFileSync / writeFileSync）。
 *   引入 Promise 队列会改变调用方的行为（IPC handler 大多不 await），
 *   还会带来「排队写入在迁移结束后才落地」的新竞态。这里只做「准 / 不准」，
 *   不做排队——调用方需要自己决定被拒后怎么办（录制器会把片段放回缓冲）。
 *
 * 能力边界（必须明确）：
 *   应用内写锁防的是本进程的并发写入，**防不住** iCloud / OneDrive / 杀毒软件
 *   或手工编辑器。外部修改只能靠 SHA256 检测，不能靠锁。
 */

const ERR = 'MIGRATION_IN_PROGRESS';

class WriteBlockedError extends Error {
  constructor(message, detail) {
    super(message);
    this.code = ERR;
    this.name = 'WriteBlockedError';
    if (detail) Object.assign(this, detail);
  }
}

let holder = null;          // { owner, reason, since }
let migrationDepth = 0;     // > 0 表示在迁移特权上下文内
const waiters = new Set();  // 迁移结束时通知的对象（录制器用它主动补 flush）

/** 尝试拿锁。已被占用时返回 false，不抛错——是否抛由调用方决定。 */
function tryAcquire(owner, reason) {
  if (holder) return false;
  holder = { owner, reason: reason || null, since: Date.now() };
  return true;
}

/** 释放锁。只有持有者能释放，避免误释放别人的锁。 */
function release(owner) {
  if (!holder || holder.owner !== owner) return false;
  holder = null;
  // 迁移结束：通知等待者（录制器借此把缓冲落盘）
  const pending = Array.from(waiters);
  waiters.clear();
  for (const fn of pending) {
    try { fn(); } catch (_) { /* 通知失败不影响释放 */ }
  }
  return true;
}

/** 强制释放（测试与异常兜底用）。正常流程不该调用。 */
function forceRelease() {
  if (!holder) return false;
  return release(holder.owner);
}

/**
 * 迁移自己的写入走特权上下文，避免自我死锁。
 * migrationDepth 用计数器而非布尔值，支持嵌套（快照里再调工具函数）。
 */
function withMigrationContext(fn) {
  migrationDepth += 1;
  try {
    return fn();
  } finally {
    migrationDepth -= 1;
  }
}

/**
 * 所有写方法入口调用。
 * 在特权上下文中直接放行；否则持有锁就抛 WriteBlockedError。
 */
function assertWritable(operation) {
  if (migrationDepth > 0) return;
  if (holder) {
    throw new WriteBlockedError(
      `数据迁移进行中，暂不能${operation || '写入数据'}。请等待迁移完成后重试。`,
      { operation: operation || null, holder: { ...holder } }
    );
  }
}

/** 读路径也可以用：锁在时返回 true，调用方可据此给出更友好的提示。 */
function isLocked() {
  return !!holder;
}

function getHolder() {
  return holder ? { ...holder } : null;
}

/** 是否处于迁移特权上下文（迁移内部写调用的判据）。 */
function inMigrationContext() {
  return migrationDepth > 0;
}

/**
 * 注册「迁移结束」回调。录制器用它主动补一次 flush。
 * 返回取消函数，调用方应在销毁时取消，避免悬挂引用。
 */
function onReleased(fn) {
  if (typeof fn !== 'function') return () => {};
  waiters.add(fn);
  return () => waiters.delete(fn);
}

/** 仅测试用：把模块状态清干净，避免用例之间互相污染。 */
function _resetForTests() {
  holder = null;
  migrationDepth = 0;
  waiters.clear();
}

module.exports = {
  tryAcquire,
  release,
  forceRelease,
  withMigrationContext,
  assertWritable,
  isLocked,
  getHolder,
  inMigrationContext,
  onReleased,
  WriteBlockedError,
  _resetForTests,
  ERR
};
