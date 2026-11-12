const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * V0.11.0 三个新界面的契约。
 *
 * 这些是静态检查，因为它们要防的是同一类问题：
 * **界面上引用了不存在的通道或方法**。那种错误的症状是「点了没反应」，
 * 在浏览器里不会报错，在测试里也不会——直到有人真的点了一下。
 */

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const registry = require('../electron/ipcRegistry');

/** 找出文件里通过 ipc.invoke 调用的所有通道 */
function channelsUsed(src) {
  return [...src.matchAll(/ipc\.invoke\('([a-z0-9-]+)'/g)].map(m => m[1]);
}

test('every channel the new screens call actually exists in the registry', () => {
  const files = [
    'src/components/DailyReview.vue',
    'src/components/HistorySearch.vue',
    'src/views/ProjectsView.vue'
  ];
  const declared = new Set(Object.keys(registry.allChannels()));
  for (const f of files) {
    for (const ch of channelsUsed(read(f))) {
      assert.ok(declared.has(ch), `${f} 调用了不存在的通道：${ch}`);
    }
  }
});

test('the daily review offers an editor, not a read-only report', () => {
  // 「生成结果可以直接编辑」是硬性要求，不是可选优化
  const src = read('src/components/DailyReview.vue');
  assert.match(src, /<textarea/, '复盘内容必须是可编辑的文本框');
  assert.match(src, /v-model="draft"/);
  assert.match(src, /还原为生成结果/, '改坏了要能退回生成结果');
});

test('a re-generated review does not overwrite edits silently', () => {
  // 用户改过之后点「重新生成」，如果直接覆盖，编辑就白做了
  const src = read('src/components/DailyReview.vue');
  assert.match(src, /if \(!this\.dirty\) this\.draft = this\.generated/,
    '只在用户没有改过时才覆盖草稿');
});

test('the daily review is collapsed by default so the home page stays short', () => {
  const src = read('src/components/DailyReview.vue');
  assert.match(src, /defaultOpen: \{ type: Boolean, default: false \}/,
    '复盘是收尾动作，不该一打开首页就占一大块');
});

test('the AI suggestion is hidden entirely when AI is off', () => {
  // 不是「按钮变灰」，是根本不出现——灰按钮会让人以为哪里没配好
  const src = read('src/components/DailyReview.vue');
  assert.match(src, /v-if="canSuggest"/);
  assert.match(src, /canSuggest\(\) \{ return this\.aiEnabled && this\.aiReady; \}/);
});

test('the daily review shows warnings from the generator', () => {
  // 数据不足时生成器会给 warning，界面必须显示出来
  const src = read('src/components/DailyReview.vue');
  assert.match(src, /review-warnings/);
  assert.match(src, /v-for="\(w, i\) in warnings"/);
});

test('the projects view has all four states', () => {
  const src = read('src/views/ProjectsView.vue');
  assert.match(src, /v-if="loading"/, '缺少加载中');
  assert.match(src, /v-else-if="error"/, '缺少失败状态');
  assert.match(src, /is-empty/, '缺少无数据状态');
});

test('the projects view explains how to fix an empty state', () => {
  // 「没有数据」是结果，不是答案。要告诉人下一步做什么。
  const src = read('src/views/ProjectsView.vue');
  assert.match(src, /项目规则/, '空状态应指向配置入口');
  assert.match(src, /\$emit\('open-project-rules'\)/);
});

test('the projects view warns when time is not assigned to any project', () => {
  const src = read('src/views/ProjectsView.vue');
  assert.match(src, /未归属/, '未归属时长必须单独显示');
  assert.match(src, /report\.unassignedMs > 0/);
});

test('the projects view supports day, week and month without a date picker', () => {
  // 查看项目投入用的是「这周/这月」，不是「从几号到几号」
  const src = read('src/views/ProjectsView.vue');
  assert.match(src, /id: 'day'/);
  assert.match(src, /id: 'week'/);
  assert.match(src, /id: 'month'/);
});

test('search results say why each hit matched', () => {
  // 只列结果不说原因，用户会怀疑是不是搜错了
  const src = read('src/components/HistorySearch.vue');
  assert.match(src, /whyLabel/);
  assert.match(src, /matchedOn/);
});

test('search results can be jumped to from the date and the segment', () => {
  const src = read('src/components/HistorySearch.vue');
  assert.match(src, /\$emit\('jump-date'/);
  assert.match(src, /\$emit\('jump-segment'/);
});

test('search does not fire on every keystroke', () => {
  // 每敲一个字扫一遍全库，输入会明显卡顿
  const src = read('src/components/HistorySearch.vue');
  assert.match(src, /debounceTimer/);
  assert.match(src, /setTimeout\(\(\) => this\.search\(\), \d+\)/);
});

test('the projects screen is reachable from the navigation rail', () => {
  const src = read('src/components/NavRail.vue');
  assert.match(src, /id: 'projects'/, '导航里应有项目入口');
});

test('jumping from search lands on the right date and time', () => {
  const src = read('src/App.vue');
  assert.match(src, /jumpToSegmentFromSearch/);
  assert.match(src, /jumpToDateFromSearch/);
  // 定位复用 timelineTarget，不另造一套机制
  assert.match(src, /minutes: d\.getHours\(\) \* 60 \+ d\.getMinutes\(\)/);
});

test('the settings page exposes a way to scroll to a named section', () => {
  // 项目页的「去配置规则」依赖它；没有它按钮会静默失灵
  const src = read('src/views/SettingsView.vue');
  assert.match(src, /scrollToSection\(id\)/);
});
