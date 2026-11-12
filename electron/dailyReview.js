'use strict';

/**
 * 每日复盘 —— 从当天的真实记录生成一份可以编辑、可以导出的收尾草稿。
 *
 * 三条硬规则：
 *
 *   1. **不编造。** 每一句结论都要能指回具体记录。没有记录就说没有记录，
 *      而不是猜「今天可能主要在开会」。
 *
 *   2. **不依赖 AI。** 这里有价值的部分是「把散落的记录整理成人话」，
 *      那是统计能做的工作。AI 只是可选的补充（明天建议），关掉它
 *      这个功能仍然完整可用。
 *
 *   3. **不评判。** 计划没完成不等于效率低。写完就去做别的事、
 *      临时插入的急事、一整个下午的会议——这些都合理地改变了计划。
 *      草稿只陈述事实，把判断留给用户。
 */

const analytics = require('./analytics');

/** 分钟 → 「1 小时 20 分钟」，过于零碎的分钟数直接省略 */
function humanDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 60000);
  if (total <= 0) return '0 分钟';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

function hhmmOf(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--:--';
  return hhmm(d.getTime());
}

function hhmm(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 从 15 分钟格里找出连续的空白段。
 *
 * 只看格子的 filledMin，不去猜「为什么空」——离线工作、开会、
 * 关掉录制都可能造成空白，代码没有依据区分它们。
 *
 * 只统计**首条记录与末条记录之间**的空白。午夜到第一条记录、
 * 最后一条记录到午夜这两段本来就不该算——人不是 0 点开工的。
 * 不加这个限制，一份只有两个小时的记录会报告「22 小时空白」，
 * 那种数字只会让人不再看这一段。
 */
function findLongGaps(report, minMs) {
  const allSlots = Array.isArray(report.slots) ? report.slots : [];
  if (!allSlots.length) return [];

  const firstFilled = allSlots.findIndex(s => s && (s.filledMin || 0) > 0);
  if (firstFilled < 0) return [];
  let lastFilled = allSlots.length - 1;
  while (lastFilled > 0 && !(allSlots[lastFilled] && (allSlots[lastFilled].filledMin || 0) > 0)) {
    lastFilled -= 1;
  }
  const slots = allSlots.slice(firstFilled, lastFilled + 1);

  const gaps = [];
  let runStartMin = null;
  let runSlots = 0;

  const flush = () => {
    if (runStartMin !== null && runSlots > 0) {
      // 每个格是 15 分钟；用格数算时长而不是累加 filledMin，
      // 因为空格的 filledMin 恒为 0，累加会得到 0。
      const durationMs = runSlots * 15 * 60000;
      if (durationMs >= minMs) gaps.push({ startMin: runStartMin, durationMs });
    }
    runStartMin = null;
    runSlots = 0;
  };

  for (const slot of slots) {
    // 空格的定义是 filledMin 为 0。字段名是 filledMin 不是 filled——
    // 报告里没有布尔标记，用「填入了多少分钟」表达。
    const empty = !slot || (slot.filledMin || 0) === 0;
    if (empty) {
      if (runStartMin === null) runStartMin = slot ? slot.startMin : null;
      runSlots += 1;
    } else {
      flush();
    }
  }
  flush();
  return gaps;
}

/**
 * 从一天的报告里挑出「值得注意」的几条。
 *
 * 每一条都必须由数据触发，不是固定文案：没有触发条件就不写。
 * 这是「不编造」的具体落实——空话比没有更糟，它让人以后不再读这一段。
 */
function notableItems(report, options) {
  const opts = options || {};
  const items = [];
  const stats = report.stats || {};

  // 未记录的空白时段（超过 2 小时才值得提）。
  // 数据来自 slots 里空闲的 15 分钟格，不是 layers——layers 只有各来源时长。
  const longGaps = findLongGaps(report, 2 * 60 * 60 * 1000);
  if (longGaps.length) {
    const total = longGaps.reduce((s, g) => s + g.durationMs, 0);
    items.push({
      kind: 'gap',
      text: `记录之间有 ${longGaps.length} 段超过 2 小时的空档，合计 ${humanDuration(total)}，可能是离线工作或没有记录`
    });
  }

  // 离座时间过长
  if ((stats.idleMs || 0) >= 2 * 60 * 60 * 1000) {
    items.push({
      kind: 'idle',
      text: `离座时间 ${humanDuration(stats.idleMs)}，占了记录的相当一部分`
    });
  }

  // 单一应用占比过高（只看时长够不够长，避免把短暂集中误判成「过度」）
  const apps = Array.isArray(report.apps) ? report.apps : [];
  const dominant = apps[0];
  if (dominant && (dominant.percent || 0) >= 0.6 && (stats.trackedMs || 0) >= 3 * 60 * 60 * 1000) {
    items.push({
      kind: 'dominant',
      text: `${dominant.processName} 占今日记录时长的 ${Math.round(dominant.percent * 100)}%`
    });
  }

  // 应用切换频繁：说明这一天被打断得多，是值得知道的事，不是缺点
  const switches = apps.reduce((s, a) => s + (a.sessionCount || 0), 0);
  const hours = (stats.trackedMs || 0) / 3600000;
  if (hours >= 2 && switches / hours >= 25) {
    items.push({
      kind: 'fragmented',
      text: `平均每小时切换 ${Math.round(switches / hours)} 次，记录比较碎片化`
    });
  }

  // 有低于中等置信度的活动线程待确认
  const threads = Array.isArray(report.activityThreads) ? report.activityThreads : [];
  const pending = threads.filter(t => t.needsConfirmation);
  if (pending.length) {
    items.push({
      kind: 'pending',
      text: `有 ${pending.length} 段活动需要你确认归属`,
      action: 'review-threads'
    });
  }

  return items;
}

/**
 * 计划与实际的对照。
 *
 * 只做「发生了什么」的分类，不做评价：
 *   done      计划里有，也有对应实际
 *   partial   计划里有，实际时长明显不足
 *   missed    计划里有，没有对应记录
 *   extra     计划里没有，但有明显投入
 */
function planComparison(planItems, report, options) {
  const opts = options || {};
  const plans = Array.isArray(planItems) ? planItems : [];

  const done = [];
  const partial = [];
  const missed = [];

  for (const item of plans) {
    const actual = item.actual;
    const planned = Number(item.durationMin) || 0;
    if (!actual) {
      missed.push({ item, planned });
      continue;
    }
    const actualMin = Math.round((Number(actual.durationMs) || 0) / 60000);
    // 实际投入不足计划的一半时算「部分完成」。这个阈值不重要，
    // 重要的是不把「差 10 分钟」和「完全没做」混为一谈。
    if (planned > 0 && actualMin < planned / 2) {
      partial.push({ item, planned, actualMin });
    } else {
      done.push({ item, planned, actualMin });
    }
  }

  // 临时增加：计划里没有、但实际投入不小的活动。
  // 计算方式是把活动线程和计划时段求差，不是「实际 - 计划」的算术。
  const threads = Array.isArray(report.activityThreads) ? report.activityThreads : [];
  const extra = [];
  for (const t of threads) {
    if ((t.durationMs || 0) < 20 * 60000) continue; // 短穿插不算「增加了活动」
    const startMin = minutesOfDay(t.start);
    const endMin = minutesOfDay(t.end);
    if (startMin === null || endMin === null) continue;

    const overlapsPlan = plans.some(p => {
      const ps = Number(p.startMin);
      const pe = Number(p.endMin);
      if (!Number.isFinite(ps) || !Number.isFinite(pe)) return false;
      // 与计划时段有任何交集就算「落在计划里」
      return startMin < pe && endMin > ps;
    });
    if (!overlapsPlan) {
      extra.push({ thread: t, durationMs: t.durationMs });
    }
  }

  return { done, partial, missed, extra };
}

/** ISO 时间 → 当天分钟数 */
function minutesOfDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 生成 Markdown 草稿。
 *
 * @param {object} input
 * @param {object} input.report buildDayReport 的结果
 * @param {Array}  [input.plans] 当天计划（带 actual）
 * @param {string} [input.date]
 * @returns {{ markdown: string, sections: object, warnings: string[] }}
 */
function buildDailyReview(input) {
  const { report, plans, date } = input || {};
  const warnings = [];

  if (!report || !report.stats) {
    return {
      markdown: '',
      sections: {},
      warnings: ['没有拿到这一天的统计数据，无法生成复盘']
    };
  }

  const stats = report.stats;
  const trackedMs = stats.trackedMs || 0;
  const apps = Array.isArray(report.apps) ? report.apps : [];
  const categories = Array.isArray(report.categories) ? report.categories : [];
  const threads = Array.isArray(report.activityThreads) ? report.activityThreads : [];

  const hasData = trackedMs > 0 || apps.length > 0;
  if (!hasData) {
    // 空白天不生成一份看起来很正式的复盘——那等于编造
    return {
      markdown: `## ${date || report.date || '今天'}\n\n这一天没有记录到活动。\n\n可能是没有使用电脑，或者录制没有开启。这不代表「什么都没做」。\n`,
      sections: { empty: true },
      warnings: ['这一天没有活动记录']
    };
  }

  // --- 1. 今天做了什么 ---
  const topThreads = threads
    .filter(t => (t.durationMs || 0) >= 15 * 60000)
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, 5);

  const didLines = [];
  if (topThreads.length) {
    for (const t of topThreads) {
      const label = t.label || t.group || '未命名活动';
      const project = t.project ? ` · ${t.project}` : '';
      // start/end 是 ISO 字符串，转成时刻再显示
      didLines.push(`- ${label}${project}：${humanDuration(t.durationMs)}（${hhmmOf(t.start)}–${hhmmOf(t.end)}）`);
    }
  } else {
    // 没有成型的活动线程时退回按应用归纳，但要说清这是粗粒度的
    for (const a of apps.slice(0, 5)) {
      didLines.push(`- ${a.processName}：${humanDuration(a.durationMs)}`);
    }
    warnings.push('这一天的活动还没有归类成完整线程，这里按应用粗略归纳');
  }

  // --- 2. 主要时间投入 ---
  const investLines = [];
  investLines.push(`- 记录时长：**${humanDuration(trackedMs)}**`);
  if (stats.idleMs) investLines.push(`- 离座：${humanDuration(stats.idleMs)}`);
  if (stats.coverage) investLines.push(`- 覆盖了这一天 ${Math.round(stats.coverage * 100)}% 的时间`);
  for (const c of categories.slice(0, 5)) {
    const name = c.name || c.category || '未分类';
    investLines.push(`- ${name}：${humanDuration(c.durationMs)}（${Math.round((c.percent || 0) * 100)}%）`);
  }

  // --- 3. 计划与实际 ---
  const cmp = planComparison(plans, report);
  const planLines = [];
  if (!plans || plans.length === 0) {
    planLines.push('这一天没有安排计划。');
  } else {
    if (cmp.done.length) {
      planLines.push('**已完成**');
      for (const d of cmp.done) {
        planLines.push(`- ${d.item.title || d.item.category}：计划 ${d.planned} 分钟，实际 ${d.actualMin} 分钟`);
      }
    }
    if (cmp.partial.length) {
      planLines.push('**推进了一部分**');
      for (const d of cmp.partial) {
        planLines.push(`- ${d.item.title || d.item.category}：计划 ${d.planned} 分钟，实际 ${d.actualMin} 分钟`);
      }
    }
    if (cmp.extra && cmp.extra.length) {
      planLines.push('**计划外的时间**');
      for (const e of cmp.extra.slice(0, 5)) {
        const label = e.thread.label || e.thread.category || '未命名活动';
        planLines.push(`- ${label}：${humanDuration(e.durationMs)}`);
      }
      // 这句话很重要：计划外的时间不是「浪费」，只是没被安排
      planLines.push('');
      planLines.push('> 计划外的时间不一定是浪费——那可能正是当天真正要紧的事。');
    }
    if (cmp.missed.length) {
      planLines.push('**没有对应的记录**');
      for (const d of cmp.missed) {
        planLines.push(`- ${d.item.title || d.item.category}：计划 ${d.planned} 分钟`);
      }
      // 这一句是刻意的：没有记录不等于没做
      planLines.push('');
      planLines.push('> 没有记录不等于没有做——离开电脑完成的事情不会出现在这里。');
    }
  }

  // --- 4. 值得注意 ---
  const notable = notableItems(report, {});
  const notableLines = notable.map(n => `- ${n.text}`);

  // --- 5. 尚未完成 ---
  const unfinishedLines = [];
  for (const d of cmp.partial) {
    unfinishedLines.push(`- ${d.item.title || d.item.category}（还差 ${d.planned - d.actualMin} 分钟）`);
  }
  for (const d of cmp.missed) {
    unfinishedLines.push(`- ${d.item.title || d.item.category}`);
  }
  const pendingThreads = threads.filter(t => t.needsConfirmation);
  if (pendingThreads.length) {
    unfinishedLines.push(`- 有 ${pendingThreads.length} 段活动等着确认归属`);
  }

  // --- 组装 ---
  const heading = date || report.date || '';
  const md = [];
  md.push(`## ${heading} 复盘`);
  md.push('');
  md.push('### 今天做了什么');
  md.push(...(didLines.length ? didLines : ['- 记录不足，无法归纳']));
  md.push('');
  md.push('### 时间投入');
  md.push(...investLines);
  md.push('');
  md.push('### 计划与实际');
  md.push(...planLines);
  md.push('');
  if (notableLines.length) {
    md.push('### 值得注意');
    md.push(...notableLines);
    md.push('');
  }
  if (unfinishedLines.length) {
    md.push('### 还没完成');
    md.push(...unfinishedLines);
    md.push('');
  }

  return {
    markdown: md.join('\n'),
    sections: {
      did: didLines,
      invest: investLines,
      plan: planLines,
      notable: notableLines,
      unfinished: unfinishedLines
    },
    warnings
  };
}

module.exports = {
  buildDailyReview,
  notableItems,
  planComparison,
  humanDuration
};
