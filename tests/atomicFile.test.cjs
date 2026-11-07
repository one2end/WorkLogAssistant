const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../electron/atomicFile');

test('replaces a JSON file without leaving temporary files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'day.json');
  fs.writeFileSync(file, 'old');
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['day.json']);
});
