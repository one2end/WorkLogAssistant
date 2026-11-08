const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('legacy neutral surface moves to the new default theme', () => {
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => '' } };
    return originalLoad.call(this, id, ...args);
  };
  let ConfigManager;
  try { ConfigManager = require('../electron/configManager'); } finally { Module._load = originalLoad; }
  const manager = Object.create(ConfigManager.prototype);
  const migrated = manager.migrateLegacyAppearance({ ui: { mode: 'dark', surface: 'studio' } });
  assert.equal(migrated.ui.surface, 'nocturne');
  assert.equal(manager.createDefaultConfig().ui.surface, 'nocturne');
});
