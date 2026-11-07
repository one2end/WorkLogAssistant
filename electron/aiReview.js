function estimateTokens(text) {
  const value = String(text || '');
  const wide = (value.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil(wide * 1.5 + (value.length - wide) / 4);
}

function overlapClues(activities, limit = 5) {
  const manual = (activities || []).filter(a => a.source === 'manual' && Number(a.durationMs) > 0);
  const automatic = (activities || []).filter(a => (!a.source || a.source === 'auto') && Number(a.durationMs) > 0);
  const clues = [];
  for (const claim of manual) {
    const start = new Date(claim.timestamp).getTime();
    const end = start + claim.durationMs;
    if (!Number.isFinite(start)) continue;
    const matches = automatic.filter(a => {
      const at = new Date(a.timestamp).getTime();
      return Number.isFinite(at) && Math.min(end, at + a.durationMs) - Math.max(start, at) >= 5 * 60000;
    });
    if (!matches.length) continue;
    const names = [...new Set(matches.map(a => String(a.processName || '').trim()).filter(Boolean))].slice(0, 3);
    clues.push({ time: new Date(start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      manual: String(claim.windowTitle || claim.processName || '手工标注').slice(0, 80), apps: names });
    if (clues.length >= limit) break;
  }
  return clues;
}

function reviewWindow(lastEnd, now, intervalMinutes) {
  const end = new Date(now);
  const saved = new Date(lastEnd || 0);
  const elapsed = end.getTime() - saved.getTime();
  const valid = Number.isFinite(saved.getTime()) && elapsed >= 0 && elapsed <= 5 * 3600000;
  return { start: valid ? saved : new Date(end.getTime() - intervalMinutes * 60000), end };
}

module.exports = { estimateTokens, overlapClues, reviewWindow };
