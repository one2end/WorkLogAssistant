const axios = require('axios');
const fs = require('fs');
const path = require('path');

class Summarizer {
  constructor() {
    this.config = null;
    this.loadConfig();
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, '../config.json');
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        this.config = JSON.parse(configData);
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

  getRecentActivities() {
    const StorageManager = require('./storageManager');
    const storage = new StorageManager();
    
    const lookbackMinutes = this.config.summary.lookbackMinutes;
    const cutoffTime = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    
    const allActivities = storage.getAllActivities();
    
    return allActivities.filter(activity => {
      const activityTime = new Date(activity.timestamp);
      return activityTime >= cutoffTime;
    });
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

  async callAI(prompt) {
    try {
      const response = await axios.post(
        this.config.api.baseUrl,
        {
          model: this.config.api.modelName,
          messages: [
            {
              role: 'system',
              content: '你是一个工作日志助手。根据用户的电脑窗口活动记录，推断实际工作内容并生成结构化的 Markdown 摘要。不要简单罗列应用名称，而是根据窗口标题推断用户在做什么。输出简洁实用，像写给自己看的工作笔记。'
            },
            {
              role: 'user',
              content: prompt
            }
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

      if (response.data && response.data.choices && response.data.choices.length > 0) {
        return response.data.choices[0].message.content;
      }
      
      return null;
    } catch (error) {
      console.error('AI API调用失败:', error.response?.data || error.message);
      throw new Error('AI API调用失败: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  saveSummary(summary, activities) {
    const StorageManager = require('./storageManager');
    const storage = new StorageManager();
    
    const summaryData = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
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
    this.config = { ...this.config, ...newConfig };
    
    try {
      const configPath = path.join(__dirname, '../config.json');
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (error) {
      console.error('保存配置失败:', error);
    }
  }
}

module.exports = Summarizer;