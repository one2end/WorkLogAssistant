const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyMissingData } = require('../electron/fileMigration');

test('copies nested focus and sync files without replacing destination data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  fs.mkdirSync(path.join(source, 'arhat', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dida', 'focus'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'arhat', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(source, 'arhat', 'sessions', 'day.json'), 'source');
  fs.writeFileSync(path.join(dest, 'arhat', 'sessions', 'day.json'), 'destination');
  fs.writeFileSync(path.join(source, 'dida', 'focus', 'day.json'), 'focus');
  assert.equal(copyMissingData(source, dest, ['arhat', 'dida']), 1);
  assert.equal(fs.readFileSync(path.join(dest, 'arhat', 'sessions', 'day.json'), 'utf8'), 'destination');
  assert.equal(fs.readFileSync(path.join(dest, 'dida', 'focus', 'day.json'), 'utf8'), 'focus');
});

test('refuses a destination nested in the source data directory', t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-migrate-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  assert.throws(() => copyMissingData(source, path.join(source, 'backup'), ['activities']));
});
