const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Provider presets: each defines default baseUrl, model, and request format
const PROVIDER_PRESETS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    modelName: 'deepseek-chat',
    format: 'openai'
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4o-mini',
    format: 'openai'
  },
  claude: {
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    modelName: 'claude-sonnet-4-20250514',
    format: 'claude'
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    modelName: 'gemini-2.0-flash',
    format: 'gemini'
  },
  custom: {
    name: '自定义 (OpenAI兼容)',
    baseUrl: '',
    modelName: '',
    format: 'openai'
  }
};

class Summarizer {
  constructor() {
    this.config = null;
    this.loadConfig();
  }
  loadConfig() {
    try {
      const userDataPath = app.getPath('userData');
      const configPath = path.join(userDataPath, 'config.json');
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        const localConfigPath = path.join(userDataPath, 'config.local.json');
        if (fs.existsSync(localConfigPath)) {
          const localData = fs.readFileSync(localConfigPath, 'utf8');
          const localConfig = JSON.parse(localData);
          if (localConfig.api && localConfig.api.apiKey) {
            config.api = { ...config.api, ...localConfig.api };
          }
        }
        this.config = config;
      } else {
        this.config = this.getDefaultConfig();
      }
    } catch (error) {
      console.error('加载配置失败:', error);
      this.config = this.getDefaultConfig();
    }
  }

  getDefaultConfig() {
    return {
      api: {
        provider: 'deepseek',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/chat/completions',
        modelName: 'deepseek-chat'
      },
      summary: {
        lookbackMinutes: 60,
        maxTokens: 500,
        compressActivities: true,
        prompt: ''
      }
    };
  }

  _getProvider() {
    return this.config.api?.provider || 'deepseek';
  }

  _getFormat() {
    const provider = this._getProvider();
    const preset = PROVIDER_PRESETS[provider];
    return preset ? preset.format : 'openai';
  }

  static getProviderPresets() {
    return PROVIDER_PRESETS;
  }

  _createStorage() {
    const StorageManager = require('./storageManager');
    const customPath = this.config.storage?.customPath || '';
    return new StorageManager(customPath);
  }

  async generateSummary() {
    try {
      const activities = this.getRecentActivities();
      if (activities.length === 0) {
        console.log('没有可用的活动记录');
        return null;
      }
      const prompt = this.buildPrompt(activities);
      const summary = await this.callAI(prompt);
      if (summary) {
        this.saveSummary(summary, activities);
        return summary;
      }
      return null;
    } catch (error) {
      console.error('生成摘要失败:', error);
      throw error;
    }
  }

  async generateSummaryForRange(startTime, endTime) {
    try {
      const storage = this._createStorage();
      const activities = storage.getActivitiesByTimeRange(startTime, endTime);
      if (activities.length === 0) {
        console.log('该时间段没有活动记录');
        return null;
      }
      const prompt = this.buildPrompt(activities);
      const summary = await this.callAI(prompt);
      if (summary) {
        this.saveSummary(summary, activities);
        return summary;
      }
      return null;
    } catch (error) {
      console.error('生成时间段摘要失败:', error);
      throw error;
    }
  }

  async generateSummaryForLookback(lookbackMinutes) {
    try {
      const storage = this._createStorage();
      const cutoffTime = new Date(Date.now() - lookbackMinutes * 60 * 1000);
      const now = new Date();
      const activities = storage.getActivitiesByTimeRange(cutoffTime.toISOString(), now.toISOString());
      if (activities.length === 0) {
        console.log('该时间段没有活动记录');
        return null;
      }
      const prompt = this.buildPrompt(activities);
      const summary = await this.callAI(prompt);
      if (summary) {
        this.saveSummary(summary, activities);
        return summary;
      }
      return null;
    } catch (error) {
      console.error('生成回溯摘要失败:', error);
      throw error;
    }
  }

  getRecentActivities() {
    const storage = this._createStorage();
    const lookbackMinutes = this.config.summary.lookbackMinutes;
    const cutoffTime = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const now = new Date();
    return storage.getActivitiesByTimeRange(cutoffTime.toISOString(), now.toISOString());
  }
  buildPrompt(activities) {
    let customPrompt = this.config.summary.prompt;
    let activityText = '';
    if (this.config.summary.compressActivities) {
      const groupedActivities = this.groupActivities(activities);
      for (const [processName, windows] of Object.entries(groupedActivities)) {
        activityText += `应用: ${processName}\n`;
        activityText += `窗口: ${windows.join(' | ')}\n\n`;
      }
    } else {
      activities.forEach(activity => {
        activityText += `[${new Date(activity.timestamp).toLocaleTimeString('zh-CN')}] `;
        activityText += `${activity.processName} - ${activity.windowTitle}\n`;
      });
    }

    if (customPrompt && customPrompt.trim() !== '') {
      return `${customPrompt}\n\n${activityText}`;
    }

    const timeRange = activities.length > 0
      ? `${new Date(activities[0].timestamp).toLocaleTimeString('zh-CN')} ~ ${new Date(activities[activities.length - 1].timestamp).toLocaleTimeString('zh-CN')}`
      : '';

    return `请根据以下 ${timeRange} 时间段内的电脑使用活动记录，生成一份结构化的工作日志摘要。

要求：
1. 用 "## 工作概览" 开头，一句话总结这段时间的主要工作方向
2. 用 "## 主要工作" 列出具体做了什么（根据窗口标题推断，不要简单罗列应用名）
3. 用 "## 时间分配" 简要说明各类工作的大致时间占比
4. 语言简洁，避免废话，像写给自己看的笔记

活动记录：
${activityText}`;
  }

  groupActivities(activities) {
    const grouped = {};
    activities.forEach(activity => {
      const processName = activity.processName;
      if (!grouped[processName]) {
        grouped[processName] = [];
      }
      if (!grouped[processName].includes(activity.windowTitle)) {
        grouped[processName].push(activity.windowTitle);
      }
    });
    return grouped;
  }

  _systemPrompt() {
    return '你是一个工作日志助手。根据用户的电脑窗口活动记录，推断实际工作内容并生成结构化的 Markdown 摘要。不要简单罗列应用名称，而是根据窗口标题推断用户在做什么。输出简洁实用，像写给自己看的工作笔记。';
  }

  async callAI(prompt) {
    const format = this._getFormat();
    switch (format) {
      case 'claude':
        return this._callClaude(prompt);
      case 'gemini':
        return this._callGemini(prompt);
      default:
        return this._callOpenAICompatible(prompt);
    }
  }

  async _callOpenAICompatible(prompt) {
    try {
      const response = await axios.post(
        this.config.api.baseUrl,
        {
          model: this.config.api.modelName,
          messages: [
            { role: 'system', content: this._systemPrompt() },
            { role: 'user', content: prompt }
          ],
          max_tokens: this.config.summary.maxTokens,
          temperature: 0.7
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.api.apiKey}`
          }
        }
      );
      if (response.data?.choices?.[0]?.message?.content) {
        return response.data.choices[0].message.content;
      }
      return null;
    } catch (error) {
      console.error('OpenAI兼容API调用失败:', error.response?.data || error.message);
      throw new Error('API调用失败: ' + (error.response?.data?.error?.message || error.message));
    }
  }
  async _callClaude(prompt) {
    try {
      const response = await axios.post(
        this.config.api.baseUrl,
        {
          model: this.config.api.modelName,
          max_tokens: this.config.summary.maxTokens,
          system: this._systemPrompt(),
          messages: [
            { role: 'user', content: prompt }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.api.apiKey,
            'anthropic-version': '2023-06-01'
          }
        }
      );
      if (response.data?.content?.[0]?.text) {
        return response.data.content[0].text;
      }
      return null;
    } catch (error) {
      console.error('Claude API调用失败:', error.response?.data || error.message);
      throw new Error('API调用失败: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  async _callGemini(prompt) {
    try {
      const url = this.config.api.baseUrl
        .replace('{model}', this.config.api.modelName)
        + `?key=${this.config.api.apiKey}`;

      const response = await axios.post(
        url,
        {
          system_instruction: {
            parts: [{ text: this._systemPrompt() }]
          },
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            maxOutputTokens: this.config.summary.maxTokens,
            temperature: 0.7
          }
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return response.data.candidates[0].content.parts[0].text;
      }
      return null;
    } catch (error) {
      console.error('Gemini API调用失败:', error.response?.data || error.message);
      throw new Error('API调用失败: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  saveSummary(summary, activities) {
    const storage = this._createStorage();
    const summaryData = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      startTime: activities.length > 0 ? activities[0].timestamp : new Date().toISOString(),
      endTime: activities.length > 0 ? activities[activities.length - 1].timestamp : new Date().toISOString(),
      summary: summary,
      activityCount: activities.length,
      activities: activities.map(a => ({
        processName: a.processName,
        windowTitle: a.windowTitle,
        timestamp: a.timestamp
      }))
    };
    storage.saveSummary(summaryData);
  }

  updateConfig(newConfig) {
    this.config = this.mergeDeep(this.config, newConfig);
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
}

module.exports = Summarizer;
