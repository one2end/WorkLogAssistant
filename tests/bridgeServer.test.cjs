const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ApiServer } = require('../electron/apiServer');
const { TicketStore } = require('../electron/externalLink');

/**
 * 桥接服务的端到端行为：票据兑换与 CORS 头。
 *
 * 单元测试能验证判定逻辑，验证不了「真的跑起来之后是不是这样」。
 * 这里起一个真实服务，用真实 HTTP 请求打进去。
 */

const TOKEN = 'test-token-0123456789abcdef';

/**
 * 起一个真实服务，跑完用例后关掉。
 *
 * 必须在这里 await stop()，不能挂到 t.after 里了事：
 * t.after 的回调不会被等待，测试体返回后 HTTP 连接可能还在飞，
 * 表现为随机的 ECONNRESET——而且通常只在「下一条用例」上出现，
 * 看起来像是端口被抢，其实是上一条的服务器已经关了。
 */
async function withServer(t, fn) {
  // 给一个真实的空数据目录：/health 与 /api/* 都会先检查它，
  // 返回 null 会让所有接口变成 500，掩盖掉我们真正想验证的东西。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-bridge-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const store = new TicketStore();
  const server = new ApiServer({
    getDataDir: () => dataDir,
    getConfig: () => ({}),
    port: 0,
    token: TOKEN,
    ticketStore: store
  });
  await server.start();
  try {
    return await fn({ server, store, port: server.port });
  } finally {
    await server.stop();
  }
}

function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers)
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a ticket exchanges for the token, exactly once', async t => {
  await withServer(t, async ({ store, port }) => {
    const code = store.issue(port);

    const first = await post(port, '/auth/exchange', { otc: code });
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.token, TOKEN);

    const second = await post(port, '/auth/exchange', { otc: code });
    assert.equal(second.status, 401, '同一张票据不能换第二次');
    assert.equal(second.json.error, 'invalid_ticket');
  });
});

test('a made-up ticket is refused', async t => {
  await withServer(t, async ({ port }) => {
    const r = await post(port, '/auth/exchange', { otc: 'not-a-real-ticket' });
    assert.equal(r.status, 401);
  });
});

test('a ticket issued for another port does not work here', async t => {
  await withServer(t, async ({ store, port }) => {
    const code = store.issue(port + 1);
    const r = await post(port, '/auth/exchange', { otc: code });
    assert.equal(r.status, 401);
  });
});

test('a malformed body is a 400, not a crash', async t => {
  await withServer(t, async ({ port }) => {
    const r = await new Promise((resolve, reject) => {
      const data = '{ not json';
      const req = http.request({
        host: '127.0.0.1', port, path: '/auth/exchange', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, (res) => {
        let buf = '';
        res.on('data', d => { buf += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    assert.equal(r.status, 400);
  });
});

test('the exchange endpoint does not need the data directory', async t => {
  // 兑换只处理票据，与数据无关。这条保证它排在 dataDir 检查之前——
  // 否则数据目录出问题时，连「换个 Token」都做不了。
  const store = new TicketStore();
  const server = new ApiServer({
    getDataDir: () => null,
    getConfig: () => ({}),
    port: 0,
    token: TOKEN,
    ticketStore: store
  });
  await server.start();
  try {
    const code = store.issue(server.port);
    const r = await post(server.port, '/auth/exchange', { otc: code });
    assert.equal(r.status, 200);
  } finally {
    await server.stop();
  }
});

test('a trusted origin gets its own origin echoed back, not a wildcard', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/health', { Origin: 'http://127.0.0.1:5173' });
    assert.equal(r.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  });
});

test('an untrusted origin gets no allow-origin header', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/health', { Origin: 'http://evil-localhost.com' });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });
});

test('a request with no Origin is still served — CORS is not authentication', async t => {
  // curl 就是这个样子。它不看 CORS，所以能拿到 200；
  // 真正的门是后面的 Token 校验。
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/health');
    assert.equal(r.status, 200, '无 Origin 的请求应正常响应');
    assert.equal(r.headers['access-control-allow-origin'], undefined,
      '但也不该回一个通配的 Allow-Origin');
  });
});

test('protected routes still demand the token', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/api/dates');
    assert.equal(r.status, 401, '没有 Token 就该被拒——这才是认证');
  });
});

test('the token works as a bearer header', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/api/dates', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200, '带上正确 Token 应能读到数据');
  });
});

test('a wrong token is refused', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/api/dates', { Authorization: 'Bearer wrong-token-value' });
    assert.equal(r.status, 401);
  });
});

test('the landing page never contains the token', async t => {
  // 以前这个页面把 Token 印在正文里、写进每个示例链接。
  // 截图、浏览器缓存、同步到云端，长期凭据就跟着走了。
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.includes(TOKEN), false,
      '落地页不应包含明文 Token——它该通过 ?otc= 兑换后再显示');
    assert.match(r.body, /auth\/exchange/, '页面应通过兑换端点取 Token');
    assert.match(r.body, /sessionStorage/, 'Token 应只存在会话内');
  });
});

test('the landing page strips the one-time code from the address bar', async t => {
  await withServer(t, async ({ port }) => {
    const r = await get(port, '/', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.body.includes("searchParams.delete('otc')"), true,
      '一次性码用过之后要从地址栏抹掉，否则它仍会留在历史记录里');
  });
});
