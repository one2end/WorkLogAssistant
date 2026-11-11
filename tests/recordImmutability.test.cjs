const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 记录层只读约束。
 *
 * 规范第 4 条：自动采集保留原始时间戳与实际时长，原始记录只读。
 * 这里验证「哪些入口拒绝改记录层」，而不是验证它们改得对不对——
 * 因为正确行为就是一律不改。
 */

function withStorage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-immutable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }
  const storage = new StorageManager();
  const file = path.join(storage.getDataDir(), 'activities', '2026-11-08.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { storage, file };
}

const at = time => new Date(`2026-11-08T${time}:00`).toISOString();

test('updateDisplayRecord refuses to touch a recorded fact', t => {
  const { storage, file } = withStorage(t);
  const fact = { t: at('09:00'), dur: 3600000, app: 'chrome', title: '原始标题' };
  fs.writeFileSync(file, JSON.stringify(fact) + '\n', 'utf8');

  const result = storage.updateDisplayRecord('2026-11-08', fact.t, { title: '改个名' });
  assert.equal(result.success, false);
  assert.match(result.error, /不可修改/);

  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '原始标题', '记录层标题必须保持原样');
  assert.equal(rows[0].dur, 3600000, '记录层时长必须保持原样');
});

test('updateDisplayRecord refuses records written with an explicit recorded source', t => {
  const { storage, file } = withStorage(t);
  const fact = { t: at('10:00'), dur: 1800000, app: 'code', title: '编辑中', source: 'recorded' };
  fs.writeFileSync(file, JSON.stringify(fact) + '\n', 'utf8');

  const result = storage.updateDisplayRecord('2026-11-08', fact.t, { title: '偷偷改' });
  assert.equal(result.success, false);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].title, '编辑中');
});

test('a manual annotation stays editable even at the same timestamp as a fact', t => {
  const { storage, file } = withStorage(t);
  const rows = [
    { t: at('09:00'), dur: 3600000, app: 'chrome', title: '事实' },
    { t: at('09:30'), dur: 1800000, app: '手工标注', title: '旧备注', source: 'manual' }
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n', 'utf8');

  const result = storage.updateDisplayRecord('2026-11-08', at('09:30'), { title: '新备注' });
  assert.equal(result.success, true);

  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after[0].title, '事实', '同文件内的事实不能被连带改掉');
  assert.equal(after[1].title, '新备注');
});

test('layerOf classifies by source without guessing from other fields', () => {
  const Module2 = {
    record: [
      { t: at('09:00'), dur: 1 },
      { t: at('09:00'), dur: 1, source: 'recorded' },
      { t: at('09:00'), dur: 1, source: 'manual' },
      { t: at('09:00'), dur: 1, source: 'dida' },
      { t: at('09:00'), dur: 1, source: 'uptimer' }
    ],
    layer: ['record', 'record', 'display', 'display', 'display']
  };
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => os.tmpdir() } };
    return originalLoad.call(this, id, ...args);
  };
  let StorageManager;
  try { StorageManager = require('../electron/storageManager'); } finally { Module._load = originalLoad; }

  Module2.record.forEach((rec, i) => {
    assert.equal(StorageManager.layerOf(rec), Module2.layer[i], `source=${rec.source}`);
  });
});

test('deleteDisplayRange leaves recorded facts alone', t => {
  const { storage, file } = withStorage(t);
  const rows = [
    { t: at('09:00'), dur: 3600000, app: 'chrome', title: '事实' },
    { t: at('10:00'), dur: 900000, app: '手工标注', source: 'manual' }
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n', 'utf8');

  const result = storage.deleteDisplayRange('2026-11-08', at('09:00'), at('11:00'));
  assert.equal(result.success, true);
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(after.length, 1, '只应删掉展示层那一条');
  assert.equal(after[0].title, '事实');
});
