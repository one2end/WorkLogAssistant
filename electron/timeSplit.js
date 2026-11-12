'use strict';

const crypto = require('crypto');

// 日报告按起始日期读取 JSONL，跨午夜的事实必须在午夜拆成两条。
function splitRecordAtMidnight(record) {
  const start = new Date(record.t);
  const midnight = new Date(start);
  midnight.setHours(24, 0, 0, 0);
  const end = start.getTime() + record.dur;
  if (end <= midnight.getTime()) return [record];

  // 拆成两段后它们是两条独立记录，必须各自有自己的 rid。
  // 若两段共用一个 rid，冲突副本去重会把其中一段当成重复删掉——
  // 用户看到的是「23:50 开始的那一小时，后半截不见了」。
  // 前半段沿用原 rid（它就是这条记录的延续），后半段重新生成。
  const second = { ...record, t: midnight.toISOString(), dur: end - midnight.getTime() };
  if (record.rid) second.rid = crypto.randomUUID();

  return [
    { ...record, dur: midnight.getTime() - start.getTime() },
    second
  ];
}

module.exports = { splitRecordAtMidnight };
