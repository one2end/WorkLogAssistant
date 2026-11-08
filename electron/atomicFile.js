const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 原子写文件。
 *
 * 先写临时文件再 rename，保证不会写出半截内容。
 * 但数据目录可能放在 iCloud / OneDrive 这类同步盘里：同步进程会短暂锁住
 * 目标文件，此时 rename 会抛 EPERM/EBUSY。
 * 所以这里做两件事：
 *   1. rename 失败时重试几次（同步锁通常是瞬时的）
 *   2. 仍然失败就退回「直接覆盖写」——虽然不是原子的，
 *      但比起整个操作失败，用户宁可要一个可用结果。
 */
function writeFileAtomic(file, content) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(temp, content, 'utf8');
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { /* 写入失败时可能没生成 */ }
    throw error;
  }

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      lastError = error;
      // EPERM/EBUSY/EMFILE 都是「稍后重试可能成功」的类型
      const retryable = ['EPERM', 'EBUSY', 'EMFILE', 'ENFILE'].includes(error.code);
      if (!retryable) break;
      sleepSync(60 * (attempt + 1));
    }
  }

  // 退路：直接覆盖写。同步盘锁定时也能把数据落下去。
  try {
    fs.writeFileSync(file, content, 'utf8');
    try { fs.unlinkSync(temp); } catch (_) { /* 临时文件残留无害 */ }
    return;
  } catch (directError) {
    try { fs.unlinkSync(temp); } catch (_) { /* ignore */ }
    // 直接写也失败时，抛出原始错误（更接近真实原因）
    throw lastError || directError;
  }
}

/** 同步等待（不占事件循环） */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

module.exports = { writeFileAtomic };
