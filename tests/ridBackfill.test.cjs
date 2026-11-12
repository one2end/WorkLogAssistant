const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * rid 补齐的严格限制（V0.10.3 §4.6，T-R03 / 验收第 4 条）。
 *
 * 规则只有一句：**只给被实际编辑的那一条补 rid，其他记录一个字节都不许变。**
 *
 * 为什么这么严：批量补 rid 是在改写历史。更糟的是，补错的 rid 会把原本
 * 「无法确认是否重复」的记录变成「确认不重复」，于是本该保留成两条的数据
 * 在某个时刻被合并成一条——而这次合并发生在几个星期后的某次读取里，
 * 没人会把那次编辑和这次丢失联系起来。
 */

function setup(t) {
  const writeGate = require('../electron/writeGate');
  writeGate._resetForTests();
  t.after(() => writeGate._resetForTests());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-ridfill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}electron${path.sep}storageManager.js`)) delete require.cache[key];
  }
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try {
    StorageManager = require('../electron/storageManager');
  } finally {
    Module._load = originalLoad;
  }
  const storage = new StorageManager();
  const dir = path.join(storage.getDataDir(), 'activities');
  fs.mkdirSync(dir, { recursive: true });
  return { storage, file: path.join(dir, '2026-11-08.jsonl') };
}

const at = (h, m = 0) => new Date(2026, 10, 8, h, m, 0).toISOString();

/** 造一个有三条历史记录（都无 rid）的文件，返回原始行文本 */
function seedHistory(file) {
  const rows = [
    { t: at(9), dur: 600000, app: 'code', title: '第一段', source: 'manual' },
    { t: at(10), dur: 1200000, app: 'chrome', title: '第二段', source: 'manual' },
    { t: at(11), dur: 300000, app: 'excel', title: '第三段', source: 'manual' }
  ];
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, text, 'utf8');
  return { rows, lines: text.trim().split('\n') };
}

test('T-R03 editing one record gives only that record a rid', t => {
  const { storage, file } = setup(t);
  const { rows } = seedHistory(file);

  const result = storage.updateDisplayRecord('2026-11-08', rows[1].t, { title: '改过的标题' });
  assert.equal(result.success, true);

  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 3);

  assert.ok(after[1].rid, '被编辑的那条必须补上 rid');
  assert.equal(after[0].rid, undefined, '第一条没有被编辑，不得补 rid');
  assert.equal(after[2].rid, undefined, '第三条没有被编辑，不得补 rid');
});

test('T-R03 the other records come back byte for byte identical', t => {
  const { storage, file } = setup(t);
  const { lines } = seedHistory(file);
  const before = fs.readFileSync(file, 'utf8').trim().split('\n');

  storage.updateDisplayRecord('2026-11-08', at(10), { title: '新标题' });

  const after = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(after.length, 3);

  // 第 0 条和第 2 条必须是原样的字符串，连字段顺序都不能变
  assert.equal(after[0], before[0], '第一条记录必须逐字节不变');
  assert.equal(after[2], before[2], '第三条记录必须逐字节不变');
  assert.notEqual(after[1], before[1], '被编辑的那条本来就应该变化');
  assert.deepEqual(lines.length, 3);
});

test('T-R03 only the title changes on the edited record', t => {
  const { storage, file } = setup(t);
  const { rows } = seedHistory(file);

  storage.updateDisplayRecord('2026-11-08', rows[0].t, { title: '改' });

  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const edited = after[0];
  assert.equal(edited.title, '改');
  assert.equal(edited.t, rows[0].t, '时间不变');
  assert.equal(edited.dur, rows[0].dur, '时长不变');
  assert.equal(edited.app, rows[0].app, '应用不变');
  assert.equal(edited.source, rows[0].source, '来源不变');
  assert.ok(edited.editedAt, '应记录编辑时间');
});

test('T-R03 editing a record that already has a rid keeps that rid', t => {
  const { storage, file } = setup(t);
  fs.writeFileSync(file, JSON.stringify({
    t: at(9), dur: 600000, app: 'code', title: '原文', source: 'manual', rid: 'keep-me'
  }) + '\n', 'utf8');

  storage.updateDisplayRecord('2026-11-08', at(9), { title: '改了' });

  const after = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(after.rid, 'keep-me', '已有 rid 不得被替换——换了身份等于换了记录');
  assert.equal(after.title, '改了');
});

test('T-R03 editing repeatedly does not change the rid again', t => {
  const { storage, file } = setup(t);
  fs.writeFileSync(file, JSON.stringify({
    t: at(9), dur: 600000, app: 'code', title: 'v1', source: 'manual'
  }) + '\n', 'utf8');

  storage.updateDisplayRecord('2026-11-08', at(9), { title: 'v2' });
  const first = JSON.parse(fs.readFileSync(file, 'utf8').trim()).rid;

  storage.updateDisplayRecord('2026-11-08', at(9), { title: 'v3' });
  const second = JSON.parse(fs.readFileSync(file, 'utf8').trim()).rid;

  assert.equal(second, first, '多次编辑 rid 必须稳定');
});

test('T-R03 a record-layer entry is still refused and gets no rid', t => {
  const { storage, file } = setup(t);
  const fact = { t: at(9), dur: 600000, app: 'code', title: '自动录制' };
  fs.writeFileSync(file, JSON.stringify(fact) + '\n', 'utf8');

  const before = fs.readFileSync(file, 'utf8');
  const result = storage.updateDisplayRecord('2026-11-08', at(9), { title: '偷偷改' });

  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '被拒绝的编辑不得改动文件');
});

test('T-R03 editing does not touch other files', t => {
  const { storage, file } = setup(t);
  seedHistory(file);
  const other = path.join(path.dirname(file), '2026-11-09.jsonl');
  const otherContent = JSON.stringify({ t: new Date(2026, 10, 9, 9).toISOString(), dur: 1000, app: 'x' }) + '\n';
  fs.writeFileSync(other, otherContent, 'utf8');

  storage.updateDisplayRecord('2026-11-08', at(10), { title: '改' });

  assert.equal(fs.readFileSync(other, 'utf8'), otherContent, '其他日期的文件一个字都不能动');
});

test('T-R03 a malformed line survives an edit untouched', t => {
  const { storage, file } = setup(t);
  const broken = '{"t":"2026-11-08T01:00:00.000Z","dur":1000,"app":"bad"';
  const good = JSON.stringify({ t: at(10), dur: 600000, app: 'code', title: 'ok', source: 'manual' });
  fs.writeFileSync(file, broken + '\n' + good + '\n', 'utf8');

  const result = storage.updateDisplayRecord('2026-11-08', at(10), { title: '改' });
  assert.equal(result.success, true);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines[0], broken, '解析失败的行必须原样保留，不能丢也不能修');
  assert.equal(lines.length, 2);
});

test('T-R03 the record count never changes because of a rid backfill', t => {
  const { storage, file } = setup(t);
  const { rows } = seedHistory(file);

  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  for (const r of rows) {
    storage.updateDisplayRecord('2026-11-08', r.t, { title: '批量改一遍' });
  }
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').length;

  assert.equal(after, before, '编辑不会增加或减少记录数');

  // 三条都被编辑过，所以三条都补了 rid，且互不相同
  const parsed = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const rids = parsed.map(r => r.rid);
  assert.ok(rids.every(Boolean));
  assert.equal(new Set(rids).size, 3, '各自独立的 rid');
});
