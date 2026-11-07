<template>
  <div class="app-root" :class="['theme-' + theme, 'accent-' + accent, 'surface-' + (config.ui?.surface || 'studio'), { 'theme-switching': themeSwitching }]">
    <FocusOverlay
      :state="focusState"
      @end="endFocus"
      @toggle-pause="toggleFocusPause"
      @skip="skipFocusPhase"
      @add-note="addFocusNote"
    />

    <transition name="modal-fade">
      <div v-if="focusDialog" class="modal-mask" @click.self="closeFocusDialog">
        <div class="focus-dialog">
          <h3>开始专注</h3>
          <p>选一个节奏，写下当下最重要的一件事</p>

          <div class="mode-grid">
            <button
              v-for="p in focusPresetList"
              :key="p.id"
              class="mode-card"
              :class="{ active: focusMode === p.id }"
              :style="{ '--mode-tint': p.tint }"
              @click="focusMode = p.id"
            >
              <Icon :name="p.icon" :size="15" />
              <span class="mc-name">{{ p.name }}</span>
              <span class="mc-hint">{{ p.hint }}</span>
            </button>
          </div>

          <input
            v-model="focusInput"
            class="modal-input"
            :placeholder="focusMode === 'arhat' ? '例如：把这份合同看完' : '例如：写三季度商户分析报告'"
            @keydown.enter="startFocus"
            @keydown.esc="closeFocusDialog"
          >

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="closeFocusDialog">取消</button>
            <button class="btn btn-primary" @click="startFocus">开始</button>
          </div>
        </div>
      </div>
    </transition>

    <TitleBar
      :monitoring="isMonitoring"
      :theme="theme"
      :accent="accent"
      :accent-options="accentOptions"
      @minimize="minimizeWindow"
      @close="closeWindow"
      @toggle-monitoring="toggleMonitoring"
      @theme-change="onThemeChange"
      @accent-change="onAccentChange"
      @snap="toggleSnap"
    />

    <div class="shell">
      <NavRail :model-value="view" @update:model-value="onViewChange" />

      <main ref="content" class="content">
        <TodayView
          v-if="view === 'today'"
          :config="config"
          :report="report"
          :recorder="recorder"
          :is-today="isToday"
          :heat-daily="heatDaily"
          :selected-date="selectedDate"
          :dates-with-data="datesWithData"
          :theme="theme"
          :heat-from="heatFrom"
          :heat-to="heatTo"
          :heat-can-go-forward="heatCanGoForward"
          :heat-weeks="heatWeeks"
          :dida-status="didaStatus"
          :summaries="summaries"
          :suggestions="annotationSuggestions"
          :ai-enabled="aiEnabled"
          :ai-ready="aiReady"
          :ai-provider="config.api && config.api.provider"
          :generating-summary="isGeneratingSummary"
          @generate-summary="generateSummary"
          @accept-suggestion="acceptSuggestion"
          @dismiss-suggestion="dismissSuggestion"
          @open-ai-settings="openAiSettings"
          @jump-to-time="onJumpToTime"
          @select-date="selectHeatDate"
          @shift-date="changeDate"
          @go-today="goToToday"
          @shift-range="shiftHeatRange"
          @pick-month="pickHeatMonth"
          @heat-today="heatGoToday"
          @start-focus="showArhatStart"
          @toggle-plugin="togglePlugin"
          @open-plugin-settings="openPluginSettings"
        />

        <TimelineView
          v-else-if="view === 'timeline'"
          :report="report"
          :activities="activities"
          :selected-date="selectedDate"
          :dates-with-data="datesWithData"
          :focus-target="timelineTarget"
          :theme="theme"
          @update:selected-date="onSelectDate"
          @shift="changeDate"
          @today="goToToday"
          @refresh="onDataChanged"
          @manual-error="showToast($event, 'error')"
          @focus-consumed="timelineTarget = null"
          @focus-missed="onFocusMissed"
        />

        <SettingsView
          v-else
          :config="config"
          :theme="theme"
          :accent="accent"
          :accent-options="accentOptions"
          :active-section="settingsSection"
          :provider-presets="providerPresets"
          :dida-status="didaStatus"
          :bridge="bridge"
          :bridge-loading="bridgeLoading"
          :bridge-testing="bridgeTesting"
          :bridge-test-result="bridgeTestResult"
          :bridge-copied="bridgeCopied"
          :bridge-port-input="bridgePortInput"
          :auto-launch="autoLaunch"
          :app-version="appVersion"
          :update-info="updateInfo"
          :checking-update="checkingUpdate"
          :logs="logs"
          :storage-path="storagePath"
          @save="saveConfig"
          @provider-change="onProviderChange"
          @toggle-auto-launch="toggleAutoLaunch"
          @theme-change="onThemeChange"
          @accent-change="onAccentChange"
          @select-storage="selectStoragePath"
          @reset-storage="resetStoragePath"
          @export-day="exportData"
          @export-full-json="exportFullJSON"
          @export-csv="exportCSV"
          @import-merge="importData('merge')"
          @import-overwrite="importData('overwrite')"
          @bridge-toggle="toggleBridge"
          @bridge-apply-port="applyBridgePort"
          @bridge-regen="regenerateBridgeToken"
          @bridge-test="testBridge"
          @bridge-copy="copyBridgeText"
          @bridge-open="openBridgeUrl"
          @update:bridge-port-input="bridgePortInput = $event"
          @add-schedule="addSchedule"
          @remove-schedule="removeSchedule"
          @check-update="checkForUpdates"
          @open-download="openDownloadLink"
          @clear-logs="clearLogs"
          @open-logs="openLogsFolder"
          @dida-sync="syncDida"
        />
      </main>
    </div>

    <transition name="toast">
      <div v-if="toastMessage" class="toast" :class="toastType">{{ toastMessage }}</div>
    </transition>
  </div>
