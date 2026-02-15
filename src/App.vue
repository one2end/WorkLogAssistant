<template>
  <div id="app" :class="theme">
    <div class="container">
      <div v-if="toastMessage" class="toast" :class="toastType" @click="toastMessage = ''">
        {{ toastMessage }}
      </div>
      <div class="title-bar">
        <div class="title-bar-drag">
          <span class="app-icon">⏱</span>
          <span class="app-title">WorkLog Assistant</span>
        </div>
        <div class="title-bar-controls">
          <button @click="minimizeWindow" class="win-btn" title="最小化">
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button @click="closeWindow" class="win-btn win-btn-close" title="关闭">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
      </div>

      <header class="header">
        <div class="header-left">
          <button @click="toggleMonitoring" :class="['monitor-btn', isMonitoring ? 'active' : '']">
            <span class="monitor-dot" :class="{ pulse: isMonitoring }"></span>
            {{ isMonitoring ? '记录中' : '已暂停' }}
          </button>
          <div class="date-picker">
            <button @click="changeDate(-1)" class="date-nav-btn">‹</button>
            <div class="date-input-wrapper">
              <button class="date-display-btn" @click="showCalendar = !showCalendar">
                {{ formatDateDisplay(selectedDate) }}
              </button>
              <div v-if="showCalendar" class="calendar-popup" @mousedown.stop>
                <div class="calendar-header">
                  <button @click="changeCalendarMonth(-1)" class="cal-nav-btn">‹</button>
                  <span class="cal-title">{{ calendarYear }}年{{ calendarMonth + 1 }}月</span>
                  <button @click="changeCalendarMonth(1)" class="cal-nav-btn">›</button>
                </div>
                <div class="calendar-weekdays">
                  <span v-for="d in ['日','一','二','三','四','五','六']" :key="d">{{ d }}</span>
                </div>
                <div class="calendar-days">
                  <button
                    v-for="day in calendarDays"
                    :key="day.key"
                    class="cal-day"
                    :class="{
                      'other-month': !day.currentMonth,
                      'is-today': day.isToday,
                      'is-selected': day.dateStr === selectedDate,
                      'has-data': datesWithData.has(day.dateStr),
                      'is-future': day.isFuture
                    }"
                    :disabled="day.isFuture"
                    @click="selectCalendarDate(day)"
                  >
                    {{ day.day }}
                  </button>
                </div>
              </div>
            </div>
            <button @click="changeDate(1)" class="date-nav-btn" :disabled="isToday">›</button>
            <button v-if="!isToday" @click="goToToday" class="today-btn">今天</button>
          </div>
        </div>
        <div class="header-right">
          <button @click="exportData" class="icon-btn" title="导出数据">
            📥
          </button>
          <button @click="activeTab = 'settings'" class="icon-btn" title="设置">
            ⚙️
          </button>
        </div>
      </header>

      <main class="main-content">
        <div v-if="activeTab !== 'settings'" class="stats-section">
          <div class="stat-card">
            <div class="stat-value">{{ statistics.totalActivities }}</div>
            <div class="stat-label">{{ isToday ? '今日活动' : '当日活动' }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ statistics.uniqueApplications }}</div>
            <div class="stat-label">应用数量</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ statistics.mostUsedApplication?.name || '-' }}</div>
            <div class="stat-label">最常用应用</div>
          </div>
        </div>

        <div v-if="activeTab !== 'settings'" class="charts-section">
          <div class="chart-card">
            <div class="chart-header">
              <h3>应用使用时长</h3>
              <span class="chart-badge">{{ Object.keys(appDurationStats).length }} 个应用</span>
            </div>
            <div class="chart-content">
              <div v-for="(duration, app, index) in appDurationStats" :key="app" class="app-bar">
                <div class="app-rank">{{ index + 1 }}</div>
                <div class="app-name" :title="app">{{ app }}</div>
                <div class="app-bar-container">
                  <div class="app-bar-fill duration-fill" :style="{ width: getDurationBarWidth(duration) + '%' }"></div>
                </div>
                <div class="app-count">{{ formatDuration(duration) }}</div>
              </div>
              <div v-if="Object.keys(appDurationStats).length === 0" class="empty-state">
                <p>暂无数据</p>
              </div>
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <h3>子活动次数排名</h3>
              <span class="chart-badge">Top {{ Object.keys(subActivityStats).length }}</span>
            </div>
            <div class="chart-content">
              <div v-for="(count, title, index) in subActivityStats" :key="title" class="app-bar">
                <div class="app-rank">{{ index + 1 }}</div>
                <div class="app-name" :title="title">{{ title }}</div>
                <div class="app-bar-container">
                  <div class="app-bar-fill" :style="{ width: getBarWidth(count) + '%' }"></div>
                </div>
                <div class="app-count">{{ count }}</div>
              </div>
              <div v-if="Object.keys(subActivityStats).length === 0" class="empty-state">
                <p>暂无数据</p>
              </div>
            </div>
          </div>
        </div>

        <div v-if="activeTab !== 'settings'" class="tab-card">
          <div class="tabs">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              :class="['tab-btn', { active: activeTab === tab.id }]"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

        <div class="tab-content">
          <div v-if="activeTab === 'activities'" class="activities-list">
            <div v-if="activities.length === 0" class="empty-state">
              <p>暂无活动记录</p>
            </div>
            <div v-else class="activity-items">
              <div 
                v-for="activity in activities" 
                :key="activity.id" 
                class="activity-item"
              >
                <div class="activity-time">
                  {{ formatTime(activity.timestamp) }}
                </div>
                <div class="activity-details">
                  <div class="activity-process">{{ activity.processName }}</div>
                  <div class="activity-window">{{ activity.windowTitle }}</div>
                </div>
                <div v-if="activity.screenshot" class="activity-screenshot">
                  <button @click="viewScreenshot(activity.screenshot)" class="screenshot-btn" title="查看截图">
                    📷
                  </button>
                  <button @click="viewOCR(activity)" class="screenshot-btn" title="查看OCR">
                    📝
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="activeTab === 'summaries'" class="summaries-list">
            <div class="summary-actions">
              <button @click="generateSummary" class="action-btn" :disabled="isGeneratingSummary">
                {{ isGeneratingSummary ? '生成中...' : '生成摘要' }}
              </button>
            </div>
            <div v-if="summaries.length === 0" class="empty-state">
              <p>暂无摘要记录</p>
            </div>
            <div v-else class="summary-items">
              <div
                v-for="summary in summaries"
                :key="summary.id"
                class="summary-item"
              >
                <div class="summary-header">
                  <div class="summary-meta">
                    <span class="summary-time">{{ formatDateTime(summary.timestamp) }}</span>
                    <span class="summary-divider">·</span>
                    <span class="summary-count">{{ summary.activityCount }} 个活动</span>
                  </div>
                </div>
                <div class="summary-content" v-html="renderMarkdown(summary.summary)"></div>
              </div>
            </div>
          </div>

          <div v-if="activeTab === 'logs'" class="logs-panel">
            <div class="log-controls">
              <button @click="clearLogs" class="icon-btn small" title="清除日志">🗑️</button>
              <button @click="openLogsFolder" class="icon-btn small" title="打开日志文件夹">📁</button>
            </div>
            <div class="log-content-full" ref="logContent">
              <div v-for="(log, index) in logs" :key="index" class="log-entry" :class="log.type">
                <span class="log-time">{{ log.time }}</span>
                <span class="log-message">{{ log.message }}</span>
              </div>
            </div>
          </div>
        </div>
        </div>

        <div v-if="activeTab === 'settings'" class="settings-panel-full">
            <div class="settings-header">
              <button @click="activeTab = 'activities'" class="back-btn">
                ← 返回
              </button>
              <h2>设置</h2>
            </div>
            <div class="settings-group">
              <h3>记录设置</h3>
              <div class="setting-item">
                <label>记录间隔 (秒)</label>
                <input 
                  v-model.number="config.monitoring.interval" 
                  type="number" 
                  min="10"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>启用截图</label>
                <input 
                  v-model="config.monitoring.captureScreenshot" 
                  type="checkbox"
                  @change="saveConfig"
                >
              </div>
              <div v-if="config.monitoring.captureScreenshot" class="setting-item">
                <label>截图间隔 (秒)</label>
                <input 
                  v-model.number="config.monitoring.screenshotInterval" 
                  type="number" 
                  min="60"
                  @change="saveConfig"
                >
              </div>
            </div>

            <div class="settings-group">
              <h3>API 设置</h3>
              <div class="setting-item">
                <label>API Key</label>
                <input 
                  v-model="config.api.apiKey" 
                  type="password"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>Base URL</label>
                <input 
                  v-model="config.api.baseUrl" 
                  type="text"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>模型名称</label>
                <input 
                  v-model="config.api.modelName" 
                  type="text"
                  @change="saveConfig"
                >
              </div>
            </div>

            <div class="settings-group">
              <h3>摘要设置</h3>
              <div class="setting-item">
                <label>回溯时间 (分钟)</label>
                <input 
                  v-model.number="config.summary.lookbackMinutes" 
                  type="number" 
                  min="5"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>最大令牌数</label>
                <input 
                  v-model.number="config.summary.maxTokens" 
                  type="number" 
                  min="100"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>压缩活动</label>
                <input 
                  v-model="config.summary.compressActivities" 
                  type="checkbox"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>AI提示词</label>
                <textarea
                  v-model="config.summary.prompt"
                  @change="saveConfig"
                  placeholder="自定义AI提示词，留空使用默认提示词"
                  rows="4"
                ></textarea>
              </div>
            </div>

            <div class="settings-group">
              <h3>通用</h3>
              <div class="setting-item">
                <label>开机自启动</label>
                <input
                  v-model="autoLaunch"
                  type="checkbox"
                  @change="toggleAutoLaunch"
                >
              </div>
              <div class="setting-item">
                <label>最小化浮窗</label>
                <input
                  v-model="config.ui.floatWindow"
                  type="checkbox"
                  @change="saveConfig"
                >
              </div>
              <div class="setting-item">
                <label>主题</label>
                <select v-model="theme" @change="onThemeChange" class="select-input">
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                  <option value="ocean">海洋</option>
                  <option value="forest">森林</option>
                  <option value="rose">玫瑰</option>
                </select>
              </div>
            </div>

            <div class="settings-group about-section">
              <h3>关于</h3>
              <div class="about-info">
                <p>WorkLog Assistant <span class="version">v{{ appVersion }}</span></p>
                <p class="about-desc">自动追踪工作活动，AI 生成工作日志</p>
                <div class="update-section">
                  <button @click="checkForUpdates" class="action-btn" :disabled="checkingUpdate">
                    {{ checkingUpdate ? '检查中...' : '检查更新' }}
                  </button>
                  <div v-if="updateInfo" class="update-result">
                    <template v-if="updateInfo.error">
                      <span class="update-error">检查失败: {{ updateInfo.error }}</span>
                    </template>
                    <template v-else-if="updateInfo.hasUpdate">
                      <span class="update-available">发现新版本 v{{ updateInfo.latestVersion }}</span>
                      <button @click="openDownloadLink" class="action-btn">前往下载</button>
                    </template>
                    <template v-else>
                      <span class="update-latest">已是最新版本</span>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
      </main>
    </div>
  </div>
