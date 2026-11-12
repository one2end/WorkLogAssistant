const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 测试编号自检。
 *
 * 规范里 V0.10.2a 有 25 个测试条目（T-M01 ~ T-M25）。如果某条被悄悄删掉，
 * 「全部通过」这句话就失去意义——少测一条也是通过。这里直接扫测试文件里
 * 出现过的编号，缺了就报出来。
 *
 * 同时校验 F / S 两个系列的 11 个中断点是否都在：规范明确要求两套对称，
 * 摘要侧当初就是被漏掉的那一半。
 */

const TEST_DIR = __dirname;

function allTestSources() {
  const out = [];
  for (const name of fs.readdirSync(TEST_DIR)) {
    if (!name.endsWith('.test.cjs')) continue;
    out.push({ name, text: fs.readFileSync(path.join(TEST_DIR, name), 'utf8') });
  }
  return out;
}

test('every V0.10.2a test id T-M01..T-M25 appears in at least one test file', () => {
  const sources = allTestSources();
  const missing = [];
  for (let i = 1; i <= 25; i += 1) {
    const id = `T-M${String(i).padStart(2, '0')}`;
    if (!sources.some(s => s.text.includes(id))) missing.push(id);
  }
  assert.deepEqual(missing, [], `以下条目没有任何测试对应：${missing.join(', ')}`);
});

test('all eleven activity fault points F1..F9 + F4a + F5a are present', () => {
  const text = allTestSources().map(s => s.text).join('\n');
  const points = ['F1', 'F2', 'F3', 'F4', 'F4a', 'F5', 'F5a', 'F6', 'F7', 'F8', 'F9'];
  const missing = points.filter(p => {
    // 用例标题里必须出现「F<n> 空格」这种形态，避免 F4 匹配到 F4a
    const re = new RegExp(`\\b${p}\\s`);
    return !re.test(text);
  });
  assert.deepEqual(missing, [], `活动侧缺失中断点：${missing.join(', ')}`);
  assert.equal(points.length, 11, '规范 §2.10：活动侧必须是 11 个中断点');
});

test('all eleven summaries fault points S1..S9 + S4a + S5a are present', () => {
  const text = allTestSources().map(s => s.text).join('\n');
  const points = ['S1', 'S2', 'S3', 'S4', 'S4a', 'S5', 'S5a', 'S6', 'S7', 'S8', 'S9'];
  const missing = points.filter(p => {
    const re = new RegExp(`\\b${p}\\s`);
    return !re.test(text);
  });
  assert.deepEqual(missing, [], `摘要侧缺失中断点：${missing.join(', ')}`);
  assert.equal(points.length, 11, '规范 §2.10：摘要侧必须与活动侧对称，也是 11 个');
});

test('migration tests never touch a real user data directory', () => {
  const offenders = [];
  for (const s of allTestSources()) {
    if (!/migration|legacy|writeGate/.test(s.name)) continue;
    // getPath('userData') 本身是合法的——测试普遍用它来 mock 并重定向到 tmpdir。
    // 真正要防的是「硬编码真实绝对路径」。
    const hardcoded = /AppData[\\/]|Application Support\/|C:\\\\Users\\\\/i.test(s.text);
    // 同时要求：凡是建了临时目录的，都必须来自 os.tmpdir()
    const usesTmp = /mkdtempSync\(/.test(s.text);
    const importsTmp = /require\(['"]node:os['"]\)|require\(['"]os['"]\)/.test(s.text);
    if (hardcoded) offenders.push(`${s.name}: 含硬编码真实路径`);
    else if (usesTmp && !importsTmp) offenders.push(`${s.name}: 用了 mkdtemp 却没引 os`);
  }
  assert.deepEqual(offenders, [], `这些测试可能碰到真实数据目录：${offenders.join(', ')}`);
});
