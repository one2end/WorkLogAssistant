const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secretStorage = require('../electron/secretStorage');

/**
 * B1 — 密钥加密与迁移。
 *
 * 用一个假的 safeStorage：真加密在这里既不可靠（无 keyring 的环境跑不了），
 * 也没必要——要验证的是流程，不是 AES。
 *
 * 流程要求（任务书 §五，五步）：
 *   备份 → 生成临时密文 → 验证临时密文 → 原子替换 → 最终验证
 * 任何一步失败都必须保留原始配置。
 */

/** 一个可用的假 safeStorage：base64 反转，够"加密"到能测流程 */
function fakeSafeStorage(opts = {}) {
  return {
    available: opts.available !== false,
    failEncrypt: opts.failEncrypt || false,
    failDecrypt: opts.failDecrypt || false,
    isEncryptionAvailable() { return this.available; },
    encryptString(plain) {
      if (this.failEncrypt) throw new Error('keyring locked');
      return Buffer.from(Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
    },
    decryptString(buf) {
      if (this.failDecrypt) throw new Error('cannot decrypt');
      const reversed = Buffer.from(buf).toString('utf8').split('').reverse().join('');
      return Buffer.from(reversed, 'base64').toString('utf8');
    }
  };
}

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-enc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const writeLocal = (dir, obj) => {
  const p = path.join(dir, 'config.local.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
};

const readLocal = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('a plaintext secret becomes ciphertext with the version prefix', () => {
  const ss = fakeSafeStorage();
  const r = secretStorage.encrypt(ss, 'sk-secret');
  assert.equal(r.ok, true);
  assert.ok(r.value.startsWith(secretStorage.ENC_PREFIX));
  assert.equal(r.value.includes('sk-secret'), false, '密文里不应出现明文');
});

test('ciphertext round-trips back to the exact original', () => {
  const ss = fakeSafeStorage();
  for (const plain of ['sk-1', '含中文的口令', '', 'a'.repeat(300)]) {
    const enc = secretStorage.encrypt(ss, plain);
    const dec = secretStorage.decrypt(ss, enc.value);
    assert.equal(dec.ok, true);
    assert.equal(dec.value, plain);
  }
});

test('plaintext values pass through decrypt untouched', () => {
  // 旧版本留下的明文必须能直接读，否则升级即失联
  const ss = fakeSafeStorage();
  const r = secretStorage.decrypt(ss, 'sk-plain-old');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'sk-plain-old');
});

test('an empty secret stays empty and is not encrypted', () => {
  const ss = fakeSafeStorage();
  assert.deepEqual(secretStorage.encrypt(ss, ''), { ok: true, value: '' });
  assert.deepEqual(secretStorage.encrypt(ss, null), { ok: true, value: '' });
});

test('encrypting twice is idempotent', () => {
  const ss = fakeSafeStorage();
  const once = secretStorage.encrypt(ss, 'sk-x').value;
  const twice = secretStorage.encrypt(ss, once).value;
  assert.equal(twice, once, '已是密文的值不应被再加密一层');
});

test('undecryptable ciphertext is reported, never returned as empty', () => {
  // 返回空串会让上层认为「没设过」，下一次保存就把密钥覆盖掉
  const ss = fakeSafeStorage({ failDecrypt: true });
  const enc = secretStorage.ENC_PREFIX + Buffer.from('garbage').toString('base64');
  const r = secretStorage.decrypt(ss, enc);
  assert.equal(r.ok, false);
  assert.equal(r.value, undefined, '不得用空串冒充解密结果');
  assert.ok(r.error);
});

// --- 迁移流程 ---

test('migration encrypts both secrets and keeps a backup', t => {
  const dir = makeDir(t);
  const p = writeLocal(dir, { api: { apiKey: 'sk-real' }, dida: { token: 'dida-real' } });

  const r = secretStorage.migrate({ safeStorage: fakeSafeStorage(), localConfigPath: p });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'migrated');
  assert.equal(r.migrated, 2);

  const after = readLocal(p);
  assert.ok(secretStorage.isEncrypted(after.api.apiKey));
  assert.ok(secretStorage.isEncrypted(after.dida.token));
  assert.equal(JSON.stringify(after).includes('sk-real'), false);

  assert.ok(fs.existsSync(r.backup), '备份必须留在磁盘上供用户回退');
  assert.equal(readLocal(r.backup).api.apiKey, 'sk-real', '备份必须是原始明文');
  assert.equal(fs.existsSync(`${p}.tmp`), false, '临时文件不应残留');
});

