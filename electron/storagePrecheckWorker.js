'use strict';

/**
 * storagePrecheckWorker.js — 目录预检的实际执行体
 *
 * 单独成文件是因为它必须跑在子进程里：预检要真的读一次文件，
 * 而「读云端占位文件」可能长时间阻塞。放在主进程会连累界面，
 * 放在子进程里，父进程到点就能 kill 掉。
 *
 * 这里只读不写数据文件，唯一的写操作是父进程要求之外的临时探针
 * （由 storagePrecheck.checkStorageDir 自己完成，不在本文件里）。
 */

const { checkStorageDir } = require('./storagePrecheck');

process.on('message', msg => {
  const { dir, options } = msg || {};
  let result;
  try {
    result = checkStorageDir(dir, options || {});
  } catch (error) {
    result = {
      ok: false,
      reason: 'precheck-exception',
      message: `目录检查出错：${error.message}`
    };
  }
  if (process.send) process.send(result);
  // 主动退出，避免父进程忘记 kill 时留下孤儿进程
  process.exit(0);
});

// 父进程消失时跟着退出
process.on('disconnect', () => process.exit(0));