</template>

<script>
const { ipcRenderer, shell } = require('electron');
const { marked } = require('marked');

export default {
  name: 'App',
  data() {
    return {
      activeTab: 'activities',
      tabs: [
        { id: 'activities', label: '活动记录' },
        { id: 'summaries', label: '摘要' },
        { id: 'logs', label: '日志' }
      ],
      isMonitoring: false,
      activities: [],
      summaries: [],
      statistics: {
        totalActivities: 0,
        uniqueApplications: 0,
        mostUsedApplication: null
      },
      appUsageStats: {},
      subActivityStats: {},
      appDurationStats: {},
      config: {
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
          lookbackMinutes: 60,
          maxTokens: 500,
          compressActivities: true
        }
      },
      logs: [],
      theme: 'dark',
      isGeneratingSummary: false,
      selectedDate: new Date().toISOString().split('T')[0],
      autoLaunch: false,
      appVersion: '',
      updateInfo: null,
      checkingUpdate: false,
      datesWithData: new Set(),
      showCalendar: false,
      calendarYear: new Date().getFullYear(),
      calendarMonth: new Date().getMonth(),
      toastMessage: '',
      toastType: 'error',
      toastTimer: null
    };
  },
  computed: {
    isToday() {
      return this.selectedDate === new Date().toISOString().split('T')[0];
    },
    calendarDays() {
      const year = this.calendarYear;
      const month = this.calendarMonth;
      const firstDay = new Date(year, month, 1);
      const startDow = firstDay.getDay();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];
      const days = [];

      // Previous month padding
      const prevMonthEnd = new Date(year, month, 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        const d = prevMonthEnd - i;
        const dt = new Date(year, month - 1, d);
        const dateStr = dt.toISOString().split('T')[0];
        days.push({ day: d, dateStr, currentMonth: false, isToday: dateStr === todayStr, isFuture: dt > today, key: 'p' + d });
      }

      // Current month
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        const dateStr = dt.toISOString().split('T')[0];
        days.push({ day: d, dateStr, currentMonth: true, isToday: dateStr === todayStr, isFuture: dt > today, key: 'c' + d });
      }

      // Next month padding
      const remaining = 42 - days.length;
      for (let d = 1; d <= remaining; d++) {
        const dt = new Date(year, month + 1, d);
        const dateStr = dt.toISOString().split('T')[0];
        days.push({ day: d, dateStr, currentMonth: false, isToday: dateStr === todayStr, isFuture: dt > today, key: 'n' + d });
      }

      return days;
    }
  },
  async mounted() {
    await this.loadConfig();
    await this.loadActivities();
    await this.loadSummaries();
    await this.loadLogs();
    await this.checkMonitoringStatus();
    await this.loadDatesWithData();
    this.setupEventListeners();
    this.appVersion = await ipcRenderer.invoke('get-app-version');
    document.addEventListener('mousedown', this.closeCalendar);
    this.addLog('应用已启动');
  },
  beforeUnmount() {
    document.removeEventListener('mousedown', this.closeCalendar);
  },
  methods: {
    async loadConfig() {
      try {
        this.config = await ipcRenderer.invoke('get-config');
        this.theme = this.config.ui?.theme || 'dark';
        if (this.config.ui) {
          this.config.ui.floatWindow = this.config.ui.floatWindow !== false;
        }
        this.autoLaunch = await ipcRenderer.invoke('get-auto-launch');
      } catch (error) {
        console.error('加载配置失败:', error);
      }
    },
    async saveConfig() {
      try {
        const configToSave = {
          language: this.config.language || 'zh',
          monitoring: {
            interval: parseInt(this.config.monitoring?.interval) || 60,
            captureScreenshot: Boolean(this.config.monitoring?.captureScreenshot) || false,
            screenshotInterval: parseInt(this.config.monitoring?.screenshotInterval) || 300
          },
          api: {
            apiKey: String(this.config.api?.apiKey || ''),
            baseUrl: String(this.config.api?.baseUrl || 'https://api.deepseek.com/chat/completions'),
            modelName: String(this.config.api?.modelName || 'deepseek-chat')
          },
          summary: {
            intervalMinutes: parseInt(this.config.summary?.intervalMinutes) || 30,
            lookbackMinutes: parseInt(this.config.summary?.lookbackMinutes) || 60,
            maxTokens: parseInt(this.config.summary?.maxTokens) || 500,
            compressActivities: Boolean(this.config.summary?.compressActivities) || true,
            prompt: String(this.config.summary?.prompt || '')
          },
          ui: {
            theme: String(this.config.ui?.theme || 'dark'),
            fontSize: parseInt(this.config.ui?.fontSize) || 14,
            showTimestamps: Boolean(this.config.ui?.showTimestamps) || true,
            floatWindow: this.config.ui?.floatWindow !== false
          }
        };
        
        await ipcRenderer.invoke('save-config', configToSave);
        this.addLog('配置已保存');
      } catch (error) {
        console.error('保存配置失败:', error);
        this.addLog('保存配置失败: ' + error.message);
      }
    },
    async loadActivities() {
      try {
        const allActivities = await ipcRenderer.invoke('get-activities', this.selectedDate);
        this.activities = [...allActivities].reverse();
        this.updateStatistics();
        this.updateCharts();
      } catch (error) {
        console.error('加载活动失败:', error);
      }
    },
    async loadDatesWithData() {
      try {
        const dates = await ipcRenderer.invoke('get-dates-with-data');
        this.datesWithData = new Set(dates);
      } catch (error) {
        console.error('加载日期数据失败:', error);
      }
    },
    async loadSummaries() {
      try {
        this.summaries = await ipcRenderer.invoke('get-summaries', this.selectedDate);
        this.summaries = [...this.summaries].reverse();
      } catch (error) {
        console.error('加载摘要失败:', error);
      }
    },
    async loadLogs() {
      try {
        const logs = await ipcRenderer.invoke('get-logs');
        this.logs = [...logs].reverse();
      } catch (error) {
        console.error('加载日志失败:', error);
      }
    },
    async checkMonitoringStatus() {
      try {
        this.isMonitoring = await ipcRenderer.invoke('get-monitoring-status');
      } catch (error) {
        console.error('检查记录状态失败:', error);
      }
    },
    async toggleMonitoring() {
      try {
        this.isMonitoring = await ipcRenderer.invoke('toggle-monitoring');
        this.addLog(this.isMonitoring ? '记录已开始' : '记录已暂停');
      } catch (error) {
        console.error('切换记录状态失败:', error);
        this.addLog('切换记录状态失败: ' + error.message);
      }
    },
    async generateSummary() {
      try {
        this.isGeneratingSummary = true;
        this.addLog('正在生成摘要...');
        await ipcRenderer.invoke('generate-summary');
        await this.loadSummaries();
        this.addLog('摘要生成成功');
        this.showToast('摘要生成成功', 'success');
      } catch (error) {
        console.error('生成摘要失败:', error);
        this.addLog('生成摘要失败: ' + error.message);
        this.showToast('生成摘要失败: ' + error.message, 'error');
      } finally {
        this.isGeneratingSummary = false;
      }
    },
    minimizeWindow() {
      ipcRenderer.invoke('minimize-window');
    },
    closeWindow() {
      ipcRenderer.invoke('minimize-window');
    },
    changeDate(delta) {
      const d = new Date(this.selectedDate);
      d.setDate(d.getDate() + delta);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d <= today) {
        this.selectedDate = d.toISOString().split('T')[0];
        this.calendarYear = d.getFullYear();
        this.calendarMonth = d.getMonth();
        this.onDateChange();
      }
    },
    goToToday() {
      this.selectedDate = new Date().toISOString().split('T')[0];
      this.calendarYear = new Date().getFullYear();
      this.calendarMonth = new Date().getMonth();
      this.onDateChange();
    },
    formatDateDisplay(dateStr) {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    changeCalendarMonth(delta) {
      let m = this.calendarMonth + delta;
      let y = this.calendarYear;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      this.calendarMonth = m;
      this.calendarYear = y;
    },
    selectCalendarDate(day) {
      if (day.isFuture) return;
      this.selectedDate = day.dateStr;
      this.showCalendar = false;
      this.onDateChange();
    },
    closeCalendar(e) {
      if (this.showCalendar) {
        this.showCalendar = false;
      }
    },
    async onDateChange() {
      await this.loadActivities();
      await this.loadSummaries();
    },
    async exportData() {
      const data = {
        date: this.selectedDate,
        activities: this.activities,
        summaries: this.summaries,
        statistics: this.statistics
      };
      const blob = JSON.stringify(data, null, 2);
      const filename = `worklog_${this.selectedDate}.json`;

      // Use a simple download approach via IPC
      try {
        await ipcRenderer.invoke('export-data', { filename, content: blob });
        this.addLog(`数据已导出: ${filename}`);
      } catch (error) {
        this.addLog('导出失败: ' + error.message);
      }
    },
    async toggleAutoLaunch() {
      try {
        await ipcRenderer.invoke('set-auto-launch', this.autoLaunch);
        this.addLog(this.autoLaunch ? '已启用开机自启动' : '已关闭开机自启动');
      } catch (error) {
        this.addLog('设置自启动失败: ' + error.message);
      }
    },
    onThemeChange() {
      this.config.ui = this.config.ui || {};
      this.config.ui.theme = this.theme;
      this.saveConfig();
    },
    updateStatistics() {
      const appUsage = {};
      this.activities.forEach(activity => {
        const appName = activity.processName;
        appUsage[appName] = (appUsage[appName] || 0) + 1;
      });

      this.statistics = {
        totalActivities: this.activities.length,
        uniqueApplications: Object.keys(appUsage).length,
        mostUsedApplication: Object.entries(appUsage)
          .sort((a, b) => b[1] - a[1])[0]
          ? {
              name: Object.entries(appUsage).sort((a, b) => b[1] - a[1])[0][0],
              count: Object.entries(appUsage).sort((a, b) => b[1] - a[1])[0][1]
            }
          : null
      };
    },
    updateCharts() {
      const appUsage = {};
      const subActivity = {};
      this.activities.forEach(activity => {
        const appName = activity.processName;
        appUsage[appName] = (appUsage[appName] || 0) + 1;
        
        const title = activity.windowTitle || appName;
        subActivity[title] = (subActivity[title] || 0) + 1;
      });

      this.appUsageStats = Object.fromEntries(
        Object.entries(appUsage).sort((a, b) => b[1] - a[1])
      );

      this.subActivityStats = Object.fromEntries(
        Object.entries(subActivity).sort((a, b) => b[1] - a[1])
      );

      this.updateAppDurationStats();
    },
    updateAppDurationStats() {
      if (this.activities.length === 0) {
        this.appDurationStats = {};
        return;
      }

      const appDuration = {};
      const sortedActivities = [...this.activities].reverse();
      const maxGapMs = 5 * 60 * 1000; // 超过5分钟的间隔忽略

      sortedActivities.forEach((activity, index) => {
        if (index < sortedActivities.length - 1) {
          const nextActivity = sortedActivities[index + 1];
          const duration = new Date(nextActivity.timestamp) - new Date(activity.timestamp);
          if (duration <= maxGapMs) {
            const appName = activity.processName;
            appDuration[appName] = (appDuration[appName] || 0) + duration;
          }
        }
      });

      this.appDurationStats = Object.fromEntries(
        Object.entries(appDuration).sort((a, b) => b[1] - a[1])
      );
    },
    calculateDuration(start, end) {
      const diff = new Date(end) - new Date(start);
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return '<1分钟';
      if (minutes < 60) return `${minutes}分钟`;
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      if (remainingMinutes === 0) return `${hours}小时`;
      return `${hours}小时${remainingMinutes}分钟`;
    },
    getBarWidth(count) {
      const maxCount = Math.max(...Object.values(this.appUsageStats));
      return maxCount > 0 ? (count / maxCount) * 100 : 0;
    },
    getDurationBarWidth(duration) {
      const maxDuration = Math.max(...Object.values(this.appDurationStats));
      return maxDuration > 0 ? (duration / maxDuration) * 100 : 0;
    },
    formatDuration(durationMs) {
      const minutes = Math.floor(durationMs / 60000);
      if (minutes < 1) return '<1分钟';
      if (minutes < 60) return `${minutes}分钟`;
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      if (remainingMinutes === 0) return `${hours}小时`;
      return `${hours}小时${remainingMinutes}分钟`;
    },
    setupEventListeners() {
      ipcRenderer.on('activity-logged', (event, activity) => {
        this.activities.unshift(activity);
        this.updateStatistics();
        this.updateCharts();
        const dateStr = new Date(activity.timestamp).toISOString().split('T')[0];
        this.datesWithData.add(dateStr);
        this.addLog(`活动记录: ${activity.processName} - ${activity.windowTitle}`);
      });

      ipcRenderer.on('summary-generated', () => {
        this.loadSummaries();
        this.addLog('摘要已生成');
      });

      ipcRenderer.on('log-message', (event, message) => {
        this.addLog(message);
      });

      ipcRenderer.on('error-message', (event, message) => {
        this.addLog('错误: ' + message);
      });

      ipcRenderer.on('config-updated', (event, newConfig) => {
        this.config = { ...this.config, ...newConfig };
        this.theme = this.config.ui?.theme || 'dark';
        this.addLog('配置已更新');
      });

      ipcRenderer.on('monitoring-status-changed', (event, status) => {
        this.isMonitoring = status;
      });
    },
    addLog(message, type = 'info') {
      const logEntry = {
        time: new Date().toLocaleTimeString('zh-CN'),
        message: message,
        type: type
      };
      this.logs.unshift(logEntry);

      if (this.logs.length > 500) {
        this.logs.pop();
      }
    },
    async clearLogs() {
      try {
        await ipcRenderer.invoke('clear-logs');
        this.logs = [];
      } catch (error) {
        console.error('清除日志失败:', error);
      }
    },
    async openLogsFolder() {
      try {
        await ipcRenderer.invoke('open-logs-folder');
      } catch (error) {
        console.error('打开日志文件夹失败:', error);
      }
    },
    scrollToBottom() {
      this.$nextTick(() => {
        if (this.$refs.logContent) {
          this.$refs.logContent.scrollTop = this.$refs.logContent.scrollHeight;
        }
      });
    },
    formatTime(timestamp) {
      return new Date(timestamp).toLocaleTimeString('zh-CN');
    },
    formatDateTime(timestamp) {
      return new Date(timestamp).toLocaleString('zh-CN');
    },
    async viewOCR(activity) {
      try {
        const ocrResult = await ipcRenderer.invoke('get-ocr-result', activity.id);
        if (ocrResult) {
          alert(`OCR识别结果:\n\n${ocrResult.text}`);
        } else {
          alert('暂无OCR识别结果');
        }
      } catch (error) {
        console.error('获取OCR结果失败:', error);
        alert('获取OCR结果失败');
      }
    },
    viewScreenshot(screenshot) {
      shell.openPath(screenshot.path);
    },
    renderMarkdown(content) {
      if (!content) return '';
      return marked(content);
    },
    async checkForUpdates() {
      this.checkingUpdate = true;
      this.updateInfo = null;
      try {
        this.updateInfo = await ipcRenderer.invoke('check-for-updates');
      } catch (error) {
        this.updateInfo = { error: error.message };
      } finally {
        this.checkingUpdate = false;
      }
    },
    openDownloadLink() {
      if (this.updateInfo?.downloadUrl) {
        shell.openExternal(this.updateInfo.downloadUrl);
      }
    },
    showToast(message, type = 'error') {
      this.toastMessage = message;
      this.toastType = type;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toastMessage = ''; }, 5000);
    }
  }
};
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

