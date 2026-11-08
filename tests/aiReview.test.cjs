const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, overlapClues, reviewWindow } = require('../electron/aiReview');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('token estimate is nonzero for Chinese and English prompts', () => {
  assert.ok(estimateTokens('今天处理了三个文档') > 0);
  assert.ok(estimateTokens('chrome window title') > 0);
});

test('overlap clues report simultaneous window evidence without declaring a conflict', () => {
  const activities = [
    { timestamp: '2026-11-08T09:00:00.000Z', durationMs: 30 * 60000,
      source: 'manual', processName: '写报告', windowTitle: '客户报告' },
    { timestamp: '2026-11-08T09:10:00.000Z', durationMs: 15 * 60000,
      source: 'auto', processName: 'chrome', windowTitle: '查资料' }
  ];
  assert.deepEqual(overlapClues(activities).map(c => c.apps), [['chrome']]);
  assert.equal(overlapClues([activities[0]]).length, 0);
});

test('automatic review resumes at the saved cursor and caps very old gaps', () => {
  const now = '2026-11-08T12:00:00.000Z';
  assert.equal(reviewWindow('2026-11-08T11:00:00.000Z', now, 30).start.toISOString(),
    '2026-11-08T11:00:00.000Z');
  assert.equal(reviewWindow('2026-11-08T01:00:00.000Z', now, 30).start.toISOString(),
    '2026-11-08T11:30:00.000Z');
});

test('AI usage prefers provider token counts and persists them locally', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-ai-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let Summarizer;
  try { Summarizer = require('../electron/summarizer'); } finally { Module._load = originalLoad; }
  const summarizer = new Summarizer();
  summarizer._createStorage = () => ({ getDataDir: () => root });
  summarizer._recordUsage('输入', '输出', { prompt_tokens: 42, completion_tokens: 12 });
  assert.deepEqual({ calls: summarizer.getUsageStats().calls,
    input: summarizer.getUsageStats().inputTokens,
    output: summarizer.getUsageStats().outputTokens }, { calls: 1, input: 42, output: 12 });
  assert.equal(summarizer.getUsageStats().estimatedCalls, 0);
});

test('AI review asks for evidence based recording and life suggestions without another model call', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-ai-prompt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return originalLoad.call(this, id, ...args);
  };
  let Summarizer;
  try { Summarizer = require('../electron/summarizer'); } finally { Module._load = originalLoad; }
  const summarizer = new Summarizer();
  summarizer.buildHistoricalContext = () => '2026-11-07：记录 60 分钟；学习 60分钟';
  const prompt = summarizer.buildPrompt([{ timestamp: '2026-11-08T09:00:00.000Z',
    durationMs: 30 * 60000, processName: 'chrome', windowTitle: '阅读资料', source: 'auto' }]);
  assert.match(prompt, /## 记录提示/);
  assert.match(prompt, /## 生活建议/);
  assert.match(prompt, /## 意外发现/);
  assert.match(prompt, /2026-11-07：记录 60 分钟/);
  assert.match(prompt, /不要推断心理健康/);
});
