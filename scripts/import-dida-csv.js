/**
 * 从滴答清单 CSV 导出文件导入「⏱记录」清单的时间段。
 *
 * 用法：
 *   node scripts/import-dida-csv.js <backup.csv> [--write]
 *
 * 为什么单独写一个：MCP 接口单次最多返回 200 条，只能按月翻页；CSV 导出是
 * 全量（这个备份里 7400 条，覆盖 2022-12 ~ 2026-11），一次就能拿全。
 *
 * 规则：
 *   1. 只取「List Name = ⏱记录」，且 Start/Due 都齐全、时长 <= 20 小时的条目
 *   2. 只导入 2026-11-06 之前的记录（此后由应用自身录制负责）
 *   3. 跨天条目按本地日期拆段
 *   4. 与已有数据去重：同一天里 (开始时刻, 时长) 完全相同的直接跳过
 *   5. 该天已有「屏幕录制」时整条跳过：屏幕采样才是那天的主数据源，
 *      两套并存会把工时算成两倍（旧格式 .json 只有采样时刻、没有时长，
 *      所以无法做区间相减，只能二选一）
 *   6. 每条都带 raw：CSV 原始行原样保留，以后改分类/改口径不必再导一次
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CUTOFF = new Date('2026-11-06T00:00:00+08:00').getTime();
const MIN_SEG_MS = 3 * 60 * 1000;   // 残余片段小于 3 分钟视为噪声
const MAX_REC_MS = 20 * 3600 * 1000;

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
// --rebuild：先清掉上一次由本脚本写入的 dida 记录，再按当前规则重导。
// 滴答记录完全由 CSV 派生，清掉重算不会丢任何原始信息（CSV 备份在磁盘上）。
const REBUILD = args.includes('--rebuild');
const csvPath = args.find(a => !a.startsWith('--'));
if (!csvPath) {
  console.error('用法: node scripts/import-dida-csv.js <backup.csv> [--write]');
  process.exit(1);
}

// ---------- CSV 解析（滴答导出的前 4 行是元信息） ----------
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const headIdx = lines.findIndex(l => l.startsWith('"Folder Name"'));
  if (headIdx < 0) throw new Error('找不到表头，确认是滴答清单导出的 CSV');

  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
        } else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };

  const header = parseLine(lines[headIdx]).map(h => h.replace(/^"|"$/g, ''));
  const rows = [];
  let buf = '';
  for (let i = headIdx + 1; i < lines.length; i += 1) {
    buf += (buf ? '\n' : '') + lines[i];
    // 引号数量为偶数时说明这条记录读完了（Content 里可能有多行）
    const quotes = (buf.match(/"/g) || []).length;
    if (quotes % 2 !== 0) continue;
    if (!buf.trim()) { buf = ''; continue; }
    const cells = parseLine(buf);
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx] === undefined ? '' : cells[idx]; });
    rows.push(row);
    buf = '';
  }
  return rows;
}

// ---------- 分类（与 import-dida.js 保持一致） ----------
const LIFE_HINTS_WORK = ['工作', '上班', '帮扶', '督导', '迁移', '收单', '商户', '业务'];
const RULES = [
  ['睡眠', 'active', ['睡觉', '午睡', '补觉']],
  ['开发编码', 'active', ['开发', '写代码', '编程', '代码', '部署']],
  ['影音娱乐', 'active', ['娱乐', '游戏', '刷', '视频', '小说', '看剧', '抖音', '玩手机']],
  ['沟通协作', 'active', ['开会', '会议', '沟通', '对接', '走访', '客户', '汇报', '参会']],
  ['文档写作', 'active', ['写', '材料', '报告', '通报', '分析', '总结', '公文', '文档', '方案', '简报', '稿']],
  ['任务与效率', 'active', ['数据', '报表', '统计', '台账', '清单']],
  ['任务与效率', 'active', ['思考', '整理', '计划', '复盘', '梳理']],
  ['系统工具', 'active', ['折腾', '装', '配置', '电视', '软件']],
  ['文档写作', 'active', ['学习', '阅读', '听书', '读书']],
  ['任务与效率', 'active', LIFE_HINTS_WORK],
  ['AI 助手', 'active', ['用ai', 'ai助手', 'ai帮', '问ai', 'ai整理', 'ai协作', 'ai写', 'gpt']]
];

function classify(title) {
  for (const [cat, kind, keys] of RULES) {
    if (keys.some(k => title.includes(k))) return { cat, kind };
  }
  return { cat: '生活事务', kind: 'active' };
}

function appOf(title) {
  const m = title.match(/^([\u4e00-\u9fa5A-Za-z]{1,4})-/);
  return m ? m[1] : '记录';
}

// ---------- 数据目录 ----------
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming');
let dataDir = path.join(appData, 'worklog-assistant', 'Data');
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(appData, 'worklog-assistant', 'config.json'), 'utf8'));
  if (cfg.storage && cfg.storage.customPath) dataDir = cfg.storage.customPath;
} catch (e) { /* 用默认目录 */ }
const actDir = path.join(dataDir, 'activities');
if (!fs.existsSync(actDir)) throw new Error(`数据目录不存在: ${actDir}`);

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ---------- 读现有数据 ----------
const existing = new Map();   // day -> { keys:Set, records:[] }
const screenByDay = new Map(); // day -> [[startMs, endMs]]
for (const f of fs.readdirSync(actDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const day = f.split('.')[0];
  const keys = new Set();
  const records = [];
  const screens = [];
  for (const line of fs.readFileSync(path.join(actDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    // 重建模式下旧的 dida 行会被删掉，不能拿它当「已存在」的依据，
    // 否则会把自己上一次的结果当成重复，一条也导不进去。
    if (REBUILD && r.source === 'dida') continue;
    records.push(r);
    keys.add(`${r.t}|${r.dur}`);
    // 屏幕录制：只有录制器写入的记录才算「已覆盖的真实电脑时间」
    const isScreen = !r.source || r.source === 'recorded';
    if (isScreen) {
      const start = new Date(r.t).getTime();
      if (!Number.isNaN(start)) screens.push([start, start + (r.dur || 0)]);
    }
  }
  existing.set(day, { keys, records });
  if (screens.length) screenByDay.set(day, screens);
}

// 旧格式 .json（只有 timestamp 的采样点）也算「这天有屏幕数据」
const legacyDays = new Set();
for (const f of fs.readdirSync(actDir)) {
  if (f.endsWith('.json') && !f.endsWith('.jsonl')) legacyDays.add(f.slice(0, 10));
}
const screenDays = new Set([...screenByDay.keys(), ...legacyDays]);

// 用一个区间集合减去另一组区间，返回剩余片段
function subtract(intervals, covers) {
  if (!covers.length) return intervals.slice();
  const sorted = covers.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of intervals) {
    let cursor = s;
    for (const [cs, ce] of sorted) {
      if (ce <= cursor) continue;
      if (cs >= e) break;
      if (cs > cursor) out.push([cursor, Math.min(cs, e)]);
      cursor = Math.max(cursor, ce);
      if (cursor >= e) break;
    }
    if (cursor < e) out.push([cursor, e]);
  }
  return out;
}

// ---------- 读 CSV ----------
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const recs = rows.filter(r =>
  (r['List Name'] || '').trim() === '⏱记录' &&
  r['Start Date'] && r['Due Date']
);
console.log(`CSV 记录清单条目: ${recs.length}`);

const seenRow = new Set();   // CSV 内部去重（同一开始时刻 + 同一标题）
const batch = new Map();     // day -> [record]
const stats = {
  beforeCutoff: 0, tooLong: 0, badRange: 0, dupInCsv: 0,
  wholeAdded: 0, residualAdded: 0, coveredByScreen: 0, dupExisting: 0,
  points: 0, days: new Set(), byYear: {}, cat: {}
};

for (const r of recs) {
  const title = (r['Title'] || '').trim();
  const a = new Date(r['Start Date']);
  const b = new Date(r['Due Date']);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) { stats.badRange += 1; continue; }
  if (a.getTime() >= CUTOFF) continue;
  if (b - a > MAX_REC_MS) { stats.tooLong += 1; continue; }
  stats.beforeCutoff += 1;

  // 开始 = 结束：这是「点记录」，只说明那一刻在做这件事，没有时长。
  // 不猜、不补时长，原样存成 dur=0 的 point，统计时会自动跳过、数据不丢。
  const isPoint = b.getTime() === a.getTime();

  const rowKey = `${r['Start Date']}|${title}`;
  if (seenRow.has(rowKey)) { stats.dupInCsv += 1; continue; }
  seenRow.add(rowKey);

  const { cat, kind } = classify(title);
  const app = appOf(title);
  const raw = {
    title,
    content: r['Content'] || '',
    tags: r['Tags'] || '',
    status: r['Status'] || '',
    taskId: r['taskId'] || '',
    created: r['Created Time'] || '',
    completed: r['Completed Time'] || '',
    start: r['Start Date'],
    due: r['Due Date']
  };

  if (isPoint) {
    const day = ymd(a);
    const t = a.toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const dayKeys = existing.get(day);
    if (dayKeys && dayKeys.records.some(x => x.t === t && x.point)) { stats.dupExisting += 1; continue; }
    if (!batch.has(day)) batch.set(day, []);
    const list = batch.get(day);
    if (list.some(x => x.t === t && x.point)) { stats.dupExisting += 1; continue; }
    list.push({ t, dur: 0, point: true, kind, app, title, platform: 'dida', source: 'dida', cat, raw });
    stats.points += 1;
    stats.days.add(day);
    const y = day.slice(0, 4);
    stats.byYear[y] = (stats.byYear[y] || 0) + 1;
    stats.cat[cat] = (stats.cat[cat] || 0) + 1;
    continue;
  }

  // 按本地日期拆段
  let cur = new Date(a);
  while (cur < b) {
    const nextMidnight = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    const segEnd = nextMidnight < b ? nextMidnight : b;
    const day = ymd(cur);
    if (screenDays.has(day)) { stats.coveredByScreen += 1; cur = new Date(segEnd); continue; }
    const pieces = [[cur.getTime(), segEnd.getTime()]];

    for (const [ps, pe] of pieces) {
      const dur = pe - ps;
      if (dur < MIN_SEG_MS) { stats.coveredByScreen += 1; continue; }
      const t = new Date(ps).toISOString().replace(/\.\d{3}Z$/, '.000Z');
      const entry = {
        t,
        dur: Math.round(dur),
        kind,
        app,
        title,
        platform: 'dida',
        source: 'dida',
        cat,
        raw
      };

      const dayKeys = existing.get(day);
      if (dayKeys && dayKeys.keys.has(`${t}|${dur}`)) { stats.dupExisting += 1; continue; }

      if (!batch.has(day)) batch.set(day, []);
      const list = batch.get(day);
      if (list.some(x => x.t === t && x.dur === entry.dur)) { stats.dupExisting += 1; continue; }
      list.push(entry);

      // 完全覆盖原文：整段没被屏幕录制切过才算「整段新增」
      if (pieces.length === 1 && ps === cur.getTime() && pe === segEnd.getTime()) stats.wholeAdded += 1;
      else stats.residualAdded += 1;

      stats.days.add(day);
      const y = day.slice(0, 4);
      stats.byYear[y] = (stats.byYear[y] || 0) + 1;
      stats.cat[cat] = (stats.cat[cat] || 0) + 1;
    }
    cur = new Date(segEnd);
  }
}

const totalNew = [...batch.values()].reduce((n, l) => n + l.length, 0);

// ---------- 写入 ----------
if (WRITE && REBUILD) {
  let removed = 0;
  for (const f of fs.readdirSync(actDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(actDir, f);
    const kept = [];
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (e) { kept.push(line); continue; }
      if (r.source === 'dida') { removed += 1; continue; }
      kept.push(line);
    }
    if (kept.length) fs.writeFileSync(fp, kept.join('\n') + '\n', 'utf8');
    else fs.writeFileSync(fp, '', 'utf8');
  }
  console.log(`重建：清除上一次导入的 dida 记录 ${removed} 条`);
}

if (WRITE) {
  for (const [day, list] of batch) {
    fs.appendFileSync(path.join(actDir, `${day}.jsonl`),
      list.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  }
}

console.log('\n=== 统计 ===');
console.log(`截止 2026-11-06 之前: ${stats.beforeCutoff} 条`);
console.log(`CSV 内部重复跳过: ${stats.dupInCsv} 条`);
console.log(`与已有数据重复跳过: ${stats.dupExisting} 条`);
console.log(`因当天有屏幕数据而跳过: ${stats.coveredByScreen} 段`);
console.log(`超长/异常区间跳过: ${stats.tooLong + stats.badRange} 条`);
console.log(`新增: ${totalNew} 列，涉及 ${stats.days.size} 天`);
console.log(`  整段新增: ${stats.wholeAdded}　补空白片段: ${stats.residualAdded}　点记录(dur=0): ${stats.points}`);
console.log('按年:', stats.byYear);
console.log('按分类:', stats.cat);
console.log(`数据目录: ${actDir}`);
console.log(WRITE ? '✅ 已写入' : '（预览模式，加 --write 才写盘）');