#app {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  height: 100vh;
  overflow: hidden;
}

.toast {
  position: fixed;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 13px;
  z-index: 9999;
  cursor: pointer;
  animation: toast-in 0.3s ease;
  max-width: 90%;
  text-align: center;
}

.toast.error {
  background-color: rgba(239, 68, 68, 0.95);
  color: #fff;
}

.toast.success {
  background-color: rgba(16, 185, 129, 0.95);
  color: #fff;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

#app.dark {
  --bg-primary: #0d0d0d;
  --bg-secondary: #1a1a1a;
  --bg-tertiary: #2a2a2a;
  --text-primary: #e8e8e8;
  --text-secondary: #888888;
  --border-color: #333333;
  --accent-color: #64ffda;
  --accent-bg: rgba(100, 255, 218, 0.1);
  --success-color: #64ffda;
  --danger-color: #ff6b6b;
  --warning-color: #ffd93d;
  --pulse-color: rgba(100, 255, 218, 0.4);
  --badge-text: #0d0d0d;
  --color-scheme: dark;
}

#app.light {
  --bg-primary: #f8f9fa;
  --bg-secondary: #ffffff;
  --bg-tertiary: #e9ecef;
  --text-primary: #212529;
  --text-secondary: #6c757d;
  --border-color: #dee2e6;
  --accent-color: #0d6efd;
  --accent-bg: rgba(13, 110, 253, 0.08);
  --success-color: #198754;
  --danger-color: #dc3545;
  --warning-color: #ffc107;
  --pulse-color: rgba(13, 110, 253, 0.4);
  --badge-text: #ffffff;
  --color-scheme: light;
}

