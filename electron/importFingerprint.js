'use strict';

/**
 * importFingerprint.js — 导入来源指纹
 *
 * 用途只有一个：回答「这份文件是不是已经导入过」。
 *
 * 范围严格对齐「实际导入了什么」。导出的 JSON 里有 activities、summaries、
 * arhatSessions、arhatNotes、config 等字段，但 import-data 只处理前两个——
 * 把没被导入的内容算进指纹，会让「只改了 arhat 笔记」的文件被误判成新文件，
 * 于是重复导入一遍活动记录。
 *
 * 为什么不能靠内容去重替代指纹：同一个导出文件里可以合法地存在两条完全相同
 * 的记录（同一分钟在两个窗口各记了一条，字段一模一样）。内容去重会把它们
 * 合成一条，那是在删用户的数据。指纹只判断「整份文件」，不碰文件内部。
 */

const crypto = require('crypto');

/**
 * 指纹算法版本。改变参与计算的字段集或规范化规则时必须递增——
 * 老版本算出的指纹与新版本不可比，混用会得出错误结论。
 */
const FINGERPRINT_VERSION = 4;

/**
 * volatile 字段：由代码写入、但不代表用户内容的顶层字段。
 * 每条都必须写明来源，否则不能排除——「看着像临时字段」不是理由。
 */
const VOLATILE_BY_TYPE = {
  activity: new Set([
    // storageManager._fromSegment 读取时现算：`${t}#${index}`，从不落盘
    'id',
    // updateDisplayRecord 写入的操作时间戳，属于「何时改过」而非「改成了什么」
    'editedAt'
  ]),
  summary: new Set([
    // deleteSummary 用来匹配的标识，由调用方生成
    'id',
    // 若存在，为生成时间元数据
    'generatedAt'
  ])
};

/**
 * 规范化一个值。
 *
 * @param {*} value
 * @param {Set<string>} volatileKeys 仅作用于 depth 0 的顶层键
 * @param {number} depth
 *
 * 两条不能动的规则：
 *   1. 对象键排序 —— 否则同一内容因键序不同算出不同指纹
 *   2. 数组不排序、不去重 —— 顺序是内容，重复也是内容
 */
function canon(value, volatileKeys, depth) {
  if (value === null || value === undefined) return 'null';

  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    // 嵌套层不再过滤 volatile：嵌套里的 id 是数据内容
    return '[' + value.map(v => canon(v, null, depth + 1)).join(',') + ']';
  }

  if (type === 'object') {
    // 只在顶层应用 volatile；往下一律传 null
    const skip = depth === 0 ? volatileKeys : null;
    const keys = Object.keys(value)
      .filter(k => !skip || !skip.has(k))
      .sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(value[k], null, depth + 1)).join(',') + '}';
  }

  // function / symbol 不可能出现在 JSON 里，出现就当作空值
  return 'null';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 计算整份导入来源的指纹。
 *
 * @param {object} sourceJson 解析后的导出 JSON
 * @param {object} [options]
 * @param {number} [options.version] 覆盖版本号（测试用；生产不要传）
 * @returns {{ fingerprint: string, version: number, activityCount: number, summaryCount: number }}
 */
function computeFingerprint(sourceJson, options) {
  const opts = options || {};
  const version = typeof opts.version === 'number' ? opts.version : FINGERPRINT_VERSION;

  const activities = Array.isArray(sourceJson && sourceJson.activities) ? sourceJson.activities : [];
  const summaries = Array.isArray(sourceJson && sourceJson.summaries) ? sourceJson.summaries : [];

  const parts = [`v${version}`];
  for (const a of activities) parts.push('A:' + canon(a, VOLATILE_BY_TYPE.activity, 0));
  for (const s of summaries) parts.push('S:' + canon(s, VOLATILE_BY_TYPE.summary, 0));
  // arhatSessions / arhatNotes / config / summariesMd 一律不参与：
  // 前三个不被 import-data 导入，第四个在本项目的导出结构里根本不存在。

  return {
    fingerprint: sha256(parts.join('\n')),
    version,
    activityCount: activities.length,
    summaryCount: summaries.length
  };
}

/** 指纹前 16 位，用作导入任务文件名与批次号前缀。 */
function fingerprintId(fingerprint) {
  return String(fingerprint || '').slice(0, 16);
}

/**
 * 判断一份历史记录能否用来判定「已导入」。
 *
 * 版本不匹配时**不**判定为已导入，而是返回无法确认——
 * 宁可让用户多导一次（有快照与续传兜底），也不能错误拒绝导致数据漏导。
 */
function isComparable(record, expectedVersion) {
  if (!record || typeof record !== 'object') return false;
  const want = typeof expectedVersion === 'number' ? expectedVersion : FINGERPRINT_VERSION;
  return record.fingerprintVersion === want;
}

module.exports = {
  FINGERPRINT_VERSION,
  VOLATILE_BY_TYPE,
  computeFingerprint,
  fingerprintId,
  isComparable,
  canon,
  sha256
};
