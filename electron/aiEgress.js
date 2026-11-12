'use strict';

/**
 * AI 数据出口 —— 发送前再过一遍隐私规则。
 *
 * 为什么录制侧过滤过了还要再过一遍：
 *   1. 录制时用户还没设置某条排除规则。规则是后来加的，
 *      但历史数据早就躺在磁盘上了。
 *   2. 配置在「读取」和「发送」之间可能被改（用户恰好在这时改了排除项）。
 *   3. 导入的数据没有经过录制侧的过滤——它是别人的文件。
 *
 *   录制侧过滤管的是「什么被记下来」，这里管的是「什么被发出去」。
 *   这是两个不同的问题，不能因为前者做了就假设后者不需要。
 *
 * 三个开关：
 *   enabled          总开关。默认 false，本版本不改这个默认值。
 *   sendAppName      是否发送应用名。默认 true（AI 开启后才生效）。
 *   sendWindowTitle  是否发送窗口标题。默认 **false**。
 *
 * 关于 sendWindowTitle 默认 false：窗口标题几乎总是包含具体内容
 * （文件名、邮件主题、网页标题、聊天对象），它是隐私暴露的主要来源。
 * 而它又是摘要质量的主要来源——所以这是一个明确的取舍，
 * 由用户在知情的前提下选择，而不是由默认值替他决定。
 */

/**
 * 按规则过滤一组活动记录。
 *
 * @param {Array} records 待发送的记录
 * @param {object} monitoring 用户配置的排除规则
 * @param {Function} isExcluded 判定函数（默认 privacyRules.isExcludedSample）
 * @returns {{ kept: Array, dropped: number }}
 */
function filterForEgress(records, monitoring, isExcluded) {
  const check = typeof isExcluded === 'function'
    ? isExcluded
    : require('./privacyRules').isExcludedSample;

  const list = Array.isArray(records) ? records : [];
  const kept = [];
  let dropped = 0;

  for (const record of list) {
    if (!record) { dropped += 1; continue; }
    if (check(record, monitoring || {})) { dropped += 1; continue; }
    kept.push(record);
  }

  return { kept, dropped };
}

/**
 * 把一条记录变成可以安全外发的形状。
 *
 * 关闭某项时**根本不出现该字段**，而不是置空字符串。
 * 空串仍然占一个位置，模型仍然知道「这里原本有个标题」，
 * 而测试也更难断言「确定没发」。
 *
 * @param {object} record
 * @param {object} options { sendAppName, sendWindowTitle }
 */
function projectForEgress(record, options) {
  const opts = options || {};
  const out = {
    timestamp: record.timestamp,
    durationMs: record.durationMs
  };

  if (record.category) out.category = record.category;

  if (opts.sendAppName !== false && typeof record.processName === 'string') {
    out.processName = record.processName;
  }
  // 只在真的有值时才放进去：`{ windowTitle: undefined }` 序列化后会变成
  // 一个不存在的键，但对象上确实挂着这个属性，断言时容易看走眼。
  if (opts.sendWindowTitle === true && typeof record.windowTitle === 'string') {
    out.windowTitle = record.windowTitle;
  }

  return out;
}

/**
 * 生成一份「这次会发出去什么」的说明，供设置页展示。
 *
 * 这里刻意不用百分比或模糊措辞：用户要能数出来。
 */
function describeEgress(payload) {
  const records = Array.isArray(payload) ? payload : [];
  const fields = new Set();
  for (const r of records) {
    for (const k of Object.keys(r)) fields.add(k);
  }

  return {
    recordCount: records.length,
    fields: [...fields].sort(),
    includesAppName: fields.has('processName'),
    includesWindowTitle: fields.has('windowTitle')
  };
}

module.exports = {
  filterForEgress,
  projectForEgress,
  describeEgress
};