#app.ocean {
  --bg-primary: #0b1929;
  --bg-secondary: #0d2137;
  --bg-tertiary: #122d4d;
  --text-primary: #d4e4f7;
  --text-secondary: #7ea8cc;
  --border-color: #1a3a5c;
  --accent-color: #4fc3f7;
  --accent-bg: rgba(79, 195, 247, 0.1);
  --success-color: #4fc3f7;
  --danger-color: #ef5350;
  --warning-color: #ffb74d;
  --pulse-color: rgba(79, 195, 247, 0.4);
  --badge-text: #0b1929;
  --color-scheme: dark;
}

#app.forest {
  --bg-primary: #1a2e1a;
  --bg-secondary: #1e3620;
  --bg-tertiary: #264228;
  --text-primary: #d4e8d0;
  --text-secondary: #8baa85;
  --border-color: #2e5430;
  --accent-color: #81c784;
  --accent-bg: rgba(129, 199, 132, 0.1);
  --success-color: #81c784;
  --danger-color: #e57373;
  --warning-color: #ffb74d;
  --pulse-color: rgba(129, 199, 132, 0.4);
  --badge-text: #1a2e1a;
  --color-scheme: dark;
}

#app.rose {
  --bg-primary: #2e1a24;
  --bg-secondary: #3a1f2e;
  --bg-tertiary: #4a2838;
  --text-primary: #f0d4e0;
  --text-secondary: #c48da0;
  --border-color: #5c2e44;
  --accent-color: #f48fb1;
  --accent-bg: rgba(244, 143, 177, 0.1);
  --success-color: #81c784;
  --danger-color: #ef5350;
  --warning-color: #ffcc80;
  --pulse-color: rgba(244, 143, 177, 0.4);
  --badge-text: #2e1a24;
  --color-scheme: dark;
}

