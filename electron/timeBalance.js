function buildDayBalance(slots) {
  const totals = { work: 0, life: 0, sleep: 0, other: 0, unknown: 1440 };
  for (const slot of slots || []) {
    const minutes = Math.max(0, Math.min(15, Number(slot.filledMin) || 0));
    totals.unknown -= minutes;
    if (slot.category === '睡眠') totals.sleep += minutes;
    else if (slot.category === '生活' || slot.category === '娱乐') totals.life += minutes;
    else if (slot.category === '工作' || slot.category === '学习' || slot.category === '专注') totals.work += minutes;
    else totals.other += minutes;
  }
  totals.unknown = Math.max(0, totals.unknown);
  return totals;
}

module.exports = { buildDayBalance };
