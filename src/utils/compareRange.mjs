/* ==========================================================================
   周期对比的纯计算
   输入是两份 buildRangeReport 的结果（本期 / 上期），输出「同一口径下的差」。
   只做算术，不做格式化与配色——文案在组件里，颜色在 palette 里。
   ========================================================================== */

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 含首尾的日期序列；解析失败返回空数组，避免把 NaN 带进图表 */
export function dateList(from, to) {
  const out = [];
  if (!from || !to) return out;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return out;
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    out.push(toDateStr(cursor));
  }
  return out;
}

function dayMap(report) {
  const map = new Map();
  for (const day of report?.days || []) {
    if (day && day.date) map.set(day.date, num(day.trackedMs));
  }
  return map;
}

/**
 * 按名字合并两份清单，差值 = 本期 - 上期。
 * 排序用绝对值：减少 2 小时和增加 2 小时一样值得先看。
 */
export function mergeDeltas(currentItems = [], previousItems = [], pickName = item => item.name) {
  const map = new Map();
  const push = (item, side) => {
    const name = pickName(item);
    if (!name) return;
    const entry = map.get(name) || { name, currentMs: 0, previousMs: 0 };
    entry[side] += num(item.durationMs);
    map.set(name, entry);
  };
  for (const item of currentItems || []) push(item, 'currentMs');
  for (const item of previousItems || []) push(item, 'previousMs');

  return Array.from(map.values())
    .filter(entry => entry.currentMs > 0 || entry.previousMs > 0)
    .map(entry => ({
      ...entry,
      deltaMs: entry.currentMs - entry.previousMs,
      // 上期为 0 时比例没有意义，交给 UI 显示「新增」
      deltaRatio: entry.previousMs > 0 ? (entry.currentMs - entry.previousMs) / entry.previousMs : null
    }))
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs) || a.name.localeCompare(b.name, 'zh'));
}

/** 变化最靠前的几项，用于「增加最多 / 减少最多」的结论句 */
export function topMovers(items, n = 3) {
  const list = items || [];
  return {
    up: list.filter(x => x.deltaMs > 0).sort((a, b) => b.deltaMs - a.deltaMs).slice(0, n),
    down: list.filter(x => x.deltaMs < 0).sort((a, b) => a.deltaMs - b.deltaMs).slice(0, n)
  };
}

/**
 * 主入口。
 * 逐日序列按日期位置配对（第 i 天对第 i 天），而不是按数组下标——
 * buildRangeReport().days 只包含有文件的日子，直接按下标会错位。
 */
export function buildComparison({ current, previous, from, to, previousFrom, previousTo } = {}) {
  const currentMs = num(current?.stats?.trackedMs);
  const previousMs = num(previous?.stats?.trackedMs);
  const deltaMs = currentMs - previousMs;

  const activeDays = {
    current: num(current?.stats?.activeDayCount),
    previous: num(previous?.stats?.activeDayCount)
  };

  const currentDates = dateList(from, to);
  const previousDates = dateList(previousFrom, previousTo);
  const currentMap = dayMap(current);
  const previousMap = dayMap(previous);

  const days = currentDates.map((date, index) => {
    const pairDate = previousDates[index] || '';
    const cur = currentMap.get(date) || 0;
    const prev = pairDate ? (previousMap.get(pairDate) || 0) : 0;
    return { date, previousDate: pairDate, currentMs: cur, previousMs: prev, deltaMs: cur - prev };
  });

  const categories = mergeDeltas(current?.categories, previous?.categories);
  const projects = mergeDeltas(current?.projects, previous?.projects);

  return {
    from,
    to,
    previousFrom,
    previousTo,
    hasCurrent: currentMs > 0,
    hasPrevious: previousMs > 0,
    totals: {
      currentMs,
      previousMs,
      deltaMs,
      deltaRatio: previousMs > 0 ? deltaMs / previousMs : null
    },
    activeDays,
    // 日均只按「有记录的天」摊：把空白日算进来会让两期都失真，尤其是假期
    avgPerActiveDay: {
      current: activeDays.current ? currentMs / activeDays.current : 0,
      previous: activeDays.previous ? previousMs / activeDays.previous : 0
    },
    days,
    categories,
    projects
  };
}
