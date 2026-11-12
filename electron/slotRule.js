'use strict';

/**
 * slotRule.js — 15 分钟时间格的唯一规则来源
 *
 * 为什么需要这个文件：
 *   同一个「15 分钟一格」的规矩，散落在至少六处各自实现：人工补记、覆盖标注、
 *   计划、专注聚合、渲染层预览、时间轴拖拽。它们对同一个输入给出不同答案——
 *   起点有的向下取整、有的就近，时长统一被 `Math.max(15, round())` 二次取整。
 *   用户填「09:07 起 95 分钟」，界面上看到的与存下来的不是一回事。
 *
 * 这个模块只做一件事：把「一格是 15 分钟」这条规矩写一次。所有调用方都调它，
 * 任何分歧都变成编译期可见的（同一个函数，同一个结果）。
 *
 * 设计约束（任务书 P1）：
 *   · 纯函数：不 require electron / vue / fs，不读写全局状态，无副作用
 *   · 不改动传入的记录对象
 *   · 时间边界与跨午夜处理只有一套规则
 *
 * 核心不变量：**时长由两端相减得到，绝不对时长单独取整。**
 * 见 snapRange() 里的说明——这是「两端分别吸附」与旧算法最本质的区别。
 */

// 一格 = 15 分钟。整个项目只有这一个数字。
const STEP = 15;

// 一天 1440 分钟。终点允许等于它（表示次日 00:00），起点不允许。
const DAY = 1440;

/**
 * 就近吸附到 15 分钟刻度。
 *
 * 取舍规则（必须确定且可重复）：恰好落在两个刻度正中间时取**较大**的那个（向后）。
 *
 * 为什么不用 Math.round(minutes / STEP) * STEP：
 *   浮点除法在边界上会漂。实测 `22.5 / 15 === 1.4999999999999998`，
 *   Math.round 得到 1，于是 22.5 被吸附到 15 而不是 30——与「中间取大」的
 *   约定相反，而且只在特定数值上出错，极难发现。
 *   这里改成整数运算：先乘 2 再整除，把 .5 的情况显式判出来。
 *
 * @param {number} minutes 原始分钟数（0..2880）
 * @returns {number} 吸附后的分钟数
 */
function snapToStep(minutes) {
  // 用 (2x + STEP) / (2*STEP) 的整数形式等价于 floor(x/STEP + 0.5)，
  // 但全程不经过浮点除法，边界上不会漂。
  const doubled = minutes * 2;
  return Math.floor((doubled + STEP) / (2 * STEP)) * STEP;
}

/**
 * 吸附起点。
 *
 * 起点吸附到次日（>= 1440）是会改变记录日期的事，不能悄悄发生——
 * 见 snapRange() 的 rejected: 'start-crosses-day'。
 *
 * @param {string} dateStr   YYYY-MM-DD（保留参数以对齐方案接口；起点吸附本身与日期无关）
 * @param {string} startHHMM "HH:mm"
 * @returns {{ startMin: number, crossDay: boolean }}
 */
function snapStart(dateStr, startHHMM) {
  const parsed = parseHHMM(startHHMM);
  if (parsed === null) {
    return { startMin: null, crossDay: false, invalid: true, reason: 'bad-start-format' };
  }
  const startMin = snapToStep(parsed);
  return { startMin, crossDay: startMin >= DAY };
}

/**
 * 由原始起点 + 原始时长推导原始终点。
 *
 * 这里只做加法，不吸附——吸附在 snapEnd 里单独做。
 * 分开的理由：跨午夜的判据是「原始终点 >= 1440」，必须用未吸附的值判断，
 * 否则 `23:52 + 15min` 吸附后终点是 1440，会被误判成跨日。
 *
 * @param {number} startRaw     原始起点（0..1439）
 * @param {number} durationMin  原始时长
 * @returns {{ endRaw: number, crossMidnight: boolean }}
 */
function deriveEnd(startRaw, durationMin) {
  const endRaw = startRaw + durationMin;
  return { endRaw, crossMidnight: endRaw >= DAY };
}

/**
 * 吸附终点。支持 1440 表示次日 00:00。
 *
 * 跨午夜时保留日外偏移再吸附：`23:50 + 30min` 的终点是 1470，
 * 按 `1440 + round(30/15)*15 = 1470` 得次日 00:30；
 * 若直接对 1470 吸附会得到 1470（恰好也是 15 的倍数），但
 * `23:53 + 22min = 1455` 就会露馅——必须减去 1440 再吸附，否则偏移会漂。
 *
 * @param {number} endRaw 原始终点（0..2880）
 * @returns {{ endMin: number }}
 */
function snapEnd(endRaw) {
  if (endRaw < DAY) return { endMin: snapToStep(endRaw) };
  return { endMin: DAY + snapToStep(endRaw - DAY) };
}

