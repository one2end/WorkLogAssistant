<template>
  <div class="timeline">
    <div class="tl-toolbar">
      <DateNav
        :selected-date="selectedDate"
        :dates-with-data="datesWithData"
        @update:selected-date="$emit('update:selectedDate', $event)"
        @shift="$emit('shift', $event)"
        @today="$emit('today')"
      />

      <div class="seg">
        <button
          class="seg-btn"
          :class="{ active: mode === 'sessions' }"
          @click="mode = 'sessions'"
        >会话</button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'raw' }"
          @click="mode = 'raw'"
        >明细</button>
      </div>
    </div>

    <div v-if="report.stats" class="tl-summary">
      <span class="tl-stat"><b>{{ fmt(report.stats.trackedMs) }}</b> 有效</span>
      <span class="tl-sep">·</span>
      <span class="tl-stat"><b>{{ report.stats.sessionCount }}</b> 段</span>
      <span class="tl-sep">·</span>
      <span class="tl-stat"><b>{{ report.stats.uniqueApps }}</b> 应用</span>

      <button class="manual-toggle" :class="{ active: manualOpen }" @click="toggleManual">
        <Icon name="plus" :size="11" />
        补记
      </button>
    </div>

    <!-- 手工补记 -->
    <div v-if="manualOpen" class="manual-panel">
      <div class="manual-fields">
        <label class="mf">
          <span>开始</span>
          <input v-model="manualTime" type="time">
        </label>
        <label class="mf narrow">
          <span>时长</span>
          <input v-model.number="manualDuration" type="number" min="1" max="1440">
        </label>
        <label class="mf grow">
          <span>分类</span>
          <select v-model="manualCategory">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
      </div>
      <label class="mf full">
        <span>事项</span>
        <input v-model="manualApp" type="text" placeholder="例如：客户走访 / 会议 / 纸质材料">
      </label>
      <label class="mf full">
        <span>备注</span>
        <input v-model="manualTitle" type="text" placeholder="这段没被记录的时间具体在做什么（可选）">
      </label>
      <div class="manual-actions">
        <span class="manual-hint">用于填补录制缺失的时段，会计入当日工时</span>
        <button class="btn btn-ghost btn-sm" @click="manualOpen = false">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="savingManual" @click="submitManual">
          {{ savingManual ? '保存中' : '保存' }}
        </button>
      </div>
    </div>

    <!-- 会话视图 -->
    <div v-if="mode === 'sessions'" class="tl-list">
      <template v-if="sessions.length">
        <div
          v-for="(s, i) in sessions"
          :key="i"
          class="tl-row"
          :class="{ 'is-focus': highlightIndex === i }"
          :data-idx="i"
        >
          <div class="tl-time">
            <span class="tl-start">{{ hm(s.start) }}</span>
            <span class="tl-end">{{ hm(s.end) }}</span>
          </div>
          <div class="tl-axis">
            <span class="tl-node" :style="{ background: colorOf(s.category) }"></span>
            <span v-if="i < sessions.length - 1" class="tl-line"></span>
          </div>
          <div class="tl-body">
            <div class="tl-head">
              <span class="tl-app">{{ s.app }}</span>
              <span class="tl-dur">{{ fmt(s.durationMs) }}</span>
            </div>
            <div class="tl-meta">
              <span class="cat-chip" :style="{ color: colorOf(s.category), background: softColor(s.category) }">
                {{ s.category }}
              </span>
              <span v-if="s.manual" class="tl-manual">手工</span>
              <span v-if="s.uncertain" class="tl-warn" title="该段存在数据空档，时长可能不准">
                <Icon name="alert" :size="10" /> 不确定
              </span>
            </div>
            <div v-if="s.titles && s.titles.length" class="tl-titles">
              {{ s.titles.join(' · ') }}
            </div>
          </div>
        </div>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="timeline" :size="88" /></span>
        <span class="empty-title">这一天还没有记录</span>
        <span class="empty-desc">切换到有数据的日期，或保持后台记录</span>
      </div>
    </div>

    <!-- 明细视图 -->
    <div v-else class="tl-list raw">
      <template v-if="records.length">
        <div v-for="(r, i) in records" :key="r.id || i" class="raw-row">
          <span class="raw-time">{{ hm(r.timestamp) }}</span>
          <span class="raw-app">
            {{ r.processName }}
            <span v-if="r.source === 'manual'" class="raw-badge">手工</span>
          </span>
          <span class="raw-title" :title="r.windowTitle">{{ r.windowTitle || '—' }}</span>
          <span class="raw-dur">{{ r.durationMs ? fmt(r.durationMs) : '' }}</span>
        </div>
      </template>
      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="search" :size="88" /></span>
        <span class="empty-title">没有明细</span>
      </div>
    </div>
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';
import { colorForCategory } from '../styles/palette.js';

