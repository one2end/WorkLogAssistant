const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRecordTask } = require('../electron/didaSync');

test('Dida title uses category and remark once', () => {
  assert.deepEqual(formatRecordTask({ category: '工作', app: '手工标注', titles: ['工作-下午整理客户材料'] }),
    { title: '工作-下午整理客户材料', overflow: '' });
  assert.deepEqual(formatRecordTask({ category: '学习', app: '手工标注', titles: [] }),
    { title: '学习', overflow: '' });
});

test('Dida long remark keeps title within 30 characters and remainder in description', () => {
  const full = '工作-' + '整理项目材料'.repeat(10);
  const task = formatRecordTask({ category: '工作', app: '手工标注', titles: [full] });
  assert.equal(Array.from(task.title).length, 30);
  assert.equal(task.title + task.overflow, full);
});
