const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * iCloud / OneDrive 会在同名文件被别处改过时生成冲突副本，
 * 形如 "2026-11-08 2.jsonl"。只读主文件的话，副本里的记录会凭空消失。
 */

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-icloud-'));
}

test('analytics reads iCloud conflict copies alongside the main file', (t) => {
  const dir = makeDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actDir = path.join(dir, 'activities');
  fs.mkdirSync(actDir, { recursive: true });

  fs.writeFileSync(path.join(actDir, '2026-11-08.jsonl'),
    JSON.stringify({ t: '2026-11-08T01:00:00.000Z', dur: 600000, app: 'main', title: '主文件' }) + '\n');
  fs.writeFileSync(path.join(actDir, '2026-11-08 2.jsonl'),
    JSON.stringify({ t: '2026-11-08T02:00:00.000Z', dur: 600000, app: 'copy', title: '冲突副本' }) + '\n');

  const analytics = require('../electron/analytics');
  const rows = analytics.buildDayReport(dir, '2026-11-08', {});
  const apps = (rows.apps || []).map(a => a.processName || a.app || a.name);

  assert.ok(apps.includes('main'), '主文件的记录应被读到');
  assert.ok(apps.includes('copy'), '冲突副本的记录不应丢失');
});

test('analytics ignores files of other days', (t) => {
  const dir = makeDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actDir = path.join(dir, 'activities');
  fs.mkdirSync(actDir, { recursive: true });

  fs.writeFileSync(path.join(actDir, '2026-11-08.jsonl'),
    JSON.stringify({ t: '2026-11-08T01:00:00.000Z', dur: 600000, app: 'today' }) + '\n');
  fs.writeFileSync(path.join(actDir, '2026-11-09 2.jsonl'),
    JSON.stringify({ t: '2026-11-09T01:00:00.000Z', dur: 600000, app: 'tomorrow' }) + '\n');

  const analytics = require('../electron/analytics');
  const rows = analytics.buildDayReport(dir, '2026-11-08', {});
  const apps = (rows.apps || []).map(a => a.processName || a.app || a.name);

  assert.ok(apps.includes('today'));
  assert.ok(!apps.includes('tomorrow'), '别天的副本不该混进来');
});
