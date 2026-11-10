'use strict';

/**
 * 把滴答《记录》里的计划模板一次性导入成本地重复计划。
 *
 * 默认只打印将要写入的内容（dry-run）；加 --write 才真正写 plans/local.json。
 * 已有同 内容+开始时间+重复规则 的系列会跳过，重复执行不会叠加。
 *
 * 用法：
 *   node scripts/import-dida-plans.js
 *   node scripts/import-dida-plans.js --write
 *   node scripts/import-dida-plans.js --data-dir "C:\path\to\data" --write
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('../electron/atomicFile');

const REPEAT_LABEL = {
  none: '不重复', daily: '每天', workday: '工作日', holiday: '节假日', weekend: '周末'
};

function appDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'worklog-assistant');
}

function resolveDataDir() {
  const i = process.argv.indexOf('--data-dir');
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const cfgPath = path.join(appDataDir(), 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.storage && cfg.storage.customPath) return cfg.storage.customPath;
  } catch (_) { /* 用默认目录 */ }
  return path.join(appDataDir(), 'Data');
}

function dateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 滴答的 RRULE → 本地重复规则 */
function repeatOf(flag) {
  const s = String(flag || '').toUpperCase();
  if (s.includes('TT_SKIP=HOLIDAY') && s.includes('WEEKEND')) return 'workday';
  if (s.includes('FREQ=DAILY')) return 'daily';
  if (s.includes('FREQ=WEEKLY')) return 'weekend';
  return 'none';
}

function loadTemplates(dataDir) {
  const file = path.join(dataDir, 'dida', 'plans', 'templates.json');
  if (!fs.existsSync(file)) throw new Error(`找不到滴答计划模板：${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw.items) ? raw.items : [];
}

function toSeries(template, today) {
  const start = new Date(Number(template.startMs));
  if (Number.isNaN(start.getTime())) return null;
  const startMin = start.getHours() * 60 + start.getMinutes();
  const durationMin = Math.max(15, Math.round((Number(template.durationMs) || 1800000) / 60000 / 15) * 15);
  const repeat = repeatOf(template.repeatFlag);
  return {
    localId: crypto.randomUUID(),
    // 重复计划从今天开始生效；单次计划保留它原本的日期
    date: repeat === 'none' ? dateStr(start) : today,
    startMin: Math.floor(startMin / 15) * 15,
    durationMin: Math.min(1440 - Math.floor(startMin / 15) * 15, durationMin),
    label: String(template.label || template.title || '计划').slice(0, 100),
    title: String(template.label || template.title || '计划').slice(0, 100),
    category: String(template.category || '其他'),
    project: '',
    repeat,
    repeatEnd: '',
    exceptions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function clock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function main() {
  const write = process.argv.includes('--write');
  const dataDir = resolveDataDir();
  const today = dateStr(new Date());
  const templates = loadTemplates(dataDir);
  const planFile = path.join(dataDir, 'plans', 'local.json');

  let current = { items: [], actuals: {} };
  if (fs.existsSync(planFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      current = {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        actuals: parsed.actuals && typeof parsed.actuals === 'object' ? parsed.actuals : {}
      };
    } catch (_) { /* 坏文件按空处理 */ }
  }

  const keyOf = item => `${item.label}|${item.startMin}|${item.repeat || 'none'}`;
  const existing = new Set(current.items.map(keyOf));
  const added = [];
  const skipped = [];

  for (const tpl of templates) {
    const series = toSeries(tpl, today);
    if (!series) continue;
    const key = keyOf(series);
    if (existing.has(key)) { skipped.push(series); continue; }
    existing.add(key);
    added.push(series);
  }

  console.log(`数据目录：${dataDir}`);
  console.log(`模板 ${templates.length} 条 → 新增 ${added.length} 条，跳过已存在 ${skipped.length} 条`);
  console.log(`现有本地计划 ${current.items.length} 条，导入后 ${current.items.length + added.length} 条\n`);

  for (const s of added) {
    console.log(`  [${REPEAT_LABEL[s.repeat]}] ${clock(s.startMin)} ${String(s.durationMin).padStart(3)}分  ${s.label}（${s.category}）`);
  }
  if (!added.length) console.log('  没有需要新增的计划。');

  if (!write) {
    console.log('\n以上是 dry-run。确认无误后加 --write 才会写入。');
    return;
  }

  const next = {
    version: 1,
    items: [...current.items, ...added],
    actuals: current.actuals
  };
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  writeFileAtomic(planFile, JSON.stringify(next, null, 2));
  console.log(`\n已写入 ${planFile}`);
}

try {
  main();
} catch (error) {
  console.error('导入失败：', error.message || error);
  process.exitCode = 1;
}
