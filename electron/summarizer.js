const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { writeFileAtomic } = require('./atomicFile');
const { estimateTokens, overlapClues } = require('./aiReview');

// Provider presets: each defines default baseUrl, model, and request format
const PROVIDER_PRESETS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
  // 2026-07-24 起 deepseek-chat / deepseek-reasoner 已停用
    modelName: 'deepseek-flash',
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
        modelName: 'deepseek-flash'
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

  async generateSummaryForRange(startTime, endTime, options = {}) {
    try {
      const storage = this._createStorage();
      const activities = storage.getActivitiesByTimeRange(startTime, endTime).filter(a => a.kind !== 'idle');
      if (activities.length === 0) {
        console.log('该时间段没有活动记录');
        return null;
      }
      const prompt = this.buildPrompt(activities);
      const summary = await this.callAI(prompt);
      if (summary) {
        const date = new Date(startTime);
        this.saveSummary(summary, activities, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, options.kind);
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
    const customPrompt = this.config.summary.prompt || '';

    // 用真实会话时间线作为输入：每段自带时长，模型才能算出时间分配
    let activityText;
    let context = null;
    try {
      const analytics = require('./analytics');
      context = analytics.renderPromptContext(activities, {
        ignoredApps: this.config.analysis?.ignoredApps
      });
      activityText = context.text || '';
    } catch (error) {
      context = null;
    }

    if (!activityText) {
      // 兜底：退回逐条罗列
      activityText = activities.map(a =>
        `[${new Date(a.timestamp).toLocaleTimeString('zh-CN')}] ${a.processName} - ${a.windowTitle}`
      ).join('\n');
    }

    const clues = overlapClues(activities);
    if (clues.length) {
      activityText += '\n\n需要核对的重叠线索（人工标注优先，窗口记录只是同时出现，不代表人工标注错误）：\n' +
        clues.map(c => `- ${c.time} 人工写「${c.manual}」，后台窗口有 ${c.apps.join('、')}`).join('\n');
    }

    if (customPrompt && customPrompt.trim() !== '') {
      return `${customPrompt}\n\n${activityText}`;
    }

    return `以下是这段时间内电脑前台窗口的使用记录，已按连续停留折叠成片段，每行包含时间范围、时长、应用、分类和窗口标题。

${activityText}

请生成一份结构化回顾，要求：
1. 用 "## 今天做了什么" 开头，一到两句话说明这段时间真正推进了什么。判断依据是窗口标题里的具体内容（文档名、页面标题、代码文件），不是应用名。
2. 用 "## 时间去哪了" 按工作线归并（例如「商户收单材料」「代码与工具」「沟通对接」），每条给出耗时和占比，直接引用上面的真实时长。
3. 用 "## 值得注意" 指出有证据的异常；若有人工解释与后台窗口重叠，核对两者是否可能属于同一件事，并列出需用户确认的差异。窗口同时出现不等于人工解释错误。没有足够证据就写「暂无可确认的异常」。
4. 用 "## 分类建议" 给最多三条需要用户确认的时段，写清时间、建议的七组分类（工作/学习/生活/娱乐/睡眠/专注/其他）及标题证据；信息不足就写「暂无建议」，不要自行改动记录。
5. 用 "## 下一步" 只给一条、具体可执行，基于当前时段没做完或被打断的部分；没有依据就省略。
6. 全部结论必须来自上面的记录，信息不足就直说，不要虚构人名、数字或结论。语言简洁，像写给自己的笔记。`;
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
    // AI 是插件：关闭后任何路径都不得联网调模型（定时摘要、托盘、手动按钮都走这里）
    if (!this.config?.ai?.enabled) {
      throw new Error('AI 能力未启用：请先在插件里开启 AI 能力');
    }
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
          },
          timeout: 30000,
          // 本机环境变量带代理时，axios 会把 https 请求以明文发到 443，
          // DeepSeek 官方域名直连可用；其它服务商仍走系统代理。
          ...(/api\.deepseek\.com/i.test(String(this.config.api.baseUrl || '')) ? { proxy: false } : {})
        }
      );
      if (response.data?.choices?.[0]?.message?.content) {
        this._recordUsage(prompt, response.data.choices[0].message.content, response.data.usage);
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
        this._recordUsage(prompt, response.data.content[0].text, response.data.usage);
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
        this._recordUsage(prompt, response.data.candidates[0].content.parts[0].text, response.data.usageMetadata);
        return response.data.candidates[0].content.parts[0].text;
      }
      return null;
    } catch (error) {
      console.error('Gemini API调用失败:', error.response?.data || error.message);
      throw new Error('API调用失败: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  _usageFile() {
    return path.join(this._createStorage().getDataDir(), 'ai', 'usage.json');
  }

  getUsageStats() {
    try {
      const rows = JSON.parse(fs.readFileSync(this._usageFile(), 'utf8'));
      const recent = Array.isArray(rows) ? rows : [];
      return { calls: recent.length,
        inputTokens: recent.reduce((n, x) => n + x.inputTokens, 0),
        outputTokens: recent.reduce((n, x) => n + x.outputTokens, 0),
        estimatedCalls: recent.filter(x => x.estimated).length,
        recent: recent.slice(-10).reverse() };
    } catch (_) { return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0, recent: [] }; }
  }

  estimateNextReview(minutes = 60) {
    const storage = this._createStorage();
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60000);
    const records = storage.getActivitiesByTimeRange(start.toISOString(), end.toISOString()).filter(a => a.kind !== 'idle');
    return { inputTokens: records.length ? estimateTokens(this._systemPrompt() + this.buildPrompt(records)) : 0,
      outputLimit: this.config.summary.maxTokens || 500, records: records.length };
  }

  _recordUsage(prompt, output, usage) {
    try {
      const file = this._usageFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let rows = [];
      try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first call */ }
      if (!Array.isArray(rows)) rows = [];
      const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount);
      const result = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount);
      rows.push({ at: new Date().toISOString(), provider: this.config.api?.provider,
        model: this.config.api?.modelName,
        inputTokens: Number.isFinite(input) && input > 0 ? input : estimateTokens(this._systemPrompt() + prompt),
        outputTokens: Number.isFinite(result) && result > 0 ? result : estimateTokens(output),
        estimated: !(input > 0 && result > 0) });
      writeFileAtomic(file, JSON.stringify(rows.slice(-500), null, 2));
    } catch (error) { console.error('保存 AI 用量失败:', error); }
  }

  saveSummary(summary, activities, date, kind) {
    const storage = this._createStorage();
    const summaryData = {
      id: Date.now(),
      ...(date ? { date } : {}),
      kind: kind || 'manual',
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
    if (!storage.saveSummary(summaryData)) throw new Error('模型回顾生成成功，但保存到本地失败');
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