const { ipcRenderer } = require('electron');

export default {
  name: 'TimelineView',
  components: { Icon, DateNav, EmptyIllustration },
  props: {
    report: { type: Object, required: true },
    activities: { type: Array, default: () => [] },
    selectedDate: { type: String, required: true },
    datesWithData: { type: Set, default: () => new Set() },
    focusTarget: { type: Object, default: null },
    theme: { type: String, default: 'dark' }
  },
  emits: ['update:selectedDate', 'shift', 'today', 'refresh',
    'manual-error', 'focus-consumed', 'focus-missed'],
  data() {
    return {
      highlightIndex: -1,
      mode: 'sessions',
      manualOpen: false,
      manualTime: '09:00',
      manualDuration: 30,
      manualApp: '手工记录',
      manualTitle: '',
      manualCategory: '沟通协作',
      savingManual: false,
      categories: ['沟通协作', '文档写作', '开发编码', 'AI 助手', '任务与效率', '浏览检索', '影音娱乐', '文件系统', '其他']
    };
  },
  computed: {
    sessions() {
      return (this.report && this.report.sessions) || [];
    },
    records() {
      return this.activities || [];
    }
  },
  // 四个视图用 v-if 渲染且无 keep-alive，切进来必然是新实例，挂载后定位即可
  mounted() {
    this.$nextTick(() => this.consumeFocus());
  },
  beforeUnmount() {
    if (this._focusTimer) clearTimeout(this._focusTimer);
  },
  methods: {
    consumeFocus() {
      const t = this.focusTarget;
      // 先让 App 清空目标，否则之后从导航进入时间线会重复滚动
      this.$emit('focus-consumed');
      if (!t) return;

      const sessions = this.sessions;
      if (!sessions.length) {
        this.scrollTop();
        this.$emit('focus-missed');
        return;
      }
      if (t.minutes === null || t.minutes === undefined) {
        this.scrollTop();
        return;
      }

      // 命中时间落在会话区间内优先，否则取区间端点距离最近的一条
      let best = 0;
      let bestDist = Infinity;
      sessions.forEach((s, i) => {
        const a = new Date(s.start);
        const b = new Date(s.end);
        const sm = a.getHours() * 60 + a.getMinutes();
        let em = b.getHours() * 60 + b.getMinutes();
        if (em <= sm) em = sm + Math.max(1, Math.round((s.durationMs || 0) / 60000));
        const dist = (t.minutes >= sm && t.minutes < em)
          ? 0
          : Math.min(Math.abs(t.minutes - sm), Math.abs(t.minutes - em));
        if (dist < bestDist) { bestDist = dist; best = i; }
      });

      this.highlightIndex = best;
      const row = this.$el.querySelector(`.tl-row[data-idx="${best}"]`);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (row) row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      else this.scrollTop();

      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => { this.highlightIndex = -1; }, 2400);
    },
    scrollTop() {
      const sc = this.$el.closest('.content') || document.querySelector('.content');
      if (sc) sc.scrollTop = 0;
    },
    toggleManual() {
      this.manualOpen = !this.manualOpen;
      if (this.manualOpen) {
        // 默认填当前时间，向上取整到 5 分钟
        const now = new Date();
        const m = Math.floor(now.getMinutes() / 5) * 5;
        this.manualTime = `${String(now.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    },

    async submitManual() {
      const payload = {
        date: this.selectedDate,
        startTime: this.manualTime,
        durationMin: this.manualDuration,
        app: this.manualApp,
        title: this.manualTitle,
        category: this.manualCategory
      };
      this.savingManual = true;
      try {
        const res = await ipcRenderer.invoke('add-manual-record', payload);
        if (res && res.ok) {
          this.manualOpen = false;
          this.manualTitle = '';
          this.$emit('refresh');
        } else {
          this.$emit('manual-error', (res && res.error) || '保存失败');
        }
      } catch (error) {
        this.$emit('manual-error', error.message);
      } finally {
        this.savingManual = false;
      }
    },

    colorOf(name) {
      return colorForCategory(this.theme, name);
    },
    softColor(name) {
      const hex = this.colorOf(name);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, 0.14)`;
    },
    fmt(ms) {
      if (!ms || ms <= 0) return '0m';
      const totalMin = Math.round(ms / 60000);
      if (totalMin < 1) return '<1m';
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h === 0) return `${m}m`;
      if (m === 0) return `${h}h`;
      return `${h}h${m}m`;
    },
    hm(iso) {
      if (!iso) return '--:--';
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
};
</script>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  padding: var(--sp-4);
  gap: var(--sp-3);
}

