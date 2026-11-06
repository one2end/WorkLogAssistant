/**
 * 重新归类已导入的滴答清单记录（source=dida），不新增、不删除任何记录。
 * 只读取每行、按当前规则重算 cat/kind，然后原文件覆盖写回。
 *
 * 用法：node scripts/reclassify-dida.js [--write]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const WRITE = process.argv.includes('--write');

const WORK_HINTS = ['工作', '上班', '帮扶', '督导', '迁移', '收单', '商户', '业务'];
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
  ['任务与效率', 'active', WORK_HINTS],
  ['AI 助手', 'active', ['用ai', 'ai助手', 'ai帮', '问ai', 'ai整理', 'ai协作', 'ai写', 'gpt']]
];

function classify(title) {
  for (const [cat, kind, keys] of RULES) {
    if (keys.some(k => title.includes(k))) return { cat, kind };
  }
  return { cat: '生活事务', kind: 'active' };
}

function dataDir() {
  const cfgPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
    'worklog-assistant', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.storage && cfg.storage.customPath) return cfg.storage.customPath;
  } catch (e) { /* 默认 */ }
  return path.join(process.env.APPDATA || '', 'worklog-assistant', 'Data');
}

const actDir = path.join(dataDir(), 'activities');
let changed = 0;
let touched = 0;
const before = {};
const after = {};

for (const f of fs.readdirSync(actDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const p = path.join(actDir, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let dirty = false;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { out.push(line); continue; }
    if (r.source === 'dida') {
      before[r.cat] = (before[r.cat] || 0) + 1;
      const { cat, kind } = classify(String(r.title || ''));
      if (r.cat !== cat || r.kind !== kind) { r.cat = cat; r.kind = kind; dirty = true; changed += 1; }
      after[cat] = (after[cat] || 0) + 1;
    }
    out.push(JSON.stringify(r));
  }
  if (dirty) {
    touched += 1;
    if (WRITE) fs.writeFileSync(p, out.join('\n') + '\n', 'utf8');
  }
}

console.log('改动条目:', changed, ' 涉及文件:', touched);
console.log('改前分类:', before);
console.log('改后分类:', after);
console.log(WRITE ? '已写回' : '仅预览');
