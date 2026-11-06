<template>
  <div class="today">
    <div class="today-head">
      <DateNav
        :selected-date="selectedDate"
        :dates-with-data="datesWithData"
        @update:selected-date="$emit('select-date', $event)"
        @shift="$emit('shift-date', $event)"
        @today="$emit('go-today')"
      />
      <button class="focus-launch" @click="$emit('start-focus')">
        <Icon name="zen" :size="14" />
        <span>开始专注</span>
      </button>
    </div>

    <!-- 首屏：核心数字 + 一天的时间带 -->
    <section class="hero card">
      <div class="hero-top">
        <div class="hero-main">
          <div class="hero-label">
            <span class="live-dot"></span>
            有效工作
            <span class="hero-date">{{ isToday ? '今天' : report.date }}</span>
          </div>
          <div class="hero-value">
            {{ heroHours }}<span class="hero-unit">h</span>
            <span class="hero-min">{{ heroMinutes }}</span><span class="hero-unit">m</span>
          </div>
          <div class="hero-sub">
            <span v-if="hasData">
              统计区间 {{ hm(report.stats.firstAt) }} – {{ hm(report.stats.lastAt) }}
              · 覆盖率 {{ pct(report.stats.coverage) }}
            </span>
            <span v-else>还没有记录</span>
          </div>
        </div>

        <div class="hero-side">
          <div class="mini-stat">
            <span class="mini-value">{{ report.stats.uniqueApps || 0 }}</span>
            <span class="mini-label">应用</span>
          </div>
          <div class="mini-stat">
            <span class="mini-value">{{ report.stats.sessionCount || 0 }}</span>
            <span class="mini-label">片段</span>
          </div>
          <div class="mini-stat">
            <span class="mini-value">{{ idleText }}</span>
            <span class="mini-label">空档</span>
          </div>
        </div>
      </div>

      <EmptyIllustration
        v-if="!hasData"
        class="hero-illustration"
        variant="clock"
        :size="120"
      />

      <div class="day-band">
        <div class="band-head">
          <span class="band-title">一天的时间分布</span>
          <span class="band-legend">15 分钟一格 · 颜色对应分类</span>
        </div>
        <div class="band-track">
          <span
            v-for="(cell, i) in bandCells"
            :key="i"
            class="band-cell"
            :class="{ 'is-empty': !cell.hasData }"
            :style="{ background: cell.color, opacity: cell.opacity }"
            :title="cell.title"
            :aria-label="cell.title"
            role="button"
            @click="onBandClick(i, cell)"
          ></span>
          <span v-if="isToday" class="band-now" :style="{ left: nowPercent + '%' }"></span>
        </div>
        <div class="band-ticks">
          <span v-for="t in bandTicks" :key="t.label" :style="{ left: t.left + '%' }">{{ t.label }}</span>
        </div>
      </div>
    </section>

    <!-- AI：能力开启后才出现在这里；关闭时只是一行提示 -->
    <div class="ai-row">
    <AiPanel
      :enabled="aiEnabled"
      :ready="aiReady"
      :summaries="summaries"
      :generating="generatingSummary"
      :selected-date="selectedDate"
      :has-data="hasData"
      :provider="aiProvider"
      @generate="$emit('generate-summary')"
      @open-settings="$emit('open-ai-settings')"
    />
    </div>

    <!-- 近 12 周活跃度 -->
    <section class="card heat-card">
      <div class="card-head">
        <span class="card-title">活跃度 · 12 周</span>
        <span class="head-note">{{ selectedDate }} · {{ heatSummary }}</span>
      </div>
      <ActivityHeatmap
        :days="heatDaily"
        :selected-date="selectedDate"
        :range-from="heatFrom"
        :range-to="heatTo"
        :can-go-forward="heatCanGoForward"
        @select-date="$emit('select-date', $event)"
        @shift-range="$emit('shift-range', $event)"
        @pick-month="$emit('pick-month', $event)"
        @heat-today="$emit('heat-today')"
      />
    </section>

    <!-- 当前会话 -->
    <section v-if="current" class="session card" :class="{ idle: current.idle }">
      <div class="session-icon">
        <Icon :name="current.idle ? 'moon' : 'activity'" :size="15" />
      </div>
      <div class="session-body">
        <div class="session-app">
          {{ current.idle ? '当前空闲' : current.app }}
          <span class="session-time">{{ elapsedText }}</span>
        </div>
        <div class="session-title">{{ current.idle ? '已有一段时间没有键鼠操作' : (current.title || '—') }}</div>
      </div>
      <span class="session-badge" :class="{ live: !current.idle }">
        {{ current.idle ? '空档' : '进行中' }}
      </span>
    </section>

    <!-- 分类分布 -->
    <section class="card">
      <div class="card-head">
        <span class="card-title">时间构成</span>
        <span class="head-note">{{ catList.length }} 类</span>
      </div>

      <template v-if="hasData">
        <div class="stack">
          <div
            v-for="c in catList"
            :key="c.name"
            class="stack-seg"
            :style="{ width: (c.percent * 100).toFixed(2) + '%', background: colorOf(c.name) }"
            :title="`${c.name} ${fmt(c.durationMs)}`"
          ></div>
        </div>

        <ul class="cat-list">
          <li v-for="c in catList" :key="c.name" class="cat-row">
            <span class="cat-dot" :style="{ background: colorOf(c.name) }"></span>
            <span class="cat-name">{{ c.name }}</span>
            <span class="cat-bar">
              <span class="cat-bar-fill" :style="{ width: (c.percent * 100).toFixed(1) + '%', background: colorOf(c.name) }"></span>
            </span>
            <span class="cat-time">{{ fmt(c.durationMs) }}</span>
            <span class="cat-pct">{{ pct(c.percent) }}</span>
          </li>
        </ul>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="chart" :size="88" /></span>
        <span class="empty-title">暂无数据</span>
        <span class="empty-desc">保持记录，稍后这里会显示时间构成</span>
      </div>
    </section>

    <!-- 应用排行 -->
    <section class="card">
      <div class="card-head">
        <span class="card-title">应用排行</span>
        <span class="head-note">自动采集 · Top {{ rankedApps.length }}</span>
      </div>

      <template v-if="rankedApps.length">
        <ul class="app-list">
          <li v-for="(a, i) in rankedApps" :key="a.processName" class="app-row">
            <span class="app-rank">{{ i + 1 }}</span>
            <span class="app-main">
              <span class="app-name-row">
                <span class="app-name" :title="a.processName">{{ a.processName }}</span>
                <span class="app-time">{{ fmt(a.durationMs) }}</span>
              </span>
              <span class="app-bar">
                <span
                  class="app-bar-fill"
                  :style="{ width: (a.durationMs / maxAppMs * 100).toFixed(1) + '%', background: colorOf(a.category) }"
                ></span>
              </span>
              <span
                v-if="a.titles.length && a.titles[0] !== a.processName"
                class="app-titles"
                :title="a.titles.join(' / ')"
              >{{ a.titles[0] }}</span>
            </span>
          </li>
        </ul>
        <p v-if="manualCount" class="manual-note">{{ manualCount }} 条手工补记未计入应用排行，可在时间线查看</p>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="grid" :size="88" /></span>
        <span class="empty-title">暂无应用记录</span>
      </div>
    </section>

    <!-- 数据质量提示 -->
    <section v-if="report.dataNotes && report.dataNotes.length" class="card note-card">
      <div class="note-head">
        <Icon name="alert" :size="14" />
        <span>数据说明</span>
      </div>
      <ul class="note-list">
        <li v-for="(n, i) in report.dataNotes" :key="i">{{ n }}</li>
      </ul>
    </section>

    <!-- 专注与随手记 -->
    <section v-if="hasFocus" class="card">
      <div class="card-head">
        <span class="card-title">专注与随手记</span>
        <span class="head-note">{{ focus.sessions.length }} 次专注 · {{ focus.notes.length }} 条记录</span>
      </div>

      <ul v-if="focus.sessions.length" class="focus-list">
        <li v-for="(s, i) in focus.sessions" :key="'s' + i" class="focus-row">
          <Icon name="zen" :size="13" />
          <span class="focus-text">{{ s.focusText || '未命名专注' }}</span>
          <span class="focus-time">{{ fmt(s.durationMs) }}</span>
        </li>
      </ul>

      <ul v-if="focus.notes.length" class="note-items">
        <li v-for="(n, i) in focus.notes" :key="'n' + i" class="note-item">
          <span class="note-time">{{ hm(n.time) }}</span>
          <span class="note-text">{{ n.text }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import ActivityHeatmap from '../components/ActivityHeatmap.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';
import AiPanel from '../components/AiPanel.vue';
import { colorForCategory } from '../styles/palette.js';

export default {
  name: 'TodayView',
  components: { Icon, DateNav, ActivityHeatmap, EmptyIllustration, AiPanel },
  props: {
    report: { type: Object, required: true },
    recorder: { type: Object, default: null },
    isToday: { type: Boolean, default: true },
    heatDaily: { type: Array, default: () => [] },
    selectedDate: { type: String, default: '' },
    datesWithData: { type: Set, default: () => new Set() },
    theme: { type: String, default: 'dark' },
    heatFrom: { type: String, default: '' },
    heatTo: { type: String, default: '' },
    heatCanGoForward: { type: Boolean, default: false },
    // AI 是能力层：关闭时这里只显示一条提示，开启后才变成一张卡片
    summaries: { type: Array, default: () => [] },
    aiEnabled: { type: Boolean, default: false },
    aiReady: { type: Boolean, default: false },
    aiProvider: { type: String, default: '' },
    generatingSummary: { type: Boolean, default: false }
  },
  emits: ['jump-to-time', 'select-date', 'shift-date', 'go-today',
    'shift-range', 'pick-month', 'heat-today', 'start-focus',
    'generate-summary', 'open-ai-settings'],
  data() {
    return { tick: 0, timer: null };
  },
  computed: {
    /** 时间构成用 7 个展示分组；后端没给分组时退回细分分类 */
    catList() {
      const r = this.report || {};
      return (r.categoriesGrouped && r.categoriesGrouped.length ? r.categoriesGrouped : r.categories) || [];
    },
    // 把 report.sessions 摊到 24h / 96 格（15 分钟一格），取每格的主导分类着色
    bandCells() {
      const cells = Array.from({ length: 96 }, () => ({ total: 0, byCat: {} }));
      const sessions = (this.report && this.report.sessions) || [];
      for (const s of sessions) {
        const start = new Date(s.start);
        const end = new Date(s.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        const a = start.getHours() * 60 + start.getMinutes();
        let b = end.getHours() * 60 + end.getMinutes();
        if (b <= a) b = Math.min(1440, a + Math.max(1, Math.round((s.durationMs || 0) / 60000)));
        b = Math.min(1440, b);
        const cat = s.category || '其他';
        for (let idx = Math.floor(a / 15); idx <= Math.floor((b - 1) / 15) && idx < 96; idx++) {
          if (idx < 0) continue;
          const from = Math.max(a, idx * 15);
          const to = Math.min(b, (idx + 1) * 15);
          const mins = Math.max(0, to - from);
          if (!mins) continue;
          cells[idx].total += mins;
          cells[idx].byCat[cat] = (cells[idx].byCat[cat] || 0) + mins;
        }
      }
      return cells.map((cell, i) => {
        const top = Object.entries(cell.byCat).sort((x, y) => y[1] - x[1])[0];
        const mins = i * 15;
        const at = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
        const common = { minutes: mins, hasData: !!top };
        if (!top) {
          return { ...common, color: 'var(--bg-inset)', opacity: 1, title: `${at} · 无记录` };
        }
        return {
          ...common,
          color: this.colorOf(top[0]),
          opacity: (0.42 + Math.min(1, cell.total / 15) * 0.58).toFixed(2),
          title: `${at} · ${top[0]} ${Math.round(cell.total)} 分钟`
        };
      });
    },
    bandTicks() {
      return [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
        label: `${String(h).padStart(2, '0')}:00`,
        left: (h / 24 * 100).toFixed(2)
      }));
    },
    nowPercent() {
      void this.tick;
      const d = new Date();
      return ((d.getHours() * 60 + d.getMinutes()) / 1440 * 100).toFixed(2);
    },
    hasData() {
      return this.report && this.report.stats && this.report.stats.recordCount > 0;
    },
    heatSummary() {
      const days = this.heatDaily || [];
      const active = days.filter((d) => (d.trackedMs || 0) > 0).length;
      const total = days.reduce((s, d) => s + (d.trackedMs || 0), 0);
      return `${active} 天有记录 · 累计 ${Math.round(total / 3600000)}h`;
    },
    focus() {
      const f = (this.report && this.report.focus) || {};
      return {
        sessions: f.arhatSessions || f.sessions || [],
        notes: f.notes || []
      };
    },
    hasFocus() {
      return this.focus.sessions.length > 0 || this.focus.notes.length > 0;
    },
    heroHours() {
      return Math.floor(((this.report.stats.trackedMs || 0) / 3600000));
    },
    heroMinutes() {
      const m = Math.round(((this.report.stats.trackedMs || 0) % 3600000) / 60000);
      return String(m).padStart(2, '0');
    },
    idleText() {
      return this.fmt(this.report.stats.idleMs || 0);
    },
    // 手工补记的「事项名」被写进 app 字段，它不是应用，不进应用排行
    rankedApps() {
      return (this.report.apps || []).filter(a => !a.manual).slice(0, 6);
    },
    manualCount() {
      return (this.report.apps || []).filter(a => a.manual).length;
    },
    maxAppMs() {
      return this.rankedApps.length ? this.rankedApps[0].durationMs : 1;
    },
    current() {
      if (!this.recorder || !this.recorder.running || !this.isToday) return null;
      const c = this.recorder.current;
      if (!c) return null;
      // 用 since 本地算，避免依赖后端轮询频率
      const elapsed = Date.now() - new Date(c.since).getTime();
      return { ...c, elapsedMs: Math.max(elapsed, 0) };
    },
    elapsedText() {
      if (!this.current) return '';
      const total = Math.floor(this.current.elapsedMs / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }
  },
  mounted() {
    this.timer = setInterval(() => { this.tick += 1; }, 1000);
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    onBandClick(i, cell) {
      this.$emit('jump-to-time', {
        minutes: cell && Number.isFinite(cell.minutes) ? cell.minutes : i * 15,
        date: (this.report && this.report.date) || this.selectedDate
      });
    },
    colorOf(name) {
      return colorForCategory(this.theme, name);
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
    pct(n) {
      return `${Math.round((n || 0) * 100)}%`;
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
.today {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  align-items: start;
  gap: var(--sp-4);
  padding: var(--sp-5);
  width: 100%;
  /* 不再锁死 max-width：窗口拉宽时内容跟着重排，而不是两侧留白 */
}

.today > * {
  min-width: 0;
}

/* AI 面板横跨整行：它是一句结论，不该挤在某一列里 */
.today > .ai-row {
  grid-column: 1 / -1;
}

/* 顶部条：日期导航 + 专注入口 */
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.focus-launch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  color: var(--accent);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease), transform var(--dur-1) var(--ease),
    box-shadow var(--dur-1) var(--ease);
}

.focus-launch:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

/* 宽窗口：只有顶部条与主视觉跨满，其余所有区域一起并排 */
@media (min-width: 900px) {
  .today {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .today > .today-head,
  .today > .hero {
    grid-column: 1 / -1;
  }
}

/* 更宽时升到三列，热力图 / 时间构成 / 应用排行 / 会话 / 专注都能并排 */
@media (min-width: 1320px) {
  .today {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .today > .today-head,
  .today > .hero {
    grid-column: 1 / -1;
  }
}

/* Hero：首屏主视觉 */
.hero {
  padding: var(--sp-6);
  background:
    radial-gradient(520px 220px at 6% 0%,
      color-mix(in srgb, var(--accent) 15%, transparent), transparent 72%),
    linear-gradient(160deg,
      color-mix(in srgb, var(--bg-surface) 88%, #ffffff 12%),
      var(--bg-surface) 76%);
  border-color: color-mix(in srgb, var(--accent) 24%, var(--border-default));
}

.hero-top {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-5);
}

.hero-label {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--text-secondary);
  font-weight: var(--fw-medium);
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  flex: 0 0 auto;
}

.hero-date {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.hero-value {
  display: flex;
  align-items: baseline;
  gap: 1px;
  margin-top: 10px;
  font-size: var(--fs-56);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.04em;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}

.hero-min {
  margin-left: 6px;
  color: var(--text-secondary);
}

.hero-unit {
  font-size: var(--fs-20);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
  margin: 0 2px;
}

.hero-sub {
  margin-top: 8px;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.hero-side {
  display: flex;
  gap: var(--sp-5);
  padding-bottom: 4px;
}

.mini-stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.mini-stat + .mini-stat {
  padding-left: var(--sp-5);
}

.mini-stat + .mini-stat::before {
  content: "";
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 1px;
  background: var(--border-default);
}

.mini-value {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.mini-label {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.hero-illustration {
  display: flex;
  justify-content: center;
  margin-top: var(--sp-4);
  opacity: 0.9;
}

/* 24 小时时间带：借鉴 Rize / Toggl Timeline 的日色带 */
.day-band {
  margin-top: var(--sp-6);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-subtle);
}

.band-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.band-title {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.band-legend {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.band-track {
  position: relative;
  display: flex;
  gap: 1px;
  height: 34px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
}

.band-cell {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  cursor: pointer;
  transition: opacity var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease),
    background-color 420ms var(--ease);
}

.band-cell:hover {
  opacity: 1 !important;
  box-shadow: inset 0 0 0 1px var(--accent);
}

.band-cell.is-empty:hover {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.band-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--text-primary);
  box-shadow: 0 0 0 1px var(--bg-surface);
  pointer-events: none;
}

.band-ticks {
  position: relative;
  height: 18px;
  margin-top: 7px;
}

.band-ticks span {
  position: absolute;
  transform: translateX(-50%);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 当前会话 */
.session {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.session.idle {
  border-color: var(--border-subtle);
  background: var(--bg-surface);
}

.session-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  color: var(--accent);
  flex: 0 0 auto;
}

.session.idle .session-icon {
  color: var(--text-tertiary);
}

.session-body {
  flex: 1;
  min-width: 0;
}

.session-app {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.session-time {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.session-title {
  font-size: var(--fs-11);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

.session-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--r-full);
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
  background: var(--bg-inset);
  color: var(--text-tertiary);
}

.session-badge.live {
  background: var(--success-soft);
  color: var(--success);
}

/* 堆叠条 */
.head-note {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.stack {
  display: flex;
  height: 18px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
  gap: 2px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
}

.stack-seg {
  height: 100%;
  border-radius: 2px;
  transition: opacity var(--dur-1) var(--ease), background-color 420ms var(--ease);
}

.stack-seg:hover {
  opacity: 0.78;
}

/* 分类列表 */
.cat-list {
  list-style: none;
  margin: var(--sp-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cat-row {
  display: grid;
  grid-template-columns: 8px 74px 1fr auto 34px;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
}

.cat-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  transition: background-color 420ms var(--ease);
}

.cat-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat-bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  overflow: hidden;
}

.cat-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease), background-color 420ms var(--ease);
}

.cat-time {
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  font-weight: var(--fw-medium);
}

.cat-pct {
  text-align: right;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-11);
}

/* 应用列表 */
.app-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.app-row {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}

.app-rank {
  width: 16px;
  flex: 0 0 auto;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  padding-top: 1px;
}

.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.app-name-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.app-name {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-time {
  font-size: var(--fs-11);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.app-bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  overflow: hidden;
}

.app-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease), background-color 420ms var(--ease);
}

.app-titles {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manual-note {
  margin: var(--sp-3) 0 0;
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

/* 数据说明 */
.note-card {
  background: var(--bg-surface);
  border-color: var(--border-subtle);
}

.note-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-11);
  font-weight: var(--fw-semibold);
  color: var(--warning);
  margin-bottom: 6px;
}

.note-list {
  margin: 0;
  padding-left: 16px;
  font-size: var(--fs-11);
  color: var(--text-secondary);
  line-height: var(--lh-snug);
}

/* 专注 */
.focus-list,
.note-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.focus-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--accent);
}

.focus-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.focus-time {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.note-items {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

.note-item {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-11);
  line-height: var(--lh-snug);
}

.note-time {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  flex: 0 0 auto;
}

.note-text {
  color: var(--text-secondary);
}
</style>
