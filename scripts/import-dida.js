/**
 * 从滴答清单导入「⏱记录」项目的时间段，补进 WorkLog Assistant 的活动数据。
 *
 * 用法：
 *   node scripts/import-dida.js <dida-json-dir> [--write]
 *
 * dida-json-dir 里放 MCP 工具 list_completed_tasks_by_date 的输出文件
 * （多个 JSON 对象首尾相连，脚本会自动切分）。
 *
 * 规则：
 *   - 只取「⏱记录」项目、且 startDate / dueDate 都有的条目
 *   - 已有窗口录制的日期跳过，避免工时翻倍
 *   - 跨天条目按天拆分
 *   - 睡觉 → 空闲离座(idle)，生活/家庭/吃饭 → 生活事务，娱乐 → 影音娱乐
 *   - 写入 activities/YYYY-MM-DD.jsonl，按 (t,dur) 去重，不覆盖任何已有数据
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const RECORD_PROJECT = '6ad83ad4e4b00c3c97566f4e';
const CUTOFF = '2026-11-06T00:00:00+08:00';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const dir = args.find(a => !a.startsWith('--'));
if (!dir) {
  console.error('用法: node scripts/import-dida.js <dida-json-dir> [--write]');
  process.exit(1);
}

function readLooseJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && ' \r\n\t,'.includes(raw[i])) i += 1;
    if (i >= raw.length) break;
    // 用 JSON.parse 的增量模式切分相接的对象
    let depth = 0;
    let start = i;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (; i < raw.length; i += 1) {
      const c = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; i += 1; break; }
      }
    }
    if (end < 0) break;
    try { out.push(JSON.parse(raw.slice(start, end))); } catch (e) { /* skip */ }
  }
  return out;
}

const LIFE_HINTS_WORK = ['工作', '上班', '帮扶', '督导', '迁移', '收单', '商户', '业务'];
// 顺序即优先级：先识别睡觉/开发/娱乐等特征强的，再落到工作细分。
// AI 必须放在最后且用严格关键词，否则「娱乐-刷视频时用 ai 弄电视」
// 这类标题会被误判成 AI 助手，把整段娱乐时间算进工作工时。
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

// 1. 汇总任务（按 id 去重）
const tasks = new Map();
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.txt') && !f.endsWith('.json')) continue;
  for (const o of readLooseJson(path.join(dir, f))) {
    if (o && o.id && !tasks.has(o.id)) tasks.set(o.id, o);
  }
}

const recs = [...tasks.values()].filter(o =>
  o.projectId === RECORD_PROJECT && o.startDate && o.dueDate &&
  new Date(o.startDate).getTime() < new Date(CUTOFF).getTime()
);
console.log('dida 时间段记录:', recs.length);

// 2. 读现有数据目录
const cfgPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
  'worklog-assistant', 'config.json');
let dataDir = path.join(process.env.APPDATA || '', 'worklog-assistant', 'Data');
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.storage && cfg.storage.customPath) dataDir = cfg.storage.customPath;
} catch (e) { /* 用默认目录 */ }

const actDir = path.join(dataDir, 'activities');
if (!fs.existsSync(actDir)) fs.mkdirSync(actDir, { recursive: true });

const winDays = new Set();
for (const f of fs.readdirSync(actDir)) {
  winDays.add(path.basename(f).split('.')[0]);
}
const existing = new Map();
for (const f of fs.readdirSync(actDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const d = f.split('.')[0];
  const set = new Set();
  for (const line of fs.readFileSync(path.join(actDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      set.add(`${r.t}|${r.dur}`);
    } catch (e) { /* skip */ }
  }
  existing.set(d, set);
}

// 3. 转成活动记录并按天分桶
const byDay = new Map();
const ymd = (dt) => {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

let skippedDays = 0;
for (const o of recs) {
  const a = new Date(o.startDate);
  const b = new Date(o.dueDate);
  if (!(b > a)) continue;
  if (b - a > 20 * 3600 * 1000) continue;
  const day = ymd(a);
  if (winDays.has(day)) { skippedDays += 1; continue; }

  const { cat, kind } = classify(o.title || '');
  let cur = new Date(a);
  while (cur < b) {
    const nextMidnight = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0, 0);
    const segEnd = nextMidnight < b ? nextMidnight : b;
    const segMs = segEnd - cur;
    if (segMs >= 60000) {
      const d = ymd(cur);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push({
        t: cur.toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        dur: Math.round(segMs),
        kind,
        app: appOf(o.title || ''),
        title: (o.title || '').slice(0, 120),
        platform: 'dida',
        source: 'dida',
        cat
      });
    }
    cur = segEnd;
  }
}

// 4. 写入
let total = 0;
const days = [];
for (const d of [...byDay.keys()].sort()) {
  const seen = existing.get(d) || new Set();
  const rows = byDay.get(d).filter(r => !seen.has(`${r.t}|${r.dur}`));
  if (!rows.length) continue;
  total += rows.length;
  days.push(`${d}(${rows.length})`);
  if (WRITE) {
    fs.appendFileSync(path.join(actDir, `${d}.jsonl`),
      rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
}

const catCount = {};
for (const list of byDay.values()) for (const r of list) catCount[r.cat] = (catCount[r.cat] || 0) + 1;
console.log(`跳过（当天已有窗口录制）: ${skippedDays} 条`);
console.log(`写入天数: ${days.length}  写入条数: ${total}`);
console.log('分类分布:', catCount);
console.log(WRITE ? '已写入' : '仅预览（加 --write 才写盘）');
