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
    if (!ui || typeof ui !== 'object') return raw;
    if (ui.surface === 'studio') ui.surface = 'nocturne';
    const themeAccents = { nocturne: 'blue', linen: 'amber', mist: 'green', aurora: 'violet', ember: 'rose' };
    if (themeAccents[ui.surface]) ui.accent = themeAccents[ui.surface];
    if (ui.mode) return raw;
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
        categoryRules: null,
        customCategories: [],
        categoryMeta: {},
        categoryMerges: {},
        appCategoryMap: {},
        windowCategoryRules: []
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
        pullFocus: false,
        // 《记录》里的生效重复任务只作为计划参考，不进入实际工时。
        pullPlans: false,
        // 留空时自动匹配去掉 emoji 后名称为“记录”的清单。
        planProjectId: '',
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
          plan: true,
          dataNotes: true,
          focusNotes: true,
          aiInsights: true,
          threads: true,
          weeklyReview: true,
          compare: true
        },
        heatmapWeeks: 12
      },
      ui: {
        // 外观 = 明暗模式 × 强调色（theme 字段仅保留用于旧配置迁移）
        mode: 'dark',
        accent: 'blue',
        surface: 'nocturne',
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

      // 密钥按「字段是否存在」判定，不按「值是否为空」。
      // 前端拿到的是脱敏投影（apiKey 恒为空串），它回传时若原样带着空串，
      // 用 || '' 的写法就会把用户已存的密钥抹掉——只是改了个主题，
      // 密钥就没了，而日志里什么都不会留下。
      const nextApiKey = this._resolveSecret(
        config.api ? config.api.apiKey : undefined,
        localConfig.api && localConfig.api.apiKey
      );
      const nextDidaToken = this._resolveSecret(
        config.dida ? config.dida.token : undefined,
        localConfig.dida && localConfig.dida.token
      );

      // 敏感信息只进 config.local.json，不写进 config.json（后者可能被同步/备份）
      localConfig = this.mergeDeep(localConfig, {
        api: { apiKey: nextApiKey },
        dida: { token: nextDidaToken }
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

      // 内存里也同步成真实值：后续调用拿到的 config 必须是完整的，
      // 否则保存完一次设置，AI 就再也读不到 key 了。
      this.config = this.mergeDeep(config, {
        api: { apiKey: nextApiKey },
        dida: { token: nextDidaToken }
      });
      return true;
    } catch (error) {
      console.error('保存配置失败:', error);
      return false;
    }
  }

  getConfig() {
    return this.config;
  }

  /**
   * 给渲染层看的配置投影。
   *
   * 为什么不能直接返回 getConfig()：
   *   那是活的配置对象，api.apiKey 与 dida.token 是明文。
   *   渲染层任何脚本（含将来引入的第三方代码、或页面被注入时）
   *   读一次 get-config 就拿到了密钥。
   *
   *   注意 saveConfig 里把 apiKey 置空的那一段**不解决这个问题**——
   *   它置空的是写进 config.json 的那份副本，与返回给渲染层的对象无关。
   *   这个混淆很容易发生，所以这里单独有一个方法而不是就地改写。
   *
   * 用布尔值而不是空串：空串会让前端无法区分「没设过」和「设了但被隐藏」，
   * 于是在保存设置时把已有密钥覆盖成空。
   */
  getSafeConfig() {
    const safe = JSON.parse(JSON.stringify(this.config || {}));
    const hasApiKey = !!(safe.api && safe.api.apiKey);
    const hasDidaToken = !!(safe.dida && safe.dida.token);

    if (safe.api) safe.api.apiKey = '';
    if (safe.dida) safe.dida.token = '';

    // 布尔位放在各自的对象里，前端拿到的结构不变，只是密钥换成了状态
    safe.api = { ...(safe.api || {}), hasApiKey };
    safe.dida = { ...(safe.dida || {}), hasDidaToken };
    return safe;
  }

  /**
   * 单个密钥的写入语义。
   *
   * 这里有个绕不开的矛盾：前端拿到的是脱敏投影，apiKey 恒为空串。
   * 它回传时带着空串，主进程无法区分「用户没动过这个字段」和
   * 「用户点了清除」——两者长得一模一样。
   *
   * 所以约定是：**空串一律视为「未修改」**，清除必须走显式入口
   * （clearApiKey / clearDidaToken，或带 clear: true 标记）。
   *
   * 为什么把空串当作「未修改」而不是「清除」：
   *   猜错的方向是有代价的。把「未修改」误判成「清除」，用户只是改了个
   *   主题就发现密钥没了，而且没有任何提示；把「清除」误判成「未修改」，
   *   用户点了清除但没生效，再点一次或换个入口即可——后者可恢复，前者不可。
   *
   * 判定依据是「字段是否存在」，不是「值是否为空」：
   *   · 字段不存在 / undefined → 保留现有值
   *   · 非空字符串            → 替换
   *   · 空字符串              → 视为未修改，保留（清除请用显式入口）
   */
  _resolveSecret(incoming, current) {
    if (typeof incoming !== 'string' || incoming === '') return current || '';
    return incoming;
  }

  /**
   * 主动清除密钥。有独立入口，不必依赖「传空串」这种隐晦约定。
   *
   * 注意这里不能只是把值设成空串再走 saveConfig——saveConfig 会把空串
   * 当作「未修改」保留旧值（见 _resolveSecret）。清除必须显式落盘。
   */
  clearApiKey() {
    return this._clearSecret('api', 'apiKey');
  }

  clearDidaToken() {
    return this._clearSecret('dida', 'token');
  }

  _clearSecret(section, field) {
    try {
      let localConfig = {};
      if (fs.existsSync(this.localConfigPath)) {
        try {
          localConfig = JSON.parse(fs.readFileSync(this.localConfigPath, 'utf8')) || {};
        } catch (_) { /* 损坏则重建 */ }
      }
      localConfig[section] = { ...(localConfig[section] || {}), [field]: '' };
      fs.writeFileSync(this.localConfigPath, JSON.stringify(localConfig, null, 2), 'utf8');

      this.config[section] = { ...(this.config[section] || {}), [field]: '' };
      return true;
    } catch (error) {
      console.error('清除密钥失败:', error);
      return false;
    }
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
