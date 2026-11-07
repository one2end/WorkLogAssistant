const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigManager {
  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'config.json');
    this.localConfigPath = path.join(userDataPath, 'config.local.json');
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      // 注意：createDefaultConfig() 必须是纯函数，绝不能在加载时写盘。
      // 历史上它内部调用 saveConfig()，导致每次启动都把用户配置覆写成默认值
      // （customPath / API Key 等全部丢失），表现为「改了设置重启后又变回去」。
      const defaults = this.createDefaultConfig();
      let baseConfig = defaults;

      if (fs.existsSync(this.configPath)) {
        try {
          const configData = fs.readFileSync(this.configPath, 'utf8');
          // 与默认值合并，兼容旧版本配置缺少新增字段的情况
          baseConfig = this.mergeDeep(defaults, this.migrateLegacyModel(this.migrateLegacyAppearance(JSON.parse(configData))));
        } catch (e) {
          console.error('解析 config.json 失败，回退到默认配置:', e);
        }
      } else {
        // 仅首次运行时落盘一份默认配置
        this.saveConfig(defaults);
      }

      // 本地覆盖配置（含 API Key）优先级最高
      if (fs.existsSync(this.localConfigPath)) {
        try {
          const localData = fs.readFileSync(this.localConfigPath, 'utf8');
          const localConfig = this.migrateLegacyAppearance(JSON.parse(localData));
          return this.mergeDeep(baseConfig, localConfig);
        } catch (e) {
          console.error('解析 config.local.json 失败:', e);
        }
      }

      return baseConfig;
    } catch (error) {
      console.error('加载配置失败:', error);
      return this.createDefaultConfig();
    }
  }

  /**
   * 旧版本用 ui.theme 表示整套配色（ocean/forest/rose 会把整个界面染色）。
   * 新模型拆成「明暗模式 + 强调色」两个正交维度，这里做一次性映射：
   *   dark → 暗色/蓝　light → 浅色/蓝　ocean → 暗色/青
   *   forest → 暗色/绿　rose → 暗色/玫红
   * 只在明显是旧配置（有 theme、无 mode）时迁移，不覆盖用户已设置的新字段。
   */
  /** deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用，旧配置自动迁移 */
  migrateLegacyModel(raw) {
    if (!raw || !raw.api) return raw;
    if (raw.api.modelName === 'deepseek-chat' || raw.api.modelName === 'deepseek-reasoner') {
      raw.api.modelName = 'deepseek-flash';
    }
    return raw;
  }

  migrateLegacyAppearance(raw) {
    const MAP = {
      dark: ['dark', 'blue'],
      light: ['light', 'blue'],
      ocean: ['dark', 'teal'],
      forest: ['dark', 'green'],
      rose: ['dark', 'rose']
    };
    if (!raw || typeof raw !== 'object') return raw;
    const ui = raw.ui;
    if (!ui || typeof ui !== 'object' || ui.mode) return raw;
    const mapped = MAP[ui.theme];
    if (!mapped) return raw;
    ui.mode = mapped[0];
    ui.accent = mapped[1];
    return raw;
  }

  createDefaultConfig() {
    const defaultConfig = {
      language: 'zh',
      monitoring: {
        interval: 60,
        idleThresholdSec: 180,
        minSegmentSec: 3,
        excludeApps: '',
        excludeTitleContains: ''
      },
      focus: {
        // 番茄钟是以「插件」形式存在的能力，可整体开关（首页方块上的开关）
        enabled: true,
        pomodoro: { workMin: 25, breakMin: 5, rounds: 4 },
        immersive: { workMin: 15, breakMin: 15, rounds: 0 }
      },
      api: {
        provider: 'deepseek',
        apiKey: '',
        // 2026-07-24 起 deepseek-chat / deepseek-reasoner 已停用。
        // 当前官方推荐 deepseek-flash（V4.1 Flash），深度推理用 deepseek-v4-pro。
        baseUrl: 'https://api.deepseek.com/chat/completions',
        modelName: 'deepseek-flash'
      },
      summary: {
        autoGenerate: false,
        intervalMinutes: 60,
        lookbackMinutes: 60,
        maxTokens: 500,
        compressActivities: true,
        prompt: '',
        schedules: []
      },
      storage: {
        customPath: ''
      },
      bridge: {
        enabled: true,
        port: 47821,
        token: ''
      },
      analysis: {
        categoryRules: null
      },
      // AI 是能力开关，不是一个独立页面：关闭时应用只做本地记录与统计，
      // 数据不出本机；开启后才会自动归类、生成回顾、主动提示。
      ai: {
        enabled: false
      },
      advice: { dismissed: [] },

      // 滴答清单同步插件：拉取与推送是两条完全独立的通道，各有自己的开关和间隔。
      // 拉取把滴答的专注记录喂进展示层第二层级（只读镜像，不写 activities/）。
      // 推送把展示层内容写回滴答：默认且长期保持关闭，只有显式开启 pushEnabled
      // 且填写 pushProjectId 才会执行，避免写乱用户已有的清单。
      // 同步统计（条数、时间、错误）单独存 Data/dida/sync-status.json，不写进配置。
      dida: {
        enabled: false,
        token: '',
        pullFocus: true,
        pushEnabled: false,
        pullIntervalMin: 30,
        pushIntervalMin: 60,
        syncDays: 30,
        autoSyncOnStart: true,
        pushProjectId: ''
      },

      // 首页布局：每个插件一块状态卡；统计类卡片可单独开关，并留自定义项。
      // 插件本身的开关放在各自的配置块里（focus.enabled / ai.enabled /
      // bridge.enabled / dida.enabled），避免出现两个真相来源。
      dashboard: {
        showPluginDock: true,
        cards: {
          heatmap: true,
          composition: true,
          apps: true,
          session: true,
          dataNotes: true,
          focusNotes: true,
          aiInsights: true
        },
        heatmapWeeks: 12
      },
      ui: {
        // 外观 = 明暗模式 × 强调色（theme 字段仅保留用于旧配置迁移）
        mode: 'dark',
        accent: 'blue',
        surface: 'studio',
        fontSize: 14,
        showTimestamps: true,
        floatWindow: true
      }
    };

    return defaultConfig;
  }

  saveConfig(config) {
    try {
      // 保留本地配置里已有的其它覆盖项，只更新 API Key，避免误清空
      let localConfig = {};
      if (fs.existsSync(this.localConfigPath)) {
        try {
          localConfig = JSON.parse(fs.readFileSync(this.localConfigPath, 'utf8')) || {};
        } catch (_) { /* 损坏则重建 */ }
      }
      // 敏感信息只进 config.local.json，不写进 config.json（后者可能被同步/备份）
      localConfig = this.mergeDeep(localConfig, {
        api: { apiKey: config.api?.apiKey || '' },
        dida: { token: config.dida?.token || '' }
      });
      fs.writeFileSync(this.localConfigPath, JSON.stringify(localConfig, null, 2), 'utf8');

      // Save non-sensitive data to main config
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.api) {
        safeConfig.api.apiKey = '';
      }
      if (safeConfig.dida) {
        safeConfig.dida.token = '';
      }
      fs.writeFileSync(this.configPath, JSON.stringify(safeConfig, null, 2), 'utf8');

      this.config = config;
      return true;
    } catch (error) {
      console.error('保存配置失败:', error);
      return false;
    }
  }

  getConfig() {
    return this.config;
  }

  updateConfig(updates) {
    this.config = this.mergeDeep(this.config, updates);
    return this.saveConfig(this.config);
  }

  mergeDeep(target, source) {
    const output = { ...target };
    
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.mergeDeep(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    
    return output;
  }

  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  getMonitoringConfig() {
    return this.config.monitoring;
  }

  getAPIConfig() {
    return this.config.api;
  }

  getSummaryConfig() {
    return this.config.summary;
  }

  getUIConfig() {
    return this.config.ui;
  }

  setLanguage(lang) {
    this.config.language = lang;
    return this.saveConfig(this.config);
  }

  getLanguage() {
    return this.config.language;
  }

  validateConfig(config) {
    const errors = [];
    
    if (!config.api.apiKey || config.api.apiKey.trim() === '') {
      errors.push('API Key 不能为空');
    }
    
    if (config.monitoring.interval < 10) {
      errors.push('监控间隔不能小于10秒');
    }
    
    if (config.summary.lookbackMinutes < 5) {
      errors.push('回溯时间不能小于5分钟');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = ConfigManager;
