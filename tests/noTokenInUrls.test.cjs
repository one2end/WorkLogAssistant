const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 长期 Token 不得出现在任何会离开主进程的字符串里。
 *
 * 这一条是审计时发现的：`bridge-status` 返回的 exampleUrls 里带着
 * `?token=<凭据>`，而那个对象是给渲染层的——界面会显示它、允许复制它。
 * 我改过「打开桥接页」的入口，却漏掉了这个状态查询接口。
 *
 * 静态扫描比逐个 review 可靠：token 进入字符串的方式不止一种。
 */

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('main.js never interpolates the bridge token into a url', () => {
  const src = read('electron/main.js');

  // 先把注释整段抹掉再找。注释里写着「以前是 ?token=」是对的，
  // 那是在记录历史，不是代码。逐行剥离处理不了块注释，
  // 会让一条本来正确的代码被判成违规——这种误报会被人直接注释掉断言。
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 里的 //）

  const offenders = [];
  stripped.split('\n').forEach((line) => {
    if (/[?&]token=\$\{/.test(line)) offenders.push(line.trim());
  });

  assert.deepEqual(offenders, [],
    `Token 不得拼进 URL：\n${offenders.join('\n')}`);
});

test('the bridge status handed to the renderer carries no credential', () => {
  const src = read('electron/main.js');
  const start = src.indexOf("ipcMain.handle('get-bridge-status'");
  assert.ok(start >= 0, '应存在 get-bridge-status 处理器');

  // 截到下一个 ipcMain 注册为止，而不是第一个 '});'——
  // 处理器内部有嵌套的对象与调用，第一处 '});' 会截断得太早，
  // 断言看着通过，其实只检查了前几行。
  const rest = src.slice(start);
  const nextHandler = rest.indexOf('ipcMain.handle(', 10);
  const block = nextHandler > 0 ? rest.slice(0, nextHandler) : rest;

  // 同样要剥掉注释：这个处理器在文件靠后的位置，块注释里
  // 可能引用过旧的写法。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.equal(/\$\{status\.token\}/.test(code), false,
    'get-bridge-status 返回给渲染层的对象不应包含 token');
});

test('apiServer only puts the token where an HTTP client reads it', () => {
  // 服务端把 token 放进响应体（兑换接口）是必须的；
  // 但不能把它嵌进 HTML 或示例链接。
  const src = read('electron/apiServer.js');
  const landing = src.slice(src.indexOf('_landingHtml(dataDir)'), src.indexOf('_openApiSpec()'));
  assert.equal(landing.includes('${t}'), false, '落地页不应内嵌 token 变量');
  assert.equal(landing.includes('this.token'), false, '落地页不应引用 token');
});