.container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

.title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 32px;
  background-color: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
  user-select: none;
}

.title-bar-drag {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
}

.app-icon {
  font-size: 14px;
}

.app-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.title-bar-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 46px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s;
}

.win-btn:hover {
  background-color: var(--bg-tertiary);
}

.win-btn-close:hover {
  background-color: #e81123;
  color: white;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background-color: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.date-picker {
  display: flex;
  align-items: center;
  gap: 4px;
}

.date-nav-btn {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.date-nav-btn:hover:not(:disabled) {
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.date-nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.date-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.date-display-btn {
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.2s;
}

.date-display-btn:hover {
  border-color: var(--accent-color);
}

.calendar-popup {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: 260px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.calendar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.cal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.cal-nav-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cal-nav-btn:hover {
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
}

.calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  margin-bottom: 4px;
}

.calendar-weekdays span {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 4px 0;
}

.calendar-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cal-day {
  width: 100%;
  aspect-ratio: 1;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: all 0.15s;
}

.cal-day:hover:not(:disabled) {
  background-color: var(--bg-tertiary);
}

.cal-day.other-month {
  color: var(--text-secondary);
  opacity: 0.4;
}

.cal-day.is-today {
  border: 1px solid var(--accent-color);
  font-weight: 600;
}

.cal-day.is-selected {
  background-color: var(--accent-color);
  color: var(--badge-text);
  font-weight: 600;
}

.cal-day.has-data:not(.is-selected)::after {
  content: '';
  position: absolute;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background-color: #10b981;
}

.cal-day.is-future {
  opacity: 0.25;
  cursor: not-allowed;
}

.today-btn {
  padding: 3px 10px;
  border: 1px solid var(--accent-color);
  border-radius: 4px;
  background: transparent;
  color: var(--accent-color);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.today-btn:hover {
  background: var(--accent-bg);
}

.monitor-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border: 1px solid #6b7280;
  border-radius: 20px;
  background-color: rgba(107, 114, 128, 0.15);
  color: #9ca3af;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
}

.monitor-btn:hover {
  border-color: #f59e0b;
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
}

.monitor-btn.active {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.15));
  border-color: #10b981;
  color: #10b981;
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.25);
}

