const test = require('node:test');
const assert = require('node:assert/strict');
const { categorySuggestions } = require('../electron/annotationAdvisor');

test('uses repeated consistent manual confirmations for an automatic slot', () => {
  const records = [
    { source: 'manual', processName: 'WPS', category: '文档写作' },
    { source: 'manual', processName: 'wps', category: '文档写作' }
  ];
  const slots = [{ layer: 'auto', app: 'wps', category: '其他', filledMin: 15,
    appPurity: 1, layerPurity: 1, startMin: 540 }];
  assert.deepEqual(categorySuggestions(records, slots).map(x => x.category), ['文档写作']);
});

test('abstains on ambiguous, generic, or already annotated slots', () => {
  const records = [
    { source: 'manual', processName: 'chrome', category: '工作' },
    { source: 'manual', processName: 'chrome', category: '工作' },
    { source: 'manual', processName: 'editor', category: '工作' },
    { source: 'manual', processName: 'editor', category: '生活' }
  ];
  const slots = [
    { layer: 'auto', app: 'chrome', category: '其他', filledMin: 15, startMin: 540 },
    { layer: 'auto', app: 'editor', category: '其他', filledMin: 15, startMin: 555 },
    { layer: 'manual', app: 'editor', category: '其他', filledMin: 15, startMin: 570 }
  ];
  assert.deepEqual(categorySuggestions(records, slots), []);
});

test('does not suggest a category for a mixed slot that would overwrite other work', () => {
  const records = [
    { source: 'manual', processName: 'wps', category: '文档写作' },
    { source: 'manual', processName: 'wps', category: '文档写作' }
  ];
  const slots = [{ layer: 'auto', app: 'wps', category: '其他', filledMin: 15,
    appPurity: 0.6, layerPurity: 1, startMin: 540 },
  { layer: 'auto', app: 'wps', category: '其他', filledMin: 15,
    appPurity: 1, layerPurity: 0.8, startMin: 555 }];
  assert.deepEqual(categorySuggestions(records, slots), []);
});