.tl-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 分段控件 */
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
}

.seg-btn {
  height: 22px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.seg-btn:hover {
  color: var(--text-secondary);
}

.seg-btn.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.tl-summary {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.tl-stat b {
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

.tl-sep {
  opacity: 0.5;
}

/* 补记 */
.manual-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-subtle);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}

.manual-toggle:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.manual-toggle.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}

.manual-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
}

.manual-fields {
  display: flex;
  gap: var(--sp-2);
}

.mf {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mf > span {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.mf input {
  height: 28px;
  padding: 0 8px;
  font-size: var(--fs-11);
}

.mf select {
  height: 28px;
  padding: 0 24px 0 8px;
  font-size: var(--fs-11);
}

.mf.narrow {
  width: 66px;
  flex: 0 0 auto;
}

.mf.grow {
  flex: 1;
}

.mf.full {
  width: 100%;
}

.manual-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.manual-hint {
  flex: 1;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.tl-manual,
.raw-badge {
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
}

.raw-badge {
  margin-left: 4px;
  font-size: 9px;
}

.tl-list {
  display: flex;
  flex-direction: column;
}

/* 会话行 */
.tl-row {
  display: grid;
  grid-template-columns: 40px 14px 1fr;
  gap: var(--sp-2);
  padding-bottom: var(--sp-3);
}

.tl-row.is-focus {
  background: var(--accent-soft);
  border-radius: var(--r-sm);
  box-shadow: inset 0 0 0 1px var(--accent-border);
  animation: tl-focus-in var(--dur-2) var(--ease);
}

@keyframes tl-focus-in {
  from { opacity: 0.35; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .tl-row.is-focus { animation: none; }
}

.tl-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  padding-top: 1px;
}

.tl-start {
  font-size: var(--fs-11);
  font-family: var(--font-mono);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.tl-end {
  font-size: var(--fs-10);
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.tl-axis {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 4px;
}

.tl-node {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  box-shadow: 0 0 0 2px var(--bg-canvas);
}

.tl-line {
  flex: 1;
  width: 1px;
  background: var(--border-default);
  margin-top: 3px;
}

.tl-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tl-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.tl-app {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl-dur {
  flex: 0 0 auto;
  font-size: var(--fs-11);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.tl-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.cat-chip {
  padding: 1px 7px;
  border-radius: var(--r-full);
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
}

.tl-warn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-10);
  color: var(--warning);
}

.tl-titles {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 明细 */
.raw-row {
  display: grid;
  grid-template-columns: 40px 78px 1fr auto;
  gap: var(--sp-2);
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-11);
}

.raw-time {
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.raw-app {
  color: var(--text-primary);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.raw-title {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.raw-dur {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
</style>
