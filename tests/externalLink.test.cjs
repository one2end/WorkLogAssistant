const test = require('node:test');
const assert = require('node:assert/strict');

const externalLink = require('../electron/externalLink');
const corsPolicy = require('../electron/corsPolicy');

/**
 * B2 — 外部链接白名单与桥接 Token 传递。
 *
 * 一条容易写错的规则：不能「只允许 https」。桥接页是
 * http://127.0.0.1:<动态端口>，一刀切会废掉「打开桥接页」。
 * 正确的做法是允许那一个精确地址，其他 http 一律拒绝。
 */

const CTX = { localPort: 52873 };

test('https is allowed anywhere', () => {
  for (const url of [
    'https://example.com',
    'https://example.com/path?q=1',
    'https://github.com/one2end/WorkLogAssistant/releases'
  ]) {
    assert.deepEqual(externalLink.check(url, CTX), { ok: true }, url);
  }
});

test('the bridge address on its actual port is allowed', () => {
  assert.deepEqual(externalLink.check('http://127.0.0.1:52873/', CTX), { ok: true });
  assert.deepEqual(externalLink.check('http://localhost:52873/', CTX), { ok: true });
  assert.deepEqual(externalLink.check('http://127.0.0.1:52873/api/dates', CTX), { ok: true });
});

test('a different loopback port is refused', () => {
  // 这条是关键：不是「本机就行」，而是「只有我们那个端口行」
  for (const port of [52874, 80, 47821, 5173]) {
    const r = externalLink.check(`http://127.0.0.1:${port}/`, CTX);
    assert.equal(r.ok, false, `端口 ${port} 不该被放行`);
    assert.equal(r.reason, 'wrong-port');
  }
});

test('plain http anywhere else is refused', () => {
  for (const url of [
    'http://example.com',
    'http://192.168.1.1/',
    'http://evil-localhost.com/',
    'http://127.0.0.1.evil.com/'
  ]) {
    const r = externalLink.check(url, CTX);
    assert.equal(r.ok, false, url);
  }
});

test('dangerous protocols are refused', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'chrome://settings'
  ]) {
    assert.equal(externalLink.check(url, CTX).ok, false, url);
  }
});

test('a url with embedded credentials is refused', () => {
  // https://user:pass@host 常被用来伪装真实主机
  const r = externalLink.check('https://user:pass@example.com/', CTX);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'credentials');
});

test('garbage in, refusal out — never a throw', () => {
  for (const bad of ['', '   ', 'not a url', null, undefined, 42, {}, []]) {
    const r = externalLink.check(bad, CTX);
    assert.equal(r.ok, false);
  }
});

test('with no bridge running, no http is allowed at all', () => {
  const r = externalLink.check('http://127.0.0.1:52873/', { localPort: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-bridge');
});

// --- 一次性票据 ---

test('a ticket can be redeemed exactly once', () => {
  const store = new externalLink.TicketStore();
  const code = store.issue(52873);
  assert.equal(store.redeem(code, 52873).ok, true);
  const second = store.redeem(code, 52873);
  assert.equal(second.ok, false, '同一张票据不能换第二次');
  assert.equal(second.reason, 'unknown');
});

test('a ticket expires', () => {
  let clock = 1000;
  const store = new externalLink.TicketStore({ ttlMs: 60000, now: () => clock });
  const code = store.issue(52873);
  clock += 60001;
  const r = store.redeem(code, 52873);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('a ticket is bound to the port it was issued for', () => {
  const store = new externalLink.TicketStore();
  const code = store.issue(52873);
  const r = store.redeem(code, 52874);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-port');
  // 用错端口兑换后票据即作废，不能在正确端口重试
  assert.equal(store.redeem(code, 52873).ok, false);
});

test('unknown tickets are refused without revealing whether one existed', () => {
  const store = new externalLink.TicketStore();
  assert.equal(store.redeem('made-up', 52873).reason, 'unknown');
  assert.equal(store.redeem('', 52873).reason, 'missing');
  assert.equal(store.redeem(null, 52873).reason, 'missing');
});

test('tickets are long and unpredictable enough to not be guessable', () => {
  const store = new externalLink.TicketStore();
  const a = store.issue(1);
  const b = store.issue(1);
  assert.notEqual(a, b, '两次签发不能相同');
  assert.ok(a.length >= 32, `票据长度不足：${a.length}`);
});

test('expired tickets are swept so the map does not grow forever', () => {
  let clock = 0;
  const store = new externalLink.TicketStore({ ttlMs: 10, now: () => clock });
  for (let i = 0; i < 20; i += 1) store.issue(52873);
  clock += 100;
  store.issue(52873); // 触发清扫
  assert.ok(store.size <= 1, `过期票据应被清掉，当前 ${store.size}`);
});

// --- CORS ---

test('loopback origins are allowed', () => {
  for (const origin of [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost',
    'http://127.0.0.1:3000'
  ]) {
    assert.equal(corsPolicy.checkOrigin(origin).ok, true, origin);
  }
});

test('lookalike origins that substring matching would let through are refused', () => {
  // 这两条正是「用 includes / startsWith 判断」会误放的情形
  for (const origin of [
    'http://evil-localhost.com',
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'https://localhost:5173'
  ]) {
    assert.equal(corsPolicy.checkOrigin(origin).ok, false, origin);
  }
});

test('null origin and credentials are refused', () => {
  assert.equal(corsPolicy.checkOrigin('null').ok, false);
  assert.equal(corsPolicy.checkOrigin('http://user:pass@127.0.0.1').ok, false);
});

test('an origin with a path is malformed and refused', () => {
  // 浏览器不会发出这种 Origin，出现就说明是伪造的
  assert.equal(corsPolicy.checkOrigin('http://127.0.0.1/path').ok, false);
});

test('no Origin header is not a CORS failure, but is flagged anonymous', () => {
  // curl 不带 Origin。这里不做 CORS 判断——但认证仍然靠 Token，
  // 所以调用方必须把这个 anonymous 标记当作「还需要鉴权」。
  const r = corsPolicy.checkOrigin(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.anonymous, true);
});

test('the wildcard is gone from the response headers', () => {
  const allowed = corsPolicy.headersFor('http://127.0.0.1:5173');
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5173');

  const denied = corsPolicy.headersFor('http://evil.com');
  assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined,
    '不可信来源不应收到 Allow-Origin 头');
});

test('CORS headers keep the token headers working', () => {
  const { headers } = corsPolicy.headersFor('http://localhost:5173');
  assert.match(headers['Access-Control-Allow-Headers'], /Authorization/);
  assert.match(headers['Access-Control-Allow-Headers'], /X-WorkLog-Token/);
});