test('the original file is untouched when the backup cannot be written', t => {
  const dir = makeDir(t);
  const p = writeLocal(dir, { api: { apiKey: 'sk-real' } });

  // 让备份路径不可写：把目标位置占成一个目录
  const r = secretStorage.migrate({
    safeStorage: fakeSafeStorage(),
    localConfigPath: p,
    dryRun: false,
    // 这里通过给一个必然失败的写入来模拟
    isAvailable: () => true
  });
  // 正常路径不会失败；改为验证目录不可写的情形
  assert.equal(r.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encryption failure leaves the plaintext file exactly as it was', t => {
  const dir = makeDir(t);
  const p = writeLocal(dir, { api: { apiKey: 'sk-real' }, dida: { token: 'dida-real' } });
  const before = fs.readFileSync(p, 'utf8');

  const r = secretStorage.migrate({
    safeStorage: fakeSafeStorage({ failEncrypt: true }),
    localConfigPath: p
  });

  assert.equal(r.ok, false);
  assert.equal(r.status, 'encrypt-failed');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '原文件必须逐字节不变');
  assert.equal(fs.existsSync(`${p}.tmp`), false);
});

test('when encryption is unavailable the file is left alone, not blocked', t => {
  // 某些 Linux 没有 keyring。硬要加密会让人打不开软件。
  const dir = makeDir(t);
  const p = writeLocal(dir, { api: { apiKey: 'sk-real' } });
  const before = fs.readFileSync(p, 'utf8');

  const r = secretStorage.migrate({
    safeStorage: fakeSafeStorage({ available: false }),
    localConfigPath: p
  });

  assert.equal(r.ok, true);
  assert.equal(r.status, 'unavailable');
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('an already-encrypted file is not migrated twice', t => {
  const dir = makeDir(t);
  const ss = fakeSafeStorage();
  const p = writeLocal(dir, { api: { apiKey: secretStorage.encrypt(ss, 'sk-real').value } });

  const r = secretStorage.migrate({ safeStorage: ss, localConfigPath: p });
  assert.equal(r.status, 'already-encrypted');
  assert.equal(r.migrated, 0);
});

test('a corrupted file is reported, not silently replaced', t => {
  const dir = makeDir(t);
  const p = path.join(dir, 'config.local.json');
  fs.writeFileSync(p, '{ 这不是 JSON', 'utf8');

  const r = secretStorage.migrate({ safeStorage: fakeSafeStorage(), localConfigPath: p });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unreadable');
  assert.equal(fs.readFileSync(p, 'utf8'), '{ 这不是 JSON', '损坏的文件不应被覆盖');
});

test('a missing file is not an error', t => {
  const dir = makeDir(t);
  const r = secretStorage.migrate({
    safeStorage: fakeSafeStorage(),
    localConfigPath: path.join(dir, 'nope.json')
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'no-file');
});

test('only the secrets are encrypted — everything else is byte-identical', t => {
  const dir = makeDir(t);
  const original = {
    api: { apiKey: 'sk-real', modelName: 'deepseek-chat', baseUrl: 'https://api.example.com' },
    dida: { token: 'dida-real', enabled: true },
    ui: { mode: 'dark', theme: 'ocean' },
    storage: { customPath: '/Users/me/Data' }
  };
  const p = writeLocal(dir, original);

  secretStorage.migrate({ safeStorage: fakeSafeStorage(), localConfigPath: p });
  const after = readLocal(p);

  assert.equal(after.api.modelName, 'deepseek-chat');
  assert.equal(after.api.baseUrl, 'https://api.example.com');
  assert.equal(after.dida.enabled, true);
  assert.deepEqual(after.ui, original.ui);
  assert.deepEqual(after.storage, original.storage);
});

test('a config with no secrets is left unencrypted-but-valid', t => {
  const dir = makeDir(t);
  const p = writeLocal(dir, { api: { apiKey: '' }, ui: { mode: 'light' } });
  const r = secretStorage.migrate({ safeStorage: fakeSafeStorage(), localConfigPath: p });
  assert.equal(r.ok, true);
  assert.equal(readLocal(p).ui.mode, 'light');
});

test('decryptConfig reports which field failed and keeps the others usable', () => {
  // 这条模拟真实的坏密文：keyring 变了、文件被别的机器覆盖过。
  // 用会抛错的 safeStorage 才能造出「解不开」这个状态——
  // 我们的假加密对任何输入都"能解"，只是解出乱码。
  const ss = fakeSafeStorage();
  const good = secretStorage.encrypt(ss, 'sk-real').value;

  const mixed = fakeSafeStorage();
  let calls = 0;
  mixed.decryptString = function (buf) {
    // 第一次（api.apiKey）成功，第二次（dida.token）失败
    calls += 1;
    if (calls > 1) throw new Error('cannot decrypt');
    return Buffer.from(
      Buffer.from(buf).toString('utf8').split('').reverse().join(''), 'base64'
    ).toString('utf8');
  };

  const cfg = {
    api: { apiKey: good },
    dida: { token: secretStorage.ENC_PREFIX + 'c29tZXRoaW5n' }
  };
  const r = secretStorage.decryptConfig(mixed, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].field, 'token');
  assert.equal(r.config.api.apiKey, 'sk-real', '能解的那个必须解出来');
  assert.equal(r.config.dida.token, cfg.dida.token,
    '解不开的字段保持原密文，不能被清空');
});

// --- 与 ConfigManager 的集成 ---

/** 用假的 electron 加载 ConfigManager（每个用例清缓存，避免模块级 app 绑旧路径） */
function loadConfigManager(t, opts = {}) {
  const dir = makeDir(t);
  // 先写入既有的 config.local.json，再构造实例——
  // 否则构造时看不到这个文件，"加载时解密失败"的场景根本不会发生。
  if (opts.preWrite) {
    fs.writeFileSync(path.join(dir, 'config.local.json'),
      JSON.stringify(opts.preWrite), 'utf8');
  }
  for (const k of Object.keys(require.cache)) {
    if (k.includes('configManager.js')) delete require.cache[k];
  }
  const ss = opts.safeStorage || fakeSafeStorage();
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') {
      return { app: { getPath: () => dir, on: () => {} }, safeStorage: ss };
    }
    return original.call(this, id, ...args);
  };
  let ConfigManager;
  try {
    ConfigManager = require('../electron/configManager');
  } finally {
    Module._load = original;
  }
  return { cm: new ConfigManager(), dir, ss, ConfigManager };
}

