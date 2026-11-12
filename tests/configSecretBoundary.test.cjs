const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/**
 * 密钥的返回边界与写入语义。
 *
 * 两个事故各对应一半测试：
 *   1. get-config 曾直接返回 getConfig()，渲染层读一次就拿到明文密钥
 *   2. saveConfig 用 `config.api?.apiKey || ''`，前端回传脱敏配置时
 *      会把已有密钥覆盖成空——用户只是改了个主题，密钥没了
 *
 * 第二个尤其值得盯：它的失效方式是静默的，日志里什么都看不出来。
 */

function makeManager(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-secret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 每个用例都要清缓存：模块级 require('electron') 会绑住第一次的路径
  for (const k of Object.keys(require.cache)) {
    if (k.includes('configManager.js')) delete require.cache[k];
  }
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root, on: () => {} } };
    return original.call(this, id, ...args);
  };
  let ConfigManager;
  try {
    ConfigManager = require('../electron/configManager');
  } finally {
    Module._load = original;
  }
  const cm = new ConfigManager();
  cm.config.api = { ...(cm.config.api || {}), apiKey: 'sk-real-key' };
  cm.config.dida = { ...(cm.config.dida || {}), token: 'dida-real-token' };
  return { cm, root };
}

const readLocal = cm => JSON.parse(fs.readFileSync(cm.localConfigPath, 'utf8'));

test('the projection never carries a real secret', t => {
  const { cm } = makeManager(t);
  const safe = cm.getSafeConfig();
  const json = JSON.stringify(safe);
  assert.equal(json.includes('sk-real-key'), false, 'API Key 不得出现在投影里');
  assert.equal(json.includes('dida-real-token'), false, '滴答 Token 不得出现在投影里');
});

test('the projection reports presence with booleans, not empty strings', t => {
  const { cm } = makeManager(t);
  const safe = cm.getSafeConfig();
  assert.equal(safe.api.apiKey, '', '密钥字段应被清空');
  assert.equal(safe.api.hasApiKey, true, '必须告诉前端「已设置」');
  assert.equal(safe.dida.hasDidaToken, true);

  // 空串无法区分「没设过」和「设了但被隐藏」，那正是覆盖事故的来源
  cm.config.api.apiKey = '';
  assert.equal(cm.getSafeConfig().api.hasApiKey, false);
});

test('the projection keeps every other field untouched', t => {
  const { cm } = makeManager(t);
  cm.config.ui = { ...(cm.config.ui || {}), mode: 'light' };
  const safe = cm.getSafeConfig();
  assert.equal(safe.ui.mode, 'light');
  assert.ok(safe.ai, '非敏感字段必须原样返回，否则整个设置页都读不到配置');
});

test('round-tripping the projection does not erase the stored secrets', t => {
  // 这是本文件最重要的一条：前端拿到投影、改个主题、再保存回来。
  const { cm } = makeManager(t);
  cm.saveConfig({ ...cm.getConfig(), api: { apiKey: 'sk-real-key' }, dida: { token: 'dida-real-token' } });

  const safe = cm.getSafeConfig();
  safe.ui = { ...(safe.ui || {}), mode: 'dark' };
  cm.saveConfig(safe);

  const stored = readLocal(cm);
  assert.equal(stored.api.apiKey, 'sk-real-key', '密钥被投影里的空串覆盖了');
  assert.equal(stored.dida.token, 'dida-real-token');
});

test('an absent field means keep, not clear', t => {
  const { cm } = makeManager(t);
  cm.saveConfig({ ...cm.getConfig(), api: { apiKey: 'sk-real-key' }, dida: { token: 'dida-real-token' } });

  const payload = cm.getSafeConfig();
  delete payload.api.apiKey;
  delete payload.dida.token;
  cm.saveConfig(payload);

  const stored = readLocal(cm);
  assert.equal(stored.api.apiKey, 'sk-real-key');
  assert.equal(stored.dida.token, 'dida-real-token');
});

test('a non-empty value replaces the stored secret', t => {
  const { cm } = makeManager(t);
  const payload = cm.getSafeConfig();
  payload.api = { ...payload.api, apiKey: 'sk-new' };
  cm.saveConfig(payload);
  assert.equal(readLocal(cm).api.apiKey, 'sk-new');
});

test('clearing is explicit and does not touch the other secret', t => {
  const { cm } = makeManager(t);
  cm.saveConfig({ ...cm.getConfig(), api: { apiKey: 'sk-real-key' }, dida: { token: 'dida-real-token' } });

  assert.equal(cm.clearApiKey(), true);
  const afterApi = readLocal(cm);
  assert.equal(afterApi.api.apiKey, '', '清除必须真的落盘');
  assert.equal(afterApi.dida.token, 'dida-real-token', '另一个密钥不该被牵连');
  assert.equal(cm.getConfig().api.apiKey, '', '内存里也要清掉，否则本次会话仍在用旧 key');

  assert.equal(cm.clearDidaToken(), true);
  assert.equal(readLocal(cm).dida.token, '');
});

test('clearing survives a later save of the projection', t => {
  // 清除后再保存一次设置，不能把密钥「复活」
  const { cm } = makeManager(t);
  cm.clearApiKey();
  cm.saveConfig(cm.getSafeConfig());
  assert.equal(readLocal(cm).api.apiKey, '');
});

test('the plaintext config file on disk never holds the secrets', t => {
  // config.json 可能被同步/备份，密钥只应存在于 config.local.json
  const { cm } = makeManager(t);
  cm.saveConfig({ ...cm.getConfig(), api: { apiKey: 'sk-real-key' }, dida: { token: 'dida-real-token' } });
  const mainConfig = fs.readFileSync(cm.configPath, 'utf8');
  assert.equal(mainConfig.includes('sk-real-key'), false);
  assert.equal(mainConfig.includes('dida-real-token'), false);
  assert.equal(readLocal(cm).api.apiKey, 'sk-real-key');
});