.monitor-btn.active:hover {
  border-color: #f59e0b;
  color: #f59e0b;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.15));
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.25);
}

.monitor-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #6b7280;
  transition: background-color 0.2s;
}

.monitor-dot.pulse {
  background-color: #10b981;
  animation: monitor-pulse 2s infinite;
}

@keyframes monitor-pulse {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 var(--pulse-color); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 18px;
  transition: background-color 0.2s;
}

.icon-btn:hover {
  background-color: var(--border-color);
}

.icon-btn.small {
  width: 28px;
  height: 28px;
  font-size: 14px;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.stats-section {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
}

.stat-card {
  flex: 1;
  padding: 12px 16px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  text-align: center;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--accent-color);
  margin-bottom: 2px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.charts-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 20px 12px;
}

.chart-card {
  flex: 1;
  padding: 14px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.chart-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}

.chart-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background-color: var(--accent-color);
  color: var(--badge-text);
  opacity: 0.8;
}

.chart-content {
  max-height: 170px;
  overflow-y: auto;
}

.app-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background-color 0.15s;
}

.app-bar:hover {
  background-color: var(--bg-secondary);
}

.app-rank {
  min-width: 20px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: center;
}

.app-bar:nth-child(1) .app-rank { color: #ffd700; }
.app-bar:nth-child(2) .app-rank { color: #c0c0c0; }
.app-bar:nth-child(3) .app-rank { color: #cd7f32; }

.app-name {
  width: 120px;
  min-width: 120px;
  max-width: 120px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
  cursor: default;
}

.app-bar-container {
  flex: 1;
  height: 18px;
  background-color: var(--bg-primary);
  border-radius: 4px;
  overflow: hidden;
}

.app-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-color), var(--accent-bg));
  border-radius: 4px;
  transition: width 0.3s ease;
}

.app-bar-fill.duration-fill {
  background: linear-gradient(90deg, var(--warning-color), rgba(255, 217, 61, 0.3));
}

.app-count {
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--text-primary);
}

.timeline-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timeline-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  background-color: var(--bg-secondary);
  border-radius: 4px;
}

.timeline-time {
  min-width: 60px;
  font-size: 11px;
  color: var(--text-secondary);
}

.timeline-app {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timeline-duration {
  min-width: 70px;
  text-align: right;
  font-size: 11px;
  color: var(--accent-color);
}

.tab-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin: 0 20px 12px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  min-height: 0;
}

.tabs {
  display: flex;
  padding: 0;
  gap: 0;
  background-color: transparent;
  border-bottom: 1px solid var(--border-color);
}

.tab-btn {
  flex: 1;
  padding: 10px 0;
  border: none;
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
  font-size: 13px;
  font-weight: 500;
  text-align: center;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
}

.tab-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
}

.activities-list,
.summaries-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.activity-item {
  padding: 10px 14px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  gap: 12px;
  align-items: center;
  transition: border-color 0.15s;
}

.activity-item:hover {
  border-color: var(--accent-color);
}

.summary-item {
  padding: 16px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s;
}

.summary-item:hover {
  border-color: var(--accent-color);
}

