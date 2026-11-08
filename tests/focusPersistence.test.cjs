const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FocusManager = require('../electron/focusManager');

test('local focus shorter than 15 active minutes is not written', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new FocusManager({ arhatManager: { sessionsDir: dir } });
  manager.start('arhat', 'Reading');
  manager.session.startedAt = Date.now() - 14 * 60000;
  const short = manager.end();
  assert.equal(short.saved, false);
  assert.equal(fs.readdirSync(dir).length, 0);

  manager.start('arhat', 'Paused reading');
  manager.session.startedAt = Date.now() - 20 * 60000;
  manager.session.pausedAt = Date.now() - 18 * 60000;
  assert.equal(manager.end().saved, false);
  assert.equal(fs.readdirSync(dir).length, 0);

  manager.start('pomodoro', 'Short work then break');
  manager.session.startedAt = Date.now() - 20 * 60000;
  manager.session.phase = 'break';
  manager.session.phaseStartAt = Date.now() - 7 * 60000;
  assert.equal(manager.end().saved, false);
  assert.equal(fs.readdirSync(dir).length, 0);

  manager.start('arhat', 'Writing');
  manager.session.startedAt = Date.now() - 16 * 60000;
  const saved = manager.end();
  assert.equal(saved.saved, true);
  assert.equal(fs.readdirSync(dir).length, 1);
});
