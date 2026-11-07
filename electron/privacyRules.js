function entries(value) {
  return String(value || '').split(/[\n,，]/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isExcludedSample(sample, monitoring = {}) {
  const app = String(sample?.processName || '').trim().toLowerCase();
  const title = String(sample?.windowTitle || '').toLowerCase();
  const apps = entries(monitoring.excludeApps);
  const titles = entries(monitoring.excludeTitleContains);
  return apps.includes(app) || titles.some(fragment => title.includes(fragment));
}

module.exports = { isExcludedSample };
