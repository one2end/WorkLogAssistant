'use strict';

/**
 * 密钥加密 —— 用 Electron 的 safeStorage 包住 config.local.json 里的两个密钥。
 *
 * 为什么要做：
 *   config.local.json 是明文。任何能读到用户目录的程序（同步客户端、
 *   备份工具、另一个应用、误发出去的日志包）都能直接拿走 API Key 与滴答
 *   Token。这两个值都能直接产生费用或操作别人的清单。
 *
 * 加密值与明文用前缀区分：
 *   "enc:v1:<base64>"  →  密文
 *   其他               →  明文（旧版本留下的，或加密不可用时写的）
 *
 * 前缀不是装饰。没有它，解密失败时无法判断「这是一个坏掉的密文」
 * 还是「这是一段明文」，而两者的处理方式必须不同。
 */

const fs = require('fs');
const path = require('path');

const ENC_PREFIX = 'enc:v1:';

const SECRET_FIELDS = [
  ['api', 'apiKey'],
  ['dida', 'token']
];

/** 值是否已是密文 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * 加密一个明文值。
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function encrypt(safeStorage, plain) {
  if (typeof plain !== 'string' || plain === '') {
    return { ok: true, value: plain || '' };
  }
  if (isEncrypted(plain)) return { ok: true, value: plain };
  try {
    const buf = safeStorage.encryptString(plain);
    return { ok: true, value: ENC_PREFIX + buf.toString('base64') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 解密一个值。明文原样返回（兼容旧配置）。
 *
 * 密文解不开时不返回空串——那会让上层以为「用户没设密钥」，
 * 进而把损坏的密文当成空值覆盖掉，密钥就永久丢了。
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function decrypt(safeStorage, value) {
  if (!isEncrypted(value)) return { ok: true, value: value || '' };
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    return { ok: true, value: safeStorage.decryptString(buf) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 把一份本地配置里的密钥加密后返回（不落盘）。
 *
 * @returns {{ ok: boolean, config?: object, migrated?: number, error?: string }}
 */
function encryptConfig(safeStorage, localConfig) {
  const next = JSON.parse(JSON.stringify(localConfig || {}));
  let migrated = 0;

  for (const [section, field] of SECRET_FIELDS) {
    const raw = next[section] && next[section][field];
    if (!raw || isEncrypted(raw)) continue;
    const r = encrypt(safeStorage, raw);
    if (!r.ok) return { ok: false, error: `加密 ${section}.${field} 失败: ${r.error}` };
    next[section][field] = r.value;
    migrated += 1;
  }

  return { ok: true, config: next, migrated };
}

/**
 * 解密一份本地配置里的密钥，返回明文版本（只在内存里用）。
 */
function decryptConfig(safeStorage, localConfig) {
  const next = JSON.parse(JSON.stringify(localConfig || {}));
  const failures = [];

  for (const [section, field] of SECRET_FIELDS) {
    const raw = next[section] && next[section][field];
    if (!isEncrypted(raw)) continue;
    const r = decrypt(safeStorage, raw);
    if (!r.ok) {
      failures.push({ section, field, error: r.error });
      continue;
    }
    next[section][field] = r.value;
  }

  return { ok: failures.length === 0, config: next, failures };
}

/** 时间戳，用于备份文件名。 */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 执行迁移。五步，任何一步失败都保留原始配置。
 *
 * @param {object} options
 * @param {object} options.safeStorage Electron 的 safeStorage
 * @param {string} options.localConfigPath config.local.json 路径
 * @param {Function} [options.isAvailable] 加密是否可用（默认问 safeStorage）
 * @param {boolean} [options.dryRun] 只检查不落盘（测试用）
 * @returns {{ ok: boolean, status: string, migrated?: number, backup?: string, error?: string }}
 */