.activity-time {
  min-width: 80px;
  font-size: 12px;
  color: var(--text-secondary);
}

.activity-details {
  flex: 1;
}

.activity-process {
  font-weight: 500;
  margin-bottom: 2px;
}

.activity-window {
  font-size: 14px;
  color: var(--text-secondary);
}

.activity-screenshot {
  min-width: 40px;
}

.screenshot-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  cursor: pointer;
  font-size: 16px;
  transition: background-color 0.2s;
}

.screenshot-btn:hover {
  background-color: var(--border-color);
}

.summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.summary-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.summary-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.summary-divider {
  color: var(--text-secondary);
  font-size: 12px;
}

.summary-count {
  font-size: 12px;
  color: var(--accent-color);
  padding: 1px 8px;
  background-color: rgba(74, 158, 255, 0.1);
  border-radius: 10px;
}

.summary-content {
  flex: 1;
  line-height: 1.5;
  font-size: 13px;
}

.summary-content :deep(h1),
.summary-content :deep(h2),
.summary-content :deep(h3),
.summary-content :deep(h4),
.summary-content :deep(h5),
.summary-content :deep(h6) {
  margin: 8px 0 4px 0;
  font-weight: 600;
}

.summary-content :deep(h1) { font-size: 16px; }
.summary-content :deep(h2) { font-size: 15px; }
.summary-content :deep(h3) { font-size: 14px; }
.summary-content :deep(h4),
.summary-content :deep(h5),
.summary-content :deep(h6) { font-size: 13px; }

.summary-content :deep(p) {
  margin: 4px 0;
}

.summary-content :deep(ul),
.summary-content :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.summary-content :deep(li) {
  margin: 2px 0;
}

.summary-content :deep(code) {
  background-color: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.summary-content :deep(pre) {
  background-color: var(--bg-tertiary);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 4px 0;
}

.summary-content :deep(pre code) {
  background: none;
  padding: 0;
}

.summary-content :deep(blockquote) {
  border-left: 3px solid var(--accent-color);
  padding-left: 12px;
  margin: 4px 0;
  color: var(--text-secondary);
}

.summary-actions {
  margin-bottom: 16px;
}

.action-btn {
  padding: 8px 20px;
  border: 1px solid var(--accent-color);
  border-radius: 6px;
  background-color: var(--accent-bg);
  color: var(--accent-color);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.action-btn:hover {
  background-color: var(--accent-color);
  color: var(--bg-primary);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-group {
  background-color: var(--bg-secondary);
  padding: 16px;
  border-radius: 8px;
}

.settings-group h3 {
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
}

.setting-item {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
  gap: 12px;
}

.setting-item:last-child {
  margin-bottom: 0;
}

.setting-item label {
  min-width: 120px;
  font-size: 14px;
}

.setting-item input[type="text"],
.setting-item input[type="number"],
.setting-item input[type="password"] {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 14px;
}

.setting-item input[type="checkbox"] {
  width: 18px;
  height: 18px;
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.log-panel {
  height: 150px;
  background-color: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.log-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.log-type-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  transition: all 0.2s;
}

.log-type-btn:hover {
  background-color: var(--border-color);
}

.log-type-btn.active {
  background-color: var(--accent-color);
  color: white;
}

.log-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

.log-entry {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 4px;
}

.log-entry.error .log-message {
  color: var(--danger-color);
}

.log-entry.warning .log-message {
  color: var(--warning-color);
}

.log-time {
  color: var(--text-secondary);
  min-width: 80px;
}

.log-message {
  color: var(--text-primary);
}

.logs-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--bg-secondary);
  border-radius: 8px;
}

.log-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.log-content-full {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.settings-panel-full {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.back-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
}

.back-btn:hover {
  background-color: var(--border-color);
}

.settings-header h2 {
  font-size: 18px;
  font-weight: 600;
}

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-secondary);
}

.select-input {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  color-scheme: var(--color-scheme);
}

.about-section {
  text-align: center;
}

.about-info p {
  margin: 4px 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.version {
  color: var(--accent-color);
  font-weight: 600;
}

.about-desc {
  font-size: 12px !important;
  opacity: 0.7;
}

.update-section {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.update-result {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.update-available {
  color: var(--accent-color);
  font-weight: 600;
}

.update-latest {
  color: var(--success-color);
}

.update-error {
  color: var(--danger-color);
}

.setting-item textarea {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}
</style>