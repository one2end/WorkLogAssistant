'use strict';

// 日报告按起始日期读取 JSONL，跨午夜的事实必须在午夜拆成两条。
function splitRecordAtMidnight(record) {
  const start = new Date(record.t);
  const midnight = new Date(start);
  midnight.setHours(24, 0, 0, 0);
  const end = start.getTime() + record.dur;
  if (end <= midnight.getTime()) return [record];
  return [
    { ...record, dur: midnight.getTime() - start.getTime() },
    { ...record, t: midnight.toISOString(), dur: end - midnight.getTime() }
  ];
}

module.exports = { splitRecordAtMidnight };
