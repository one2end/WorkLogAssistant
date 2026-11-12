const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ArhatManager 只用到 electron 的 app.getPath，而且这里所有的路径都由
// 测试显式传进构造函数。所以把 electron 换成最小桩即可——
// 真实 Electron 运行时只提供同一组接口，这个测试关心的是编辑逻辑，不是运行时。
const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-focus-stub-'));
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => stubRoot } };
  return originalLoad.call(this, id, ...args);
};
let ArhatManager;
try {
  ArhatManager = require('../electron/arhatManager');
} finally {
  Module._load = originalLoad;
}

test('focus and note edits target their own records; imported focus uses a local override', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-focus-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ArhatManager(dir);
  const date = '2026-11-08';
  fs.writeFileSync(path.join(manager.sessionsDir, `${date}.json`), JSON.stringify([
    { id: 'one', focusText: '旧标题', durationMs: 20 * 60000 },
    { id: 'two', focusText: '保持原样', durationMs: 25 * 60000 }
  ]));
  fs.writeFileSync(path.join(manager.notesDir, `${date}.json`), JSON.stringify([
    { id: 1, text: '旧随手记' }, { id: 2, text: '另一条' }
  ]));
  assert.equal(manager.updateSession(date, 'one', { focusText: '新标题', note: '新备注' }).success, true);
  assert.equal(manager.updateNote(date, 1, '新随手记').success, true);
  assert.equal(manager.getSessions(date)[1].focusText, '保持原样');
  assert.equal(manager.getNotes(date)[1].text, '另一条');
  assert.equal(manager.updateImportedFocus(date, 'dida:abc', { focusText: '本地标题', note: '本地备注' }).success, true);
  const overrides = JSON.parse(fs.readFileSync(path.join(manager.overridesDir, `${date}.json`), 'utf8'));
  assert.deepEqual(overrides, [{ id: 'dida:abc', focusText: '本地标题', note: '本地备注' }]);
});