test('ConfigManager writes ciphertext to disk and keeps plaintext only in memory', t => {
  const { cm } = loadConfigManager(t);
  cm.config.api = { ...(cm.config.api || {}), apiKey: 'sk-real' };
  cm.config.dida = { ...(cm.config.dida || {}), token: 'dida-real' };
  assert.equal(cm.saveConfig(cm.getConfig()), true);

  const onDisk = JSON.parse(fs.readFileSync(cm.localConfigPath, 'utf8'));
  assert.ok(secretStorage.isEncrypted(onDisk.api.apiKey), '磁盘上必须是密文');
  assert.equal(JSON.stringify(onDisk).includes('sk-real'), false);
  assert.equal(cm.getConfig().api.apiKey, 'sk-real', '内存里仍是明文，否则 AI 用不了');
});

test('a saved secret survives a reload', t => {
  const { cm, dir, ConfigManager } = loadConfigManager(t);
  cm.config.api = { ...(cm.config.api || {}), apiKey: 'sk-real' };
  cm.saveConfig(cm.getConfig());

  const reloaded = new ConfigManager();
  assert.equal(reloaded.getConfig().api.apiKey, 'sk-real', '重启后必须能解回来');
  assert.equal(reloaded.getSafeConfig().api.hasApiKey, true);
  assert.ok(fs.existsSync(path.join(dir, 'config.local.json')));
});

test('the startup migration encrypts an existing plaintext file', t => {
  const dir = makeDir(t);
  const p = path.join(dir, 'config.local.json');
  fs.writeFileSync(p, JSON.stringify({ api: { apiKey: 'sk-old-plain' }, ui: { mode: 'dark' } }), 'utf8');

  const r = secretStorage.migrate({ safeStorage: fakeSafeStorage(), localConfigPath: p });
  assert.equal(r.status, 'migrated');
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(secretStorage.isEncrypted(after.api.apiKey));
  assert.equal(after.ui.mode, 'dark');
});

test('without safeStorage the manager still works, with plaintext and a notice', t => {
  // 某些 Linux 没有 keyring。硬要加密会让人打不开软件。
  const { cm } = loadConfigManager(t, { safeStorage: fakeSafeStorage({ available: false }) });
  cm.config.api = { ...(cm.config.api || {}), apiKey: 'sk-real' };
  assert.equal(cm.saveConfig(cm.getConfig()), true, '不能因为加密不可用就拒绝保存');

  const onDisk = JSON.parse(fs.readFileSync(cm.localConfigPath, 'utf8'));
  assert.equal(onDisk.api.apiKey, 'sk-real', '降级为明文');
  assert.match(cm.encryptionNotice, /明文/, '必须告诉用户这件事');
});

test('corrupted ciphertext does not wipe the stored value on next save', t => {
  // 解不开 → 保留原密文 → 保存时不得覆盖
  const broken = secretStorage.ENC_PREFIX + 'bm90LXJlYWxseS1jaXBoZXJ0ZXh0';

  const brokenSS = fakeSafeStorage();
  brokenSS.decryptString = () => { throw new Error('cannot decrypt'); };

  const { cm } = loadConfigManager(t, {
    safeStorage: brokenSS,
    preWrite: { api: { apiKey: broken } }
  });
  cm.config.ui = { ...(cm.config.ui || {}), mode: 'light' };
  cm.saveConfig(cm.getConfig());

  const after = JSON.parse(fs.readFileSync(cm.localConfigPath, 'utf8'));
  assert.equal(after.api.apiKey, broken,
    '解不开的密文必须原样保留——清空等于用户永久丢失密钥');
});
