const GENERIC_APPS = new Set(['chrome', 'chrome.exe', 'msedge', 'msedge.exe', 'firefox', 'firefox.exe', 'explorer', 'explorer.exe', 'wechat', 'weixin']);
const { simpleCategory } = require('./analytics');

function categorySuggestions(records, slots, limit = 3) {
  const history = new Map();
  for (const record of records || []) {
    if (record.source !== 'manual' || !record.category) continue;
    const app = String(record.processName || '').trim().toLowerCase();
    if (!app || GENERIC_APPS.has(app)) continue;
    const categories = history.get(app) || new Map();
    categories.set(record.category, (categories.get(record.category) || 0) + 1);
    history.set(app, categories);
  }

  const seen = new Set();
  const suggestions = [];
  for (const slot of slots || []) {
    const app = String(slot.app || '').trim().toLowerCase();
    if (slot.layer !== 'auto' || slot.filledMin < 8 || slot.appPurity < 0.8 ||
        slot.layerPurity < 0.95 || seen.has(app)) continue;
    const categories = history.get(app);
    if (!categories) continue;
    const ranked = [...categories].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, item) => sum + item[1], 0);
    const [category, count] = ranked[0];
    if (count < 2 || count / total < 0.8 || simpleCategory(category) === slot.category) continue;
    seen.add(app);
    suggestions.push({ startMin: slot.startMin, app: slot.app, category,
      previousCategory: slot.category, evidence: count, note: slot.note || '' });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

module.exports = { categorySuggestions };
