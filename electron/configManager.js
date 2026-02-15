const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../config.json');
    this.localConfigPath = path.join(__dirname, '../config.local.json');
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      // Load base config
      let baseConfig = this.createDefaultConfig();
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        baseConfig = JSON.parse(configData);
      }

      // Merge with local config (contains API key and user overrides)
      if (fs.existsSync(this.localConfigPath)) {
        const localData = fs.readFileSync(this.localConfigPath, 'utf8');
        const localConfig = JSON.parse(localData);
        return this.mergeDeep(baseConfig, localConfig);
      }

      return baseConfig;
    } catch (error) {
      console.error('加载配置失败:', error);
      return this.createDefaultConfig();
    }
  }

  createDefaultConfig() {
    const defaultConfig = {
      language: 'zh',
      monitoring: {
        interval: 60,
        captureScreenshot: false,
        screenshotInterval: 300
      },
      api: {
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/chat/completions',
        modelName: 'deepseek-chat'
      },
      summary: {
        intervalMinutes: 30,
        lookbackMinutes: 60,
        maxTokens: 500,
        compressActivities: true,
        prompt: ''
      },
      ui: {
        theme: 'dark',
        fontSize: 14,
        showTimestamps: true
      }
    };

    this.saveConfig(defaultConfig);
    return defaultConfig;
  }

  saveConfig(config) {
    try {
      // Save sensitive/user-specific data to local config
      const localConfig = {
        api: {
          apiKey: config.api?.apiKey || ''
        }
      };
      fs.writeFileSync(this.localConfigPath, JSON.stringify(localConfig, null, 2), 'utf8');

      // Save non-sensitive data to main config
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.api) {
        safeConfig.api.apiKey = '';
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