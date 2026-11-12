const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { writeFileAtomic } = require('./atomicFile');
const { estimateTokens, overlapClues } = require('./aiReview');
const aiEgress = require('./aiEgress');

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

  /**
   * 把记录处理成可以外发的形状。
   *
   * 两步，顺序不能反：
   *   1. 先按隐私规则剔除（剔除依据是应用名与标题，所以必须在这两个字段
   *      被抹掉之前做——反过来的话，规则就永远匹配不上）
   *   2. 再按开关决定哪些字段出现
   *
   * 关闭的字段**根本不出现在对象里**，不是空串占位。
   */
  _prepareForEgress(activities) {
    const monitoring = (this.config && this.config.monitoring) || {};
    const ai = (this.config && this.config.ai) || {};

    const { kept, dropped } = aiEgress.filterForEgress(activities, monitoring);
    if (dropped > 0) {
      // 记下来但只记条数：日志里写具体应用名，等于把过滤掉的东西又写了一遍
      console.log(`AI 出口过滤：剔除 ${dropped} 条`);
    }

    const projected = kept.map(a => aiEgress.projectForEgress(a, {
      sendAppName: ai.sendAppName !== false,
      sendWindowTitle: ai.sendWindowTitle === true
    }));

    return { activities: projected, dropped };
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

    // --- 出口过滤：每一次发送之前都过一遍 ---
    //
    // 录制侧已经过滤过一次，但那管的是「什么被记下来」。
    // 这里管的是「什么被发出去」，是另一个问题：
    //   · 排除规则可能是后加的，历史数据仍在磁盘上
    //   · 导入的数据没经过录制侧过滤
    //   · 配置可能在读取与发送之间被改过
    const egress = this._prepareForEgress(activities);
    if (egress.activities.length === 0) {
      // 全部被过滤掉时不要发一个空请求：那既浪费一次调用，
      // 也让「今天没有可发送的内容」变得难以解释。
      const err = new Error('没有可发送的活动内容（全部被隐私规则过滤）');
      err.code = 'NO_EGRESS_CONTENT';
      throw err;
    }
    activities = egress.activities;

    // 用真实会话时间线作为输入：每段自带时长，模型才能算出时间分配
    let activityText;
    let context = null;
    try {
      const analytics = require('./analytics');
      context = analytics.renderPromptContext(activities, {
        ...(this.config.analysis || {})
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

    const uncertainThreads = (context?.activityThreads || []).filter(item => item.needsConfirmation).slice(0, 5);
    if (uncertainThreads.length) {
      activityText += '\n\n仅以下活动线程需要模型协助判断（其它高可信线程不要重新分类）：\n' +
        uncertainThreads.map(item => {
          const evidence = [...(item.apps || []), ...(item.evidence || [])].slice(0, 4).join(' / ');
          return `- ${new Date(item.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${Math.round(item.durationMs / 60000)}分钟 · 当前${item.group} · 证据 ${evidence || '不足'}`;
        }).join('\n');
    }

    const clues = overlapClues(activities);
    if (clues.length) {
      activityText += '\n\n需要核对的重叠线索（人工标注优先，窗口记录只是同时出现，不代表人工标注错误）：\n' +
        clues.map(c => `- ${c.time} 人工写「${c.manual}」，后台窗口有 ${c.apps.join('、')}`).join('\n');
    }
    const history = this.buildHistoricalContext(activities);
    if (history) activityText += `\n\n近期对照（仅用于发现重复模式，不要把过去事项当作当前发生）：\n${history}`;

    if (customPrompt && customPrompt.trim() !== '') {
      return `${customPrompt}\n\n${activityText}`;
    }

    return `以下是这段时间内的生活记录，含电脑窗口、手工记录和导入的专注。已按连续停留折叠成片段，每行包含时间范围、时长、应用、分类和窗口标题。

${activityText}

请生成一份结构化回顾，要求：
1. 用 "## 今天做了什么" 开头，一到两句话说明这段时间真正推进了什么。判断依据是窗口标题里的具体内容（文档名、页面标题、代码文件），不是应用名。
2. 用 "## 时间去哪了" 按工作线归并（例如「商户收单材料」「代码与工具」「沟通对接」），每条给出耗时和占比，直接引用上面的真实时长。
3. 用 "## 值得注意" 指出有证据的异常；若有人工解释与后台窗口重叠，核对两者是否可能属于同一件事，并列出需用户确认的差异。窗口同时出现不等于人工解释错误。没有足够证据就写「暂无可确认的异常」。
4. 用 "## 分类建议" 只处理上面列出的低可信活动线程，给最多三条需要用户确认的时段，写清时间、建议的七组分类（工作/学习/生活/娱乐/睡眠/专注/其他）、可选项目名及标题证据；没有低可信线程或信息不足就写「暂无建议」，不要重新分类高可信线程，也不要自行改动记录。
5. 用 "## 下一步" 只给一条、具体可执行，基于当前时段没做完或被打断的部分；没有依据就省略。
6. 用 "## 记录提示" 给一条有证据的补记或分类核对建议；可指出人工备注与窗口证据的差异，但不要断言人工备注错误。没有线索就写「暂无」。
7. 用 "## 生活建议" 给一条温和、具体、可选择的休息、兴趣或精神生活建议，联系当前记录与近期对照；不要推断心理健康、诊断或说教。证据不足就写「暂无」。
8. 用 "## 意外发现" 指出一条跨时段重复模式或容易忽略的积极细节；证据不足就写「暂无」。
9. 全部结论必须来自上面的记录，信息不足就直说，不要虚构人名、数字或结论。每节尽量只写一句，整体不超过 450 汉字，像写给自己的笔记。`;
  }

  buildHistoricalContext(activities) {
    if (!activities.length) return '';
    try {
      const storage = this._createStorage();
      const analytics = require('./analytics');
      const anchor = new Date(activities[0].timestamp);
      if (Number.isNaN(anchor.getTime())) return '';
      const lines = [];
      for (let offset = 1; offset <= 3; offset++) {
        const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
        const date = analytics.toDateStr(day);
        const report = analytics.buildDayReport(storage.getDataDir(), date, this.config.analysis || {});
        if (!report.stats?.recordedMs) continue;
        const top = (report.categories || []).slice(0, 3)
          .map(c => `${c.name} ${Math.round(c.durationMs / 60000)}分钟`).join('、');
        lines.push(`${date}：记录 ${Math.round(report.stats.recordedMs / 60000)} 分钟；${top}`);
      }
      return lines.join('\n');
    } catch (_) { return ''; }
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
    return '你是生活记录助手。结合窗口标题、人工记录和已导入的专注，生成有证据的 Markdown 回顾和可选择的建议。不要把窗口活动当成生活全貌，也不要简单罗列应用名。输出简洁具体。';
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

  /**
   * 推理模型（deepseek-flash / reasoner 一类）会先烧 `reasoning_content`，
   * 再产出 `content`。max_tokens 只管输出总量，推理也算在里面——
   * 实测 500 tokens 全被推理吃掉，content 直接是空字符串，
   * finish_reason 是 length。上层看到空内容就返回 null，
   * 前端于是报「没有可总结的记录」，把「模型想不完」说成了「没有记录」。
   *
   * 所以这里按模型类型给预算：推理模型额外留出思考空间，并在被截断时
   * 抛出明确错误，不再静默返回 null。
   */
  _isReasoningModel() {
    const m = String(this.config.api?.modelName || '').toLowerCase();
    return /reason|flash|thinking|o1|o3|o4/.test(m);
  }

  /**
   * 给多少 max_tokens。
   *
   * 推理模型的思考长度和输入长度强相关：一份 2800 字的日记录能想四千多字，
   * 而一句短提问几百字就想完了。所以不能拍死一个数——
   * 按 prompt 规模估预算，让第一次请求就有较大概率成功，
   * 避免「先截断、再翻倍」那种白烧一轮（实测多花 100 秒）。
   */
  _maxTokens(prompt = '') {
    const base = Number(this.config.summary?.maxTokens) || 500;
    if (!this._isReasoningModel()) return base;
    // 经验值：推理量约为输入字数的 1.5 倍（中文 1 字≈1 token 上下），
    // 再留出正文预算和一份安全余量。
    const inputChars = String(prompt).length;
    const estimate = Math.round(inputChars * 1.5) + base + 800;
    return Math.max(base + 2000, Math.min(16000, estimate));
  }

  /**
   * 推理模型的思考长度没法完全预判，所以仍保留一层保险：
   * 万一还是被截断，按实际消耗翻倍重试，最多三次。
   * 只有「截断」才重试——其它错误重试只会重复烧钱。
   */
  async _callOpenAICompatible(prompt) {
    let budget = this._maxTokens(prompt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this._requestOnce(prompt, budget);
      if (result.ok) {
        this._recordUsage(prompt, result.content, result.usage);
        return result.content;
      }
      budget = result.suggestedBudget;
    }
    throw new Error('模型连续三次输出被截断，请减少总结范围或换一个非推理模型');
  }

  async _requestOnce(prompt, budget) {
    const response = await axios.post(
      this.config.api.baseUrl,
      {
        model: this.config.api.modelName,
        messages: [
          { role: 'system', content: this._systemPrompt() },
          { role: 'user', content: prompt }
        ],
        max_tokens: budget,
        temperature: 0.7
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.api.apiKey}`
        },
        timeout: 60000,
        // 本机环境变量带代理时，axios 会把 https 请求以明文发到 443，
        // DeepSeek 官方域名直连可用；其它服务商仍走系统代理。
        ...(/api\.deepseek\.com/i.test(String(this.config.api.baseUrl || '')) ? { proxy: false } : {})
      }
    );
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content;
    if (content && String(content).trim()) {
      return { ok: true, content, usage: response.data.usage };
    }
    // 拿到空正文：要么被 max_tokens 截断（推理吃光预算），要么模型只吐了推理
    const truncated = choice?.finish_reason === 'length';
    if (truncated) {
      // 按已消耗量估下一轮：推理占了多少，正文还得再留一份
      const used = Number(response.data.usage?.completion_tokens) || budget;
      return { ok: false, suggestedBudget: Math.min(16000, Math.max(budget * 2, used + 1500)) };
    }
    throw new Error('模型没有返回正文内容，请重试或更换模型');
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
