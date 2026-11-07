const test = require('node:test');
const assert = require('node:assert/strict');
const { isExcludedSample } = require('../electron/privacyRules');
const ActivityRecorder = require('../electron/activityRecorder');

test('excludes exact app names ignoring case and whitespace', () => {
  assert.equal(isExcludedSample({ processName: 'BankApp.exe', windowTitle: 'Dashboard' }, {
    excludeApps: 'chrome.exe\n bankapp.EXE '
  }), true);
  assert.equal(isExcludedSample({ processName: 'bankapp-helper.exe' }, {
    excludeApps: 'bankapp.exe'
  }), false);
});

test('excludes title fragments and leaves unrelated windows visible', () => {
  const rules = { excludeTitleContains: '客户资料, account number' };
  assert.equal(isExcludedSample({ processName: 'chrome', windowTitle: '张三 - 客户资料' }, rules), true);
  assert.equal(isExcludedSample({ processName: 'chrome', windowTitle: 'Project overview' }, rules), false);
});

test('recorder does not open a segment for an excluded window', async () => {
  const recorder = new ActivityRecorder({
    monitor: { isPersistent: () => true, latest: () => ({ processName: 'bankapp.exe', windowTitle: 'Client' }) },
    storage: { appendActivityRecords: () => { throw new Error('unexpected write'); } },
    getConfig: () => ({ monitoring: { excludeApps: 'bankapp.exe' } })
  });
  recorder.running = true;
  recorder._lastTick = Date.now();
  await recorder._tick();
  assert.equal(recorder._cur, null);
  assert.equal(recorder._buffer.length, 0);
});