function migrate(options) {
  const { safeStorage, localConfigPath } = options;
  const available = typeof options.isAvailable === 'function'
    ? options.isAvailable()
    : (safeStorage && safeStorage.isEncryptionAvailable());

  if (!available) {
    // 降级而不是阻断：某些 Linux 环境没有 keyring，硬要加密会让人
    // 连软件都打不开。保持明文，但要让上层知道这件事发生了。
    return { ok: true, status: 'unavailable', migrated: 0 };
  }

  if (!fs.existsSync(localConfigPath)) {
    return { ok: true, status: 'no-file', migrated: 0 };
  }

  let original;
  try {
    original = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')) || {};
  } catch (error) {
    return { ok: false, status: 'unreadable', error: error.message };
  }

  // --- 步骤 1：备份 ---
  const backupPath = `${localConfigPath}.bak-${stamp()}`;
  try {
    if (!options.dryRun) fs.copyFileSync(localConfigPath, backupPath);
  } catch (error) {
    // 没有备份就无法「失败时保留原始配置」，整个迁移中止
    return { ok: false, status: 'backup-failed', error: error.message };
  }

  // --- 步骤 2：生成临时密文 ---
  const enc = encryptConfig(safeStorage, original);
  if (!enc.ok) return { ok: false, status: 'encrypt-failed', error: enc.error, backup: backupPath };
  if (enc.migrated === 0) {
    return { ok: true, status: 'already-encrypted', migrated: 0, backup: backupPath };
  }

  const tmpPath = `${localConfigPath}.tmp`;
  try {
    if (!options.dryRun) {
      fs.writeFileSync(tmpPath, JSON.stringify(enc.config, null, 2), 'utf8');
    }
  } catch (error) {
    return { ok: false, status: 'write-failed', error: error.message, backup: backupPath };
  }

  // --- 步骤 3：验证临时密文（读回真实文件，与原始明文逐项比对）---
  if (!options.dryRun) {
    try {
      const written = JSON.parse(fs.readFileSync(tmpPath, 'utf8')) || {};
      for (const [section, field] of SECRET_FIELDS) {
        const originalPlain = original[section] && original[section][field];
        if (!originalPlain) continue;
        const writtenVal = written[section] && written[section][field];
        if (!isEncrypted(writtenVal)) {
          fs.unlinkSync(tmpPath);
          return { ok: false, status: 'verify-failed', error: `${section}.${field} 未被加密`, backup: backupPath };
        }
        const back = decrypt(safeStorage, writtenVal);
        if (!back.ok || back.value !== originalPlain) {
          // 只验证内存里的密文，无法发现写入被截断
          fs.unlinkSync(tmpPath);
          return { ok: false, status: 'verify-failed', error: `${section}.${field} 解密结果与原文不符`, backup: backupPath };
        }
      }
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* 清理失败不掩盖原错误 */ }
      return { ok: false, status: 'verify-failed', error: error.message, backup: backupPath };
    }

    // --- 步骤 4：原子替换 ---
    try {
      fs.renameSync(tmpPath, localConfigPath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* 同上 */ }
      return { ok: false, status: 'replace-failed', error: error.message, backup: backupPath };
    }

    // --- 步骤 5：最终验证（从正式文件重新读）---
    try {
      const final = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')) || {};
      for (const [section, field] of SECRET_FIELDS) {
        const originalPlain = original[section] && original[section][field];
        if (!originalPlain) continue;
        const finalVal = final[section] && final[section][field];
        const back = decrypt(safeStorage, finalVal);
        if (!back.ok || back.value !== originalPlain) {
          throw new Error(`${section}.${field} 最终校验失败`);
        }
      }
    } catch (error) {
      // 回滚：从备份恢复，报错退出。备份不删除。
      try { fs.copyFileSync(backupPath, localConfigPath); } catch (_) { /* 恢复失败已在 status 里体现 */ }
      return { ok: false, status: 'final-verify-failed', error: error.message, backup: backupPath };
    }
  }

  return { ok: true, status: 'migrated', migrated: enc.migrated, backup: backupPath };
}

/** 读出磁盘上的本地配置（不解密） */
function readLocalConfig(localConfigPath) {
  if (!fs.existsSync(localConfigPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

module.exports = {
  ENC_PREFIX,
  SECRET_FIELDS,
  isEncrypted,
  encrypt,
  decrypt,
  encryptConfig,
  decryptConfig,
  migrate,
  readLocalConfig,
  localConfigBackupName: p => path.basename(`${p}.bak`)
};
