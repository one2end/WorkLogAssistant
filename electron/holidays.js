'use strict';

/**
 * 中国法定节假日与调休上班日。
 *
 * 数据来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04）。
 * 每年新安排公布后在这里追加即可；没覆盖到的年份按自然周末兜底，
 * 不会因为缺数据把工作日误判成休息日。
 */

const HOLIDAYS = {
  // 元旦
  '2026-01-01': '元旦',
  '2026-01-02': '元旦',
  '2026-01-03': '元旦',
  // 春节
  '2026-02-15': '春节',
  '2026-02-16': '春节',
  '2026-02-17': '春节',
  '2026-02-18': '春节',
  '2026-02-19': '春节',
  '2026-02-20': '春节',
  '2026-02-21': '春节',
  '2026-02-22': '春节',
  '2026-02-23': '春节',
  // 清明
  '2026-04-04': '清明',
  '2026-04-05': '清明',
  '2026-04-06': '清明',
  // 劳动节
  '2026-05-01': '劳动节',
  '2026-05-02': '劳动节',
  '2026-05-03': '劳动节',
  '2026-05-04': '劳动节',
  '2026-05-05': '劳动节',
  // 端午
  '2026-06-19': '端午',
  '2026-06-20': '端午',
  '2026-06-21': '端午',
  // 中秋
  '2026-09-25': '中秋',
  '2026-09-26': '中秋',
  '2026-09-27': '中秋',
  // 国庆
  '2026-10-01': '国庆',
  '2026-10-02': '国庆',
  '2026-10-03': '国庆',
  '2026-10-04': '国庆',
  '2026-10-05': '国庆',
  '2026-10-06': '国庆',
  '2026-10-07': '国庆'
};

// 调休上班日：这些日子是周末但要上班
const MAKEUP_WORKDAYS = {
  '2026-01-04': '元旦调休',
  '2026-02-14': '春节调休',
  '2026-02-28': '春节调休',
  '2026-05-09': '劳动节调休',
  '2026-09-20': '国庆调休',
  '2026-10-10': '国庆调休'
};

const REPEATS = ['none', 'daily', 'workday', 'holiday', 'weekend'];

function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? -1 : d.getDay();
}

function isWeekend(dateStr) {
  const w = weekdayOf(dateStr);
  return w === 0 || w === 6;
}

function isLegalHoliday(dateStr) {
  return Object.prototype.hasOwnProperty.call(HOLIDAYS, dateStr);
}

function isMakeupWorkday(dateStr) {
  return Object.prototype.hasOwnProperty.call(MAKEUP_WORKDAYS, dateStr);
}

/** 工作日：调休上班日优先，其次排除法定假日，最后看是否周末 */
function isWorkday(dateStr) {
  if (isMakeupWorkday(dateStr)) return true;
  if (isLegalHoliday(dateStr)) return false;
  return !isWeekend(dateStr);
}

/** 休息日：周末 + 法定假日 - 调休上班日 */
function isRestDay(dateStr) {
  return !isWorkday(dateStr);
}

function matchesRepeat(repeat, dateStr) {
  switch (repeat) {
    case 'daily': return true;
    case 'workday': return isWorkday(dateStr);
    case 'holiday': return isRestDay(dateStr);
    case 'weekend': return isWeekend(dateStr);
    default: return false;
  }
}

module.exports = {
  HOLIDAYS,
  MAKEUP_WORKDAYS,
  REPEATS,
  isWeekend,
  isLegalHoliday,
  isMakeupWorkday,
  isWorkday,
  isRestDay,
  matchesRepeat
};
