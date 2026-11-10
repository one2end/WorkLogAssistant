export function parseClock(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw) || /^(\d{1,2})(\d{2})$/.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function clockOf(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function durationFromClocks(startTime, endTime) {
  const start = parseClock(startTime);
  const end = parseClock(endTime);
  if (start === null || end === null) return null;
  return end > start ? end - start : end + 1440 - start;
}