</template>

<script>
const { ipcRenderer, shell, clipboard } = require('electron');

import Icon from './components/Icon.vue';
import TitleBar from './components/TitleBar.vue';
import NavRail from './components/NavRail.vue';
import FocusOverlay from './components/FocusOverlay.vue';
import TodayView from './views/TodayView.vue';
import TimelineView from './views/TimelineView.vue';
import SettingsView from './views/SettingsView.vue';
import { ACCENTS } from './styles/accents.js';
import { pluginById, pluginOn, writePath } from './plugins/registry.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateStr(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** 热力图范围：周一开头、共 weeks*7 天。
 *  offsetWeeks = 0 表示最近 12 周（最后一列是本周），负数为向历史翻页。 */
function heatRange(weeks = 12, offsetWeeks = 0) {
  const anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  const dow = (anchor.getDay() + 6) % 7; // 周一=0 … 周日=6
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - dow + offsetWeeks * 7);
  const from = new Date(monday);
  from.setDate(monday.getDate() - (weeks - 1) * 7);
  const to = new Date(monday);
  to.setDate(monday.getDate() + 6);
  return { from: localDateStr(from), to: localDateStr(to) };
}

function emptyReport(date) {
  return {
    kind: 'day',
    date,
    stats: {
      recordCount: 0, sessionCount: 0, uniqueApps: 0, trackedMs: 0,
      idleMs: 0, idleSessionCount: 0, spanMs: 0, coverage: 0,
      firstAt: null, lastAt: null, bigGapCount: 0
    },
    categories: [],
    apps: [],
    sessions: [],
    focus: { arhatSessions: [], notes: [] },
    dataNotes: []
  };
}