/** "HH:mm" → 分钟数；非法返回 null */
function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → "HH:mm"，允许 >= 1440（按次日显示，如 1470 → "00:30"） */
function formatHHMM(minutes) {
  const wrapped = ((minutes % DAY) + DAY) % DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 一次算完：起点吸附 + 终点吸附 + 时长。
 *
 * **时长 = snapEnd - snapStart，是相减得到的，绝不再单独取整。**
 * 这一点是旧算法与现规则的真正分界：
 *   旧：duration = Math.max(15, round(rawDuration/15)*15)   ← 二次取整
 *   新：duration = snapEnd(rawStart+rawDuration) - snapStart(rawStart)
 * 旧算法里，`09:07 + 95min` 起点被拉到 09:00，时长仍是 90，终点根本不参与吸附，
 * 结果是 09:00—10:30；新算法两端都吸，得到 09:00—10:45（105 分），
 * 与方案验收表一致。
 *
 * 拒绝规则（方案 §1.6 / §1.8）：
 *   · 原始时长 < 15      → rejected: 'too-short'
 *   · 原始时长非 1..1440 → rejected: 'duration-out-of-range'
 *   · 起点吸附到次日     → rejected: 'start-crosses-day'
 *   · 起点格式非法       → rejected: 'bad-start-format'
 *
 * 拒绝必须发生在写盘之前，不能留下任何部分写入——这是「宁可要求用户重输，
 * 也不能把 3 分钟伪造成 15 分钟」的执行点。
 *
 * @param {string} dateStr     YYYY-MM-DD
 * @param {string} startHHMM   原始开始时间 "HH:mm"
 * @param {number} durationMin 原始时长（分钟）
 * @returns {object}
 */
function snapRange(dateStr, startHHMM, durationMin) {
  const dur = Number(durationMin);

  if (!Number.isInteger(dur) || dur < 1 || dur > DAY) {
    return {
      rejected: true,
      reason: 'duration-out-of-range',
      message: '时长需在 1–1440 分钟之间',
      dateStr
    };
  }

  // 用**原始**时长判定最短，不能用吸附后的时长：
  // `09:07 + 3min` 吸附后是 15 分钟，那时再判 < 15 已经判不到了。
  if (dur < STEP) {
    return {
      rejected: true,
      reason: 'too-short',
      message: `人工记录最短 15 分钟，当前 ${dur} 分钟，请调整时间`,
      dateStr,
      rawDurationMin: dur
    };
  }

  const startRaw = parseHHMM(startHHMM);
  if (startRaw === null) {
    return {
      rejected: true,
      reason: 'bad-start-format',
      message: `开始时间格式无效：${startHHMM}`,
      dateStr
    };
  }

  const startSnapped = snapToStep(startRaw);
  if (startSnapped >= DAY) {
    // 23:53 吸附后成了次日 00:00。自动顺延日期是更隐蔽的错误——
    // 用户以为记在 11-08，实际记在 11-09，统计口径全错。明确拒绝。
    return {
      rejected: true,
      reason: 'start-crosses-day',
      message: `开始时间 ${startHHMM} 吸附后为次日 00:00，会改变记录日期。请改为 23:45 或更早，或把日期改为次日。`,
      dateStr,
      rawStart: startHHMM
    };
  }

  const { endRaw, crossMidnight } = deriveEnd(startRaw, dur);
  const endSnapped = snapEnd(endRaw).endMin;
  const finalDuration = endSnapped - startSnapped;

  if (finalDuration <= 0) {
    // 理论上不可达（原始时长 >= 15），作为防御断言保留：
    // 若真的出现，宁可拒绝也不能写一条零长度记录
    return {
      rejected: true,
      reason: 'non-positive-duration',
      message: '吸附后时长不为正，请调整时间',
      dateStr
    };
  }

  return {
    startMin: startSnapped,
    endMin: endSnapped,
    durationMin: finalDuration,
    crossMidnight,
    start: formatHHMM(startSnapped),
    end: formatHHMM(endSnapped),
    // 吸附是否改变了时长：UI 用它决定要不要显示「输入 22 分钟 → 将保存为 15 分钟」
    distorted: finalDuration !== dur,
    rawDurationMin: dur
  };
}

/**
 * 找出与给定区间重叠的记录。
 *
 * 只回答「重叠了哪些、重叠多少、是不是同一条」，**不做任何删除或合并决定**。
 * 重叠检测与去重是两件事：去重按 rid 判断「是不是同一条记录」，
 * 重叠判断的是「两段时间有没有交叠」。把前者当后者，就会把「补记覆盖一段
 * 自动录制」误当成「重复记录」删掉。
 *
 * @param {string} dateStr  YYYY-MM-DD（用于把记录的时间映射到当天的分钟数）
 * @param {number} start    当天分钟数
 * @param {number} end      当天分钟数（可 > 1440 表示跨午夜）
 * @param {Array}  records  该天记录（结构同 getActivities 返回）
 * @returns {Array<{index:number, record:object, overlapMs:number, overlapMin:number, kind:string, source:string}>}
 */
function findOverlaps(dateStr, start, end, records) {
  const out = [];
  if (!Array.isArray(records) || !Number.isFinite(start) || !Number.isFinite(end)) return out;
  if (end <= start) return out;

  records.forEach((rec, index) => {
    if (!rec || !rec.timestamp) return;
    const rs = minutesOfDay(rec.timestamp, dateStr);
    if (rs === null) return;
    const durMin = (Number(rec.durationMs) || 0) / 60000;
    if (durMin <= 0) return;
    const re = rs + durMin;

    const overlapStart = Math.max(start, rs);
    const overlapEnd = Math.min(end, re);
    if (overlapEnd <= overlapStart) return;

    out.push({
      index,
      record: rec,
      overlapMs: (overlapEnd - overlapStart) * 60000,
      overlapMin: overlapEnd - overlapStart,
      // record = 不可修改的自动采样；display = 人工/导入的标注
      kind: rec.source === 'manual' || rec.source === 'imported' ? 'display' : 'record',
      source: rec.source || 'auto'
    });
  });

  return out;
}

/**
 * 把记录时间戳换算成「相对 dateStr 当天」的分钟数。
 * 跨午夜的第二段（次日 00:00 起）会得到 >= 1440，与区间表示一致。
 */
function minutesOfDay(timestamp, dateStr) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const base = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  return (d.getTime() - base.getTime()) / 60000;
}

module.exports = {
  STEP,
  DAY,
  snapStart,
  deriveEnd,
  snapEnd,
  snapRange,
  findOverlaps,
  // 供其他模块做「只吸附一个数」时使用，避免再写一遍 round(x/15)*15
  snapToStep,
  formatHHMM,
  parseHHMM
};
