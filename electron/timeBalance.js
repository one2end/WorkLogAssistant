function buildDayBalance(slots, customGroups = {}) {
  const totals = { work: 0, life: 0, sleep: 0, other: 0, unknown: 1440 };
  for (const slot of slots || []) {
    const minutes = Math.max(0, Math.min(15, Number(slot.filledMin) || 0));
    totals.unknown -= minutes;
    const group = customGroups[slot.category] || slot.category;
    if (group === '睡眠') totals.sleep += minutes;
    else if (group === '生活' || group === '娱乐') totals.life += minutes;
    else if (group === '工作' || group === '学习' || group === '专注') totals.work += minutes;
    else totals.other += minutes;
  }
  totals.unknown = Math.max(0, totals.unknown);
  return totals;
}

module.exports = { buildDayBalance };