export default {
  name: 'App',
  components: { Icon, TitleBar, NavRail, FocusOverlay, TodayView, TimelineView, SettingsView },
  data() {
    return {
      view: 'today',
      isMonitoring: false,
      recorder: null,

      selectedDate: localDateStr(),
      report: emptyReport(localDateStr()),
      activities: [],
      summaries: [],
      annotationSuggestions: [],
      datesWithData: new Set(),
      heatDaily: [],
      heatFrom: '',
      heatTo: '',
      heatOffset: 0,
      themeSwitching: false,
      timelineTarget: null,
      logs: [],

      config: {
        monitoring: { interval: 60, idleThresholdSec: 180, minSegmentSec: 3 },
        api: { provider: 'deepseek', apiKey: '', baseUrl: '', modelName: '' },
        summary: { lookbackMinutes: 60, maxTokens: 500, compressActivities: true, prompt: '', schedules: [] },
        focus: {
          pomodoro: { workMin: 25, breakMin: 5, rounds: 4 },
          immersive: { workMin: 15, breakMin: 15, rounds: 0 }
        },
        storage: { customPath: '' },
        ui: { theme: 'dark', floatWindow: true }
      },
      providerPresets: {},
      theme: 'dark',
      accent: 'blue',
      // 外观 = 明暗模式 × 强调色。不再有「整套染成草绿色」这类主题。
      accentOptions: ACCENTS,
      settingsSection: 'pomodoro',
      didaStatus: {},
      autoLaunch: false,
      storagePath: '',

      bridge: null,
      bridgeLoading: false,
      bridgeTesting: false,
      bridgeTestResult: null,
      bridgePortInput: 47821,
      bridgeCopied: '',

      isGeneratingSummary: false,
      summaryStartTime: '',
      summaryEndTime: '',

      appVersion: '',
      updateInfo: null,
      checkingUpdate: false,

      focusState: { active: false },
      focusPresets: {},
      focusDialog: false,
      focusMode: 'pomodoro',
      focusInput: '',

      toastMessage: '',
      toastType: 'info'
    };
  },
  async mounted() {
    await this.loadConfig();
    await this.loadProviderPresets();
    await this.reloadDate();
    await this.loadLogs();
    await this.loadBridgeStatus();
    await this.loadDidaStatus();
    this.appVersion = await ipcRenderer.invoke('get-app-version');
    this.autoLaunch = await ipcRenderer.invoke('get-auto-launch');
    this.isMonitoring = await ipcRenderer.invoke('get-monitoring-status');
    await this.loadRecorderStatus();
    await this.loadFocusPresets();
    await this.loadFocusState();
    this.setupEventListeners();
    this.initSummaryTimeRange();

    this._statusTimer = setInterval(() => this.loadRecorderStatus(), 2000);
  },
  beforeUnmount() {
    this.removeEventListeners();
    if (this._statusTimer) clearInterval(this._statusTimer);
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._themeTimer) clearTimeout(this._themeTimer);
  },
  computed: {
    isToday() {
      return this.selectedDate === localDateStr();
    },
    /**
     * AI 是一层能力，不是一个页面：
     * - aiEnabled 未开：应用只做本地记录与统计，不联网、不调模型
     * - aiEnabled 已开但没配 Key：视为「半开」，提示去配置，而不是静默失败
     */
    aiEnabled() {
      return !!(this.config.ai && this.config.ai.enabled);
    },
    aiReady() {
      return this.aiEnabled && !!(this.config.api && this.config.api.apiKey);
    },
    /** 热力图周数来自设置页，改了就要真正改变天数跨度 */
    heatWeeks() {
      const n = parseInt(this.config?.dashboard?.heatmapWeeks, 10);
      return Number.isFinite(n) ? Math.max(4, Math.min(52, n)) : 12;
    },
    heatCanGoForward() {
      return this.heatOffset < 0;
    },
    focusPresetList() {
      const order = ['pomodoro', 'immersive', 'arhat'];
      return order
        .map(id => this.focusPresets[id])
        .filter(Boolean);
    }
  },
  watch: {
    // 设置页改热力图周数后，首页必须真的按新跨度重拉
    'config.dashboard.heatmapWeeks'() {
      this.loadDailyTracked(true);
    }
  },
  methods: {
    /** 首页插件坞：整块点击切换开关。
     *  MCP 插件还要同步主进程的接口启停，否则配置改了服务没停。 */
    async togglePlugin(id) {
      const plugin = pluginById(id);
      if (!plugin) return;
      const next = !pluginOn(this.config, plugin);
      writePath(this.config, plugin.path, next);
      if (id === 'mcp') {
        try {
          await ipcRenderer.invoke('set-bridge-config', { enabled: next });
          await this.loadBridgeStatus();
        } catch (e) { /* 配置已落盘，状态刷新失败不阻塞切换 */ }
      }
      await this.saveConfig();
      this.showToast(`${plugin.name}已${next ? '开启' : '关闭'}`, 'success');
    },
    /** 首页齿轮直接定位到对应插件分区，不再统一跳到「插件与首页」 */
    openPluginSettings(id) {
      const plugin = pluginById(id);
      this.settingsSection = plugin ? plugin.section : (id || 'dashboard');
      this.view = 'settings';
    },

    async loadDidaStatus() {
      try {
        const st = await ipcRenderer.invoke('dida-status');
        if (st) this.didaStatus = st;
      } catch (_) { /* 插件未加载时保持空状态 */ }
    },

    /** 设置页「立即拉取 / 立即推送」：只走主进程通道，推送仍需三重保护 */
    async syncDida(direction) {
      try {
        const res = await ipcRenderer.invoke('dida-sync-now', { direction: direction || 'pull' });
        const r = direction === 'push' ? res : (res && res.pull) || res;
        if (r && r.error) this.showToast(r.error, 'error');
        else if (r && r.skipped) this.showToast(r.reason || '该通道未开启', 'error');
        else if (direction === 'push') this.showToast(`已推送 ${(r && r.count) || 0} 条`, 'success');
        else this.showToast(`拉取完成 · 新增 ${(r && r.added) || 0} 条专注`, 'success');
        await this.loadDidaStatus();
        this.reloadDate(true);
      } catch (e) {
        this.showToast('同步失败: ' + e.message, 'error');
      }
    },

    /** 点侧栏换页时回到顶部。
     *  从今日页「跳到某个时段」不经过这里，那边需要保留定位滚动。 */
    onViewChange(next) {
      if (next === this.view) return;
      this.view = next;
      this.$nextTick(() => {
        const el = this.$refs.content;
        if (el) el.scrollTop = 0;
      });
    },

    // ============ 数据加载 ============

    async reloadDate(forceHeat = false) {
      await Promise.all([
        this.loadReport().then(() => this.loadAnnotationSuggestions()),
        this.loadActivities(),
        this.loadSummaries(),
        this.loadDatesWithData(),
        this.loadDailyTracked(forceHeat)
      ]);
    },

    async loadReport() {
      const date = this.selectedDate;
      try {
        const res = await ipcRenderer.invoke('get-day-analytics', date);
        if (date === this.selectedDate) this.report = (res && res.ok) ? res.report : emptyReport(date);
      } catch (error) {
        if (date === this.selectedDate) this.report = emptyReport(date);
      }
    },

    async loadActivities() {
      try {
        const all = await ipcRenderer.invoke('get-activities', this.selectedDate);
        this.activities = [...all].reverse();
      } catch (error) {
        this.activities = [];
      }
    },

    async loadSummaries() {
      try {
        const items = await ipcRenderer.invoke('get-summaries', this.selectedDate);
        this.summaries = [...items].reverse();
      } catch (error) {
        this.summaries = [];
      }
    },

    async loadAnnotationSuggestions() {
      const date = this.selectedDate;
      if (this.report.date !== date) return;
      try {
        const result = await ipcRenderer.invoke('get-annotation-suggestions', { date, slots: this.report.slots || [] });
        if (date === this.selectedDate) this.annotationSuggestions = Array.isArray(result) ? result : [];
      } catch (_) {
        if (date === this.selectedDate) this.annotationSuggestions = [];
      }
    },

    async acceptSuggestion(suggestion) {
      const date = this.selectedDate;
      const startMin = suggestion.startMin;
      const toIso = min => {
        const d = new Date(`${date}T00:00:00`);
        d.setMinutes(min);
        return d.toISOString();
      };
      const res = await ipcRenderer.invoke('replace-display-ranges', {
        ranges: [{ start: toIso(startMin), end: toIso(startMin + 15) }],
        record: {
          date,
          startTime: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`,
          durationMin: 15,
          app: suggestion.app,
          title: suggestion.note || '',
          category: suggestion.category
        }
      });
      if (!res?.ok) {
        this.showToast(res?.error || '标注失败', 'error');
        return;
      }
      this.showToast('已记住这次分类', 'success');
      await this.reloadDate(true);
    },

    async dismissSuggestion(suggestion) {
      const date = this.selectedDate;
      const ok = await ipcRenderer.invoke('dismiss-annotation-suggestion', { date, ...suggestion });
      if (ok) this.annotationSuggestions = this.annotationSuggestions.filter(item => item.startMin !== suggestion.startMin);
    },

    async loadDatesWithData() {
      try {
        const dates = await ipcRenderer.invoke('get-dates-with-data');
        this.datesWithData = new Set(dates);
      } catch (error) { /* noop */ }
    },

    /** 热力图范围与 selectedDate 无关，按 heatOffset 翻页；60s 冷却避免反复重算 */
    async loadDailyTracked(force = false) {
      const now = Date.now();
      if (!force && now - (this._lastHeatLoad || 0) < 60000) return;
      this._lastHeatLoad = now;
      const { from, to } = heatRange(this.heatWeeks, this.heatOffset);
      try {
        const res = await ipcRenderer.invoke('get-daily-tracked', { from, to });
        this.heatDaily = (res && res.ok) ? res.days : [];
        this.heatFrom = from;
        this.heatTo = to;
      } catch (error) {
        this.heatDaily = [];
      }
    },

    async loadRecorderStatus() {
      try {
        this.recorder = await ipcRenderer.invoke('get-recorder-status');
      } catch (error) { /* noop */ }
    },

    async loadLogs() {
      try {
        const items = await ipcRenderer.invoke('get-logs');
        this.logs = [...items].reverse();
      } catch (error) { /* noop */ }
    },

    async loadConfig() {
      try {
        this.config = await ipcRenderer.invoke('get-config');
        const m = (this.config.monitoring = this.config.monitoring || {});
        if (m.idleThresholdSec === undefined) m.idleThresholdSec = 180;
        if (m.minSegmentSec === undefined) m.minSegmentSec = 3;
        if (m.interval === undefined) m.interval = 60;
        this.config.summary = this.config.summary || {};
        if (!this.config.summary.schedules) this.config.summary.schedules = [];
        if (!this.config.focus) {
          this.config.focus = {
            pomodoro: { workMin: 25, breakMin: 5, rounds: 4 },
            immersive: { workMin: 15, breakMin: 15, rounds: 0 }
          };
        }
        this.theme = this.config.ui?.mode === 'light' ? 'light' : 'dark';
        this.accent = this.config.ui?.accent || 'blue';
        this.storagePath = await ipcRenderer.invoke('get-storage-path');
      } catch (error) {
        this.addLog('读取配置失败: ' + error.message, 'error');
      }
    },

    async loadProviderPresets() {
      try {
        this.providerPresets = await ipcRenderer.invoke('get-provider-presets');
      } catch (error) { /* noop */ }
    },

    // ============ 配置 ============

    async saveConfig() {
      try {
        const res = await ipcRenderer.invoke('save-config', JSON.parse(JSON.stringify(this.config)));
        if (res && res.success === false) {
          this.showToast('保存失败: ' + (res.error || '未知错误'), 'error');
          return false;
        }
        return true;
      } catch (error) {
        this.showToast('保存失败: ' + error.message, 'error');
        return false;
      }
    },

    onProviderChange(provider) {
      this.config.api.provider = provider;
      const preset = this.providerPresets[provider];
      if (preset) {
        if (preset.baseUrl) this.config.api.baseUrl = preset.baseUrl;
        if (preset.modelName) this.config.api.modelName = preset.modelName;
      }
      this.saveConfig();
    },

    onThemeChange(mode) {
      this.theme = mode === 'light' ? 'light' : 'dark';
      this.config.ui = this.config.ui || {};
      this.config.ui.mode = this.theme;
      this.flashThemeSwitch();
      this.saveConfig();
    },

    onAccentChange(accent) {
      this.accent = accent;
      this.config.ui = this.config.ui || {};
      this.config.ui.accent = accent;
      this.flashThemeSwitch();
      this.saveConfig();
    },

    /** 换肤时给一个很轻的淡入，避免颜色硬跳；不当作「大动效」使用 */
    flashThemeSwitch() {
      this.themeSwitching = false;
      this.$nextTick(() => {
        this.themeSwitching = true;
        if (this._themeTimer) clearTimeout(this._themeTimer);
        this._themeTimer = setTimeout(() => { this.themeSwitching = false; }, 760);
      });
    },

    /** 从「AI 未启用」的提示条跳去设置页，并直接定位到 AI 分区 */
    openAiSettings() {
      this.settingsSection = 'ai';
      this.view = 'settings';
    },

    async toggleAutoLaunch(enabled) {
      try {
        await ipcRenderer.invoke('set-auto-launch', enabled);
        this.autoLaunch = enabled;
        this.showToast(enabled ? '已开启开机自启动' : '已关闭开机自启动', 'success');
      } catch (error) {
        this.showToast('设置失败: ' + error.message, 'error');
      }
    },

    addSchedule() {
      if (!this.config.summary.schedules) this.config.summary.schedules = [];
      this.config.summary.schedules.push({ startTime: '09:00', endTime: '12:00' });
      this.saveConfig();
    },

    removeSchedule(index) {
      this.config.summary.schedules.splice(index, 1);
      this.saveConfig();
    },

    async selectStoragePath() {
      try {
        const chosen = await ipcRenderer.invoke('select-storage-folder');
        if (!chosen) return;
        const res = await ipcRenderer.invoke('migrate-storage', chosen);
        if (res && res.success) {
          this.config.storage = { ...(this.config.storage || {}), customPath: chosen };
          const ok = await this.saveConfig();
          // 无论保存结果如何，都以主进程实际生效的目录为准
          this.storagePath = await ipcRenderer.invoke('get-storage-path');
          if (ok) {
            this.showToast(`已切换到该目录，立即生效（合并 ${res.fileCount} 个新文件，未覆盖已有数据）`, 'success');
            await this.reloadDate();
            await this.loadDailyTracked(true);
            this.loadSummaries();
          }
        } else {
          this.showToast('迁移失败: ' + (res && res.error), 'error');
        }
      } catch (error) {
        this.showToast('切换失败: ' + error.message, 'error');
      }
    },

    async resetStoragePath() {
      this.config.storage = { customPath: '' };
      await this.saveConfig();
      this.storagePath = await ipcRenderer.invoke('get-storage-path');
      this.showToast('已恢复默认路径，立即生效', 'success');
      await this.reloadDate();
      await this.loadDailyTracked(true);
      this.loadSummaries();
    },

    // ============ 日期 ============

    onSelectDate(dateStr) {
      if (!dateStr || dateStr === this.selectedDate) return Promise.resolve();
      this.selectedDate = dateStr;
      // 日期条换到历史日期时，热力图窗口一并移到包含该日的 12 周
      const heatChanged = this.syncHeatRangeToDate(dateStr);
      return this.reloadDate(heatChanged);
    },

    onDataChanged() {
      this.reloadDate();
      this.loadDailyTracked(true);
    },

    /** 时间带点击：不换日期，切到时间线并定位到对应时段 */
    onJumpToTime(payload) {
      this.timelineTarget = {
        minutes: payload && Number.isFinite(payload.minutes) ? payload.minutes : null,
        date: this.selectedDate,
        token: (this._focusToken = (this._focusToken || 0) + 1)
      };
      this.view = 'timeline';
    },

    /** 热力图点击：只换日期，仍留在今日概览 */
    selectHeatDate(dateStr) {
      if (!dateStr || dateStr > localDateStr()) return;
      this.onSelectDate(dateStr);
    },

    /** 热力图向前/向后翻 12 周；0 = 最近 12 周，不允许翻到未来 */
    shiftHeatRange(delta) {
      const next = Math.min(0, this.heatOffset + delta);
      if (next === this.heatOffset) return;
      this.heatOffset = next;
      return this.loadDailyTracked(true);
    },

    /** 某个日期应该落在哪一组 12 周窗口：返回相对本周的周偏移（<= 0） */
    heatOffsetFor(dateStr) {
      const target = new Date(dateStr + 'T00:00:00');
      if (Number.isNaN(target.getTime())) return 0;
      const mondayOf = (d) => {
        const x = new Date(d);
        x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
        return x;
      };
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const back = Math.round((mondayOf(now) - mondayOf(target)) / (7 * 86400000));
      // 窗口覆盖 [本周-(weeks-1)周, 本周]，超出就把末尾对齐到目标所在周
      const span = this.heatWeeks - 1;
      return back > span ? -(back - span) : 0;
    },

    /** 日期条同步：只在窗口真的变了时返回 true，避免重复拉取 */
    syncHeatRangeToDate(dateStr) {
      const next = this.heatOffsetFor(dateStr);
      if (next === this.heatOffset) return false;
      this.heatOffset = next;
      return true;
    },

    /** 热力图直接跳到指定月份 */
    pickHeatMonth(ym) {
      if (!/^\d{4}-\d{2}$/.test(ym || '')) return;
      this.heatOffset = this.heatOffsetFor(ym + '-01');
      return this.loadDailyTracked(true);
    },

    /** 热力图的「今天」：日期与 12 周窗口一起回到当前 */
    heatGoToday() {
      const changed = this.heatOffset !== 0;
      this.heatOffset = 0;
      if (changed) this.loadDailyTracked(true);
      return this.goToToday();
    },

    onFocusMissed() {
      this.showToast('该时段附近没有会话记录', 'info');
    },

    changeDate(delta) {
      const d = new Date(this.selectedDate + 'T00:00:00');
      d.setDate(d.getDate() + delta);
      const next = localDateStr(d);
      if (next > localDateStr()) return;
      this.onSelectDate(next);
    },

    goToToday() {
      this.onSelectDate(localDateStr());
    },

    async toggleMonitoring() {
      try {
        this.isMonitoring = await ipcRenderer.invoke('toggle-monitoring');
        await this.loadRecorderStatus();
        this.showToast(this.isMonitoring ? '已开始记录' : '已暂停记录', 'success');
      } catch (error) {
        this.showToast('切换失败: ' + error.message, 'error');
      }
    },

    // ============ 摘要 ============

    initSummaryTimeRange() {
      const now = new Date();
      const start = new Date(now.getTime() - 60 * 60000);
      this.summaryEndTime = this.toLocalDatetime(now);
      this.summaryStartTime = this.toLocalDatetime(start);
    },

    toLocalDatetime(d) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    async generateSummary() {
      if (this.isGeneratingSummary) return;
      this.isGeneratingSummary = true;
      try {
        const date = this.selectedDate;
        const result = await ipcRenderer.invoke('generate-summary-range', {
          startTime: new Date(`${date}T00:00:00`).toISOString(),
          endTime: new Date(`${date}T23:59:59.999`).toISOString()
        });
        if (!result) {
          this.showToast('这一天没有可总结的记录', 'error');
          return;
        }
        await this.loadSummaries();
        this.showToast(`${date} 的回顾已生成`, 'success');
      } catch (error) {
        this.showToast('生成失败: ' + error.message, 'error');
      } finally {
        this.isGeneratingSummary = false;
      }
    },

    async generateSummaryForRange() {
      if (this.isGeneratingSummary) return;
      if (!this.summaryStartTime || !this.summaryEndTime) {
        this.showToast('请先选择时间段', 'error');
        return;
      }
      this.isGeneratingSummary = true;
      try {
        const result = await ipcRenderer.invoke('generate-summary-range', {
          startTime: new Date(this.summaryStartTime).toISOString(),
          endTime: new Date(this.summaryEndTime).toISOString()
        });
        if (!result) {
          this.showToast('所选时间段没有可总结的记录', 'error');
          return;
        }
        await this.loadSummaries();
        this.showToast('摘要已生成', 'success');
      } catch (error) {
        this.showToast('生成失败: ' + error.message, 'error');
      } finally {
        this.isGeneratingSummary = false;
      }
    },

    // ============ 专注助手 ============

    async loadFocusPresets() {
      try {
        this.focusPresets = await ipcRenderer.invoke('focus-presets');
      } catch (error) { /* noop */ }
    },

    async loadFocusState() {
      try {
        const s = await ipcRenderer.invoke('focus-state');
        if (s) this.focusState = s;
      } catch (error) { /* noop */ }
    },

    showArhatStart() {
      if (this.config.focus && this.config.focus.enabled === false) {
        this.showToast('番茄钟插件已关闭，可在首页插件坞开启', 'info');
        return;
      }
      this.focusDialog = true;
      this.focusInput = '';
    },

    closeFocusDialog() {
      this.focusDialog = false;
    },

    async startFocus() {
      try {
        const state = await ipcRenderer.invoke('focus-start', {
          mode: this.focusMode,
          focusText: (this.focusInput || '').trim()
        });
        this.focusState = state || { active: false };
        this.focusDialog = false;
      } catch (error) {
        this.showToast('开始失败: ' + error.message, 'error');
      }
    },

    async toggleFocusPause() {
      try {
        this.focusState = await ipcRenderer.invoke('focus-toggle-pause');
      } catch (error) { /* noop */ }
    },

    async skipFocusPhase() {
      try {
        this.focusState = await ipcRenderer.invoke('focus-skip');
      } catch (error) { /* noop */ }
    },

    async endFocus() {
      try {
        const record = await ipcRenderer.invoke('focus-end');
        this.focusState = { active: false };
        if (record) {
          const mins = Math.round(record.activeMs / 60000);
          this.showToast(`${record.modeName}结束 · 专注 ${mins} 分钟`, 'success');
        }
        await this.loadReport();
      } catch (error) {
        this.focusState = { active: false };
      }
    },

    async addFocusNote(text) {
      try {
        const note = await ipcRenderer.invoke('focus-add-note', text, 'random');
        if (note) this.showToast('已记录', 'success');
      } catch (error) {
        this.showToast('记录失败: ' + error.message, 'error');
      }
    },

    // ============ AI 接口 ============

    async loadBridgeStatus() {
      try {
        this.bridge = await ipcRenderer.invoke('get-bridge-status');
        this.bridgePortInput = this.bridge.port || this.bridge.basePort || 47821;
      } catch (error) { /* noop */ }
    },

    async toggleBridge(enabled) {
      this.bridgeLoading = true;
      // 主进程会落盘并重启服务，渲染层也要同步同一个开关，
      // 否则设置页标题开关和首页插件坞会显示两个不同状态
      this.config.bridge = { ...(this.config.bridge || {}), enabled };
      try {
        await ipcRenderer.invoke('set-bridge-config', { enabled });
        await this.loadBridgeStatus();
        this.showToast(enabled ? '接口已开启' : '接口已关闭', 'success');
      } catch (error) {
        this.showToast('操作失败: ' + error.message, 'error');
      } finally {
        this.bridgeLoading = false;
      }
    },

    async applyBridgePort() {
      const port = parseInt(this.bridgePortInput, 10);
      if (!port || port < 1024 || port > 65535) {
        this.showToast('端口需在 1024–65535 之间', 'error');
        return;
      }
      this.bridgeLoading = true;
      try {
        await ipcRenderer.invoke('set-bridge-config', { port });
        await this.loadBridgeStatus();
        this.showToast('端口已更新为 ' + port, 'success');
      } catch (error) {
        this.showToast('更新失败: ' + error.message, 'error');
      } finally {
        this.bridgeLoading = false;
      }
    },

    async regenerateBridgeToken() {
      this.bridgeLoading = true;
      try {
        await ipcRenderer.invoke('set-bridge-config', { regenerateToken: true });
        await this.loadBridgeStatus();
        this.showToast('Token 已重置', 'success');
      } catch (error) {
        this.showToast('重置失败: ' + error.message, 'error');
      } finally {
        this.bridgeLoading = false;
      }
    },

    async testBridge() {
      this.bridgeTesting = true;
      this.bridgeTestResult = null;
      try {
        this.bridgeTestResult = await ipcRenderer.invoke('test-bridge');
      } catch (error) {
        this.bridgeTestResult = { ok: false, error: error.message };
      } finally {
        this.bridgeTesting = false;
      }
    },

    copyBridgeText(text, tag) {
      if (!text) return;
      try {
        clipboard.writeText(text);
        this.bridgeCopied = tag;
        setTimeout(() => {
          if (this.bridgeCopied === tag) this.bridgeCopied = '';
        }, 1600);
      } catch (error) {
        this.showToast('复制失败: ' + error.message, 'error');
      }
    },

    openBridgeUrl() {
      ipcRenderer.invoke('open-bridge-url');
    },

    // ============ 导入导出 ============

    async exportData() {
      try {
        const items = await ipcRenderer.invoke('get-activities', this.selectedDate);
        await ipcRenderer.invoke('export-data', {
          filename: `worklog_${this.selectedDate}.json`,
          content: JSON.stringify({ version: this.appVersion, date: this.selectedDate, activities: items }, null, 2)
        });
      } catch (error) {
        this.showToast('导出失败: ' + error.message, 'error');
      }
    },

    async exportFullJSON() {
      try {
        await ipcRenderer.invoke('export-full-data', 'json');
      } catch (error) {
        this.showToast('导出失败: ' + error.message, 'error');
      }
    },

    async exportCSV() {
      try {
        await ipcRenderer.invoke('export-full-data', 'csv');
      } catch (error) {
        this.showToast('导出失败: ' + error.message, 'error');
      }
    },

    async importData(mode) {
      try {
        const res = await ipcRenderer.invoke('import-data', mode);
        if (res && res.success) {
          if (res.mode === 'directory') {
            this.showToast(`已切换到数据目录，立即生效（发现 ${res.importedCount} 个日期数据文件）`, 'success');
            this.storagePath = await ipcRenderer.invoke('get-storage-path');
          } else {
            this.showToast(`已导入 ${res.importedCount} 条记录`, 'success');
          }
          await this.reloadDate();
          await this.loadDailyTracked(true);
          await this.loadSummaries();
        } else if (res && !res.canceled) {
          this.showToast('导入失败: ' + res.error, 'error');
        }
      } catch (error) {
        this.showToast('导入失败: ' + error.message, 'error');
      }
    },

    // ============ 窗口 / 日志 / 更新 ============

    minimizeWindow() {
      ipcRenderer.invoke('minimize-window');
    },

    /** 贴边成竖窗格：再点一次还原 */
    toggleSnap() {
      ipcRenderer.invoke('toggle-snap');
    },

    closeWindow() {
      ipcRenderer.invoke('minimize-window');
    },

    async clearLogs() {
      await ipcRenderer.invoke('clear-logs');
      this.logs = [];
    },

    openLogsFolder() {
      ipcRenderer.invoke('open-logs-folder');
    },

    async checkForUpdates() {
      this.checkingUpdate = true;
      try {
        this.updateInfo = await ipcRenderer.invoke('check-for-updates');
      } catch (error) {
        this.updateInfo = { hasUpdate: false, error: error.message };
      } finally {
        this.checkingUpdate = false;
      }
    },

    openDownloadLink() {
      if (this.updateInfo && this.updateInfo.downloadUrl) {
        shell.openExternal(this.updateInfo.downloadUrl);
      }
    },

    // ============ 提示 / 日志 ============

    showToast(message, type) {
      this.toastMessage = message;
      this.toastType = type || 'info';
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this.toastMessage = '';
      }, 2600);
    },

    addLog(message, type) {
      this.logs.unshift({
        time: new Date().toLocaleTimeString('zh-CN'),
        message,
        type: type || 'info'
      });
      if (this.logs.length > 300) this.logs.length = 300;
    },

    // ============ IPC 事件 ============

    setupEventListeners() {
      this._listeners = {
        'activity-logged': () => {
          if (this.isToday) this.scheduleRefresh();
        },
        'focus-state': (event, state) => {
          this.focusState = state && state.active ? state : { active: false };
        },
        'focus-ended': (event, record) => {
          this.focusState = { active: false };
          if (record) {
            const mins = Math.round(record.activeMs / 60000);
            this.showToast(`${record.modeName}结束 · 专注 ${mins} 分钟`, 'success');
            this.loadReport();
          }
        },
        'summary-generated': () => {
          this.loadSummaries();
          this.loadReport();
        },
        'monitoring-status-changed': (event, status) => {
          this.isMonitoring = status;
        },
        'config-updated': (event, cfg) => {
          this.config = { ...this.config, ...cfg };
        },
        'storage-path-changed': (event, dataDir) => {
          // 主进程已即时切换数据目录，重新拉取当前日期/热力图/摘要
          this.storagePath = dataDir || '';
          this.reloadDate();
          this.loadDailyTracked(true);
          this.loadSummaries();
        },
        'log-message': (event, message) => this.addLog(message),
        'dida-status': (event, status) => { this.didaStatus = status || {}; },
        'data-changed': () => { this.reloadDate(true); },
        'error-message': (event, message) => {
          this.addLog('错误: ' + message, 'error');
          this.showToast(message, 'error');
        }
      };

      Object.entries(this._listeners).forEach(([channel, handler]) => {
        ipcRenderer.on(channel, handler);
      });
    },

    removeEventListeners() {
      if (!this._listeners) return;
      Object.entries(this._listeners).forEach(([channel, handler]) => {
        ipcRenderer.removeListener(channel, handler);
      });
      this._listeners = null;
    },

    /** 新片段到达后节流刷新，避免频繁重算 */
    scheduleRefresh() {
      if (this._refreshTimer) return;
      this._refreshTimer = setTimeout(async () => {
        this._refreshTimer = null;
        await this.loadReport();
        await this.loadActivities();
        await this.loadDatesWithData();
        await this.loadDailyTracked();
      }, 2000);
    }
  }
};
</script>

<style>
@import './styles/tokens.css';
@import './styles/base.css';
</style>

<style scoped>
.shell {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-canvas);
}

/* ---------- 弹窗 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
}

.modal-card {
  width: 300px;
  padding: var(--sp-5);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  text-align: center;
}

.modal-icon {
  width: 40px;
  height: 40px;
  margin: 0 auto var(--sp-3);
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.modal-card h3 {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.modal-card p {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

.modal-input {
  height: 34px;
  text-align: center;
  margin-bottom: var(--sp-4);
}

.modal-actions {
  display: flex;
  gap: var(--sp-2);
}

.modal-actions .btn {
  flex: 1;
}

/* ---------- 专注启动弹窗 ---------- */
.focus-dialog {
  width: 368px;
  padding: var(--sp-5);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  text-align: center;
}

.focus-dialog h3 {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.focus-dialog p {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

.mode-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--sp-3) var(--sp-2);
  border-radius: var(--r-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  color: var(--text-tertiary);
  text-align: center;
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease),
    color var(--dur-1) var(--ease);
}

.mode-card:hover {
  border-color: var(--border-strong);
  color: var(--text-secondary);
}

.mode-card.active {
  border-color: var(--mode-tint);
  background: color-mix(in srgb, var(--mode-tint) 12%, transparent);
  color: var(--mode-tint);
}

.mc-name {
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  margin-top: 2px;
}

.mode-card.active .mc-name {
  color: var(--mode-tint);
}

.mc-hint {
  font-size: var(--fs-10);
  line-height: 1.4;
  color: var(--text-tertiary);
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--dur-2) var(--ease);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

/* ---------- 提示条 ---------- */
.toast {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 400;
  max-width: 84%;
  padding: 8px 16px;
  border-radius: var(--r-full);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  font-size: var(--fs-12);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast.success {
  border-color: rgba(52, 211, 153, 0.4);
  color: var(--success);
}

.toast.error {
  border-color: rgba(248, 113, 113, 0.4);
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>

