<template>
  <section class="card compare-card">
    <div class="card-head compare-head">
      <div class="compare-title">
        <span class="card-title">周期对比</span>
        <span class="head-note">{{ rangeLabel }}</span>
      </div>
      <div class="range-switch" role="group" aria-label="对比范围">
        <button v-for="n in modes" :key="n" :class="{ active: mode === n }" @click="mode = n">{{ n }} 天</button>
      </div>
    </div>

    <div v-if="loading" class="compare-empty">正在对比两个周期…</div>
    <div v-else-if="!hasAny" class="compare-empty">这两个周期都还没有记录</div>
    <template v-else>
      <div class="compare-metrics">
        <div class="metric">
          <span class="metric-label">记录时长</span>
          <strong>{{ fmt(cmp.totals.currentMs) }}</strong>
          <span class="metric-sub">上期 {{ fmt(cmp.totals.previousMs) }}</span>
          <span class="delta-chip" :class="deltaTone">{{ deltaText }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">日均（有记录日）</span>
          <strong>{{ fmt(cmp.avgPerActiveDay.current) }}</strong>
          <span class="metric-sub">上期 {{ fmt(cmp.avgPerActiveDay.previous) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">有记录天数</span>
          <strong>{{ cmp.activeDays.current }}<small> 天</small></strong>
          <span class="metric-sub">上期 {{ cmp.activeDays.previous }} 天</span>
        </div>
      </div>

      <div v-if="!cmp.hasCurrent" class="compare-warn">本期还没有记录，下面只显示上期的分布。</div>

      <div class="compare-section">
        <div class="section-head">
          <span class="section-label">逐日对比</span>
          <span class="section-legend"><i class="lg-cur"></i>本期<i class="lg-prev"></i>上期</span>
        </div>
        <div class="day-chart" :class="{ dense: mode === 30 }">
          <div v-for="day in dayBars" :key="day.date" class="day-col" :title="day.title">
            <div class="day-bars">
              <i class="bar bar-prev" :style="{ height: day.previousHeight + '%' }"></i>
              <i class="bar bar-cur" :style="{ height: day.currentHeight + '%' }"></i>
            </div>
            <span class="day-label">{{ day.label }}</span>
          </div>
        </div>
      </div>

      <div v-if="categoryRows.length" class="compare-section">
        <div class="section-head">
          <span class="section-label">变化最大的分类</span>
          <span class="section-hint">按变化绝对值排序</span>
        </div>
        <div class="diff-list">
          <div v-for="item in categoryRows" :key="item.name" class="diff-row">
            <span class="diff-name" :title="item.name">{{ item.name }}</span>
            <div class="diff-track">
              <span class="diff-axis"></span>
              <i class="diff-bar" :class="item.direction" :style="item.style"></i>
            </div>
            <span class="diff-value" :class="item.direction">{{ fmtDelta(item.deltaMs) }}</span>
          </div>
        </div>
      </div>

      <div v-if="projectRows.length" class="compare-section">
        <div class="section-head">
          <span class="section-label">项目投入变化</span>
        </div>
        <ul class="project-list">
          <li v-for="item in projectRows" :key="item.name">
            <span class="project-name" :title="item.name">{{ item.name }}</span>
            <span class="project-nums">{{ fmt(item.currentMs) }} <em>／ 上期 {{ fmt(item.previousMs) }}</em></span>
            <span class="diff-value" :class="item.direction">{{ fmtDelta(item.deltaMs) }}</span>
          </li>
        </ul>
      </div>

      <p class="compare-note">{{ summary }}</p>
    </template>
  </section>
</template>

<script>
import { buildComparison } from '../utils/compareRange.mjs';
import { colorForCategory } from '../styles/palette.js';

const MODES = [7, 30];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_MS = 86400000;
function dateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default {
  name: 'CompareCard',
  props: {
    selectedDate: { type: String, required: true },
    theme: { type: String, default: 'dark' }
  },
  data() {
    return { mode: 7, modes: MODES, loading: false, current: null, previous: null, requestId: 0 };
  },
  computed: {
    /** 两个窗口都按「含今天在内往前数 N 天」计算，上期紧邻本期之前 */
    windows() {
      const end = new Date(`${this.selectedDate}T00:00:00`);
      if (Number.isNaN(end.getTime())) return null;
      const start = new Date(end.getTime() - (this.mode - 1) * DAY_MS);
      const previousEnd = new Date(start.getTime() - DAY_MS);
      const previousStart = new Date(previousEnd.getTime() - (this.mode - 1) * DAY_MS);
      return {
        from: dateStr(start), to: dateStr(end),
        previousFrom: dateStr(previousStart), previousTo: dateStr(previousEnd)
      };
    },
    cmp() {
      return buildComparison({
        current: this.current,
        previous: this.previous,
        ...(this.windows || {})
      });
    },
    hasAny() { return this.cmp.hasCurrent || this.cmp.hasPrevious; },
    rangeLabel() {
      const w = this.windows;
      if (!w) return '';
      return `${w.from} 至 ${w.to} · 对比 ${w.previousFrom} 至 ${w.previousTo}`;
    },
    deltaTone() {
      if (!this.cmp.hasPrevious) return 'flat';
      if (Math.abs(this.cmp.totals.deltaMs) < 60000) return 'flat';
      return this.cmp.totals.deltaMs > 0 ? 'up' : 'down';
    },
    deltaText() {
      const { currentMs, previousMs, deltaMs } = this.cmp.totals;
      if (!previousMs) return currentMs > 0 ? '上期无记录' : '无对照';
      if (Math.abs(deltaMs) < 60000) return '与上期持平';
      const ratio = Math.round(Math.abs(deltaMs) / previousMs * 100);
      return `${deltaMs > 0 ? '+' : '-'}${ratio}%`;
    },
    dayBars() {
      const days = this.cmp.days;
      if (!days.length) return [];
      const max = Math.max(1, ...days.map(d => Math.max(d.currentMs, d.previousMs)));
      return days.map((day, index) => {
        const date = new Date(`${day.date}T00:00:00`);
        const weekday = WEEKDAYS[date.getDay()];
        const label = this.mode === 7 ? weekday : (index % 5 === 0 ? day.date.slice(5).replace('-', '/') : '');
        return {
          date: day.date,
          label,
          currentHeight: Math.round(day.currentMs / max * 100),
          previousHeight: Math.round(day.previousMs / max * 100),
          title: `${day.date} ${weekday}：本期 ${this.fmt(day.currentMs)}，上期 ${this.fmt(day.previousMs)}`
        };
      });
    },
    categoryRows() {
      // 5 分钟以内的变化是录制粒度带来的噪声，列出来只会分散注意力
      const items = this.cmp.categories.filter(x => Math.abs(x.deltaMs) >= 300000).slice(0, 6);
      const max = Math.max(1, ...items.map(x => Math.abs(x.deltaMs)));
      return items.map(item => {
        const percent = Math.abs(item.deltaMs) / max * 50;
        const color = colorForCategory(this.theme, item.name);
        const style = item.deltaMs >= 0
          ? { left: '50%', width: `${percent}%`, background: color }
          : { right: '50%', width: `${percent}%`, background: color, opacity: 0.45 };
        return { ...item, direction: item.deltaMs >= 0 ? 'up' : 'down', style };
      });
    },
    projectRows() {
      return this.cmp.projects
        .filter(item => item.deltaMs !== 0)
        .slice(0, 4)
        .map(item => ({ ...item, direction: item.deltaMs >= 0 ? 'up' : 'down' }));
    },
    summary() {
      const { currentMs, previousMs, deltaMs } = this.cmp.totals;
      if (!previousMs && !currentMs) return '两个周期都没有记录，暂时无法对比。';
      if (!previousMs) return `上期没有记录，本期为 ${this.fmt(currentMs)}；有上期数据后这里会给出差值。`;
      if (!currentMs) return `本期还没有记录，上期为 ${this.fmt(previousMs)}。`;
      if (Math.abs(deltaMs) < 60000) {
        return `两期记录时长基本持平（各约 ${this.fmt(currentMs)}），变化主要在结构上。`;
      }
      const parts = [`本期比上期${deltaMs > 0 ? '多' : '少'}记录 ${this.fmt(Math.abs(deltaMs))}（${this.deltaText}）`];
      const up = this.cmp.categories.filter(x => x.deltaMs > 0).sort((a, b) => b.deltaMs - a.deltaMs)[0];
      const down = this.cmp.categories.filter(x => x.deltaMs < 0).sort((a, b) => a.deltaMs - b.deltaMs)[0];
      if (up) parts.push(`最多的是「${up.name}」增加 ${this.fmt(up.deltaMs)}`);
      if (down) parts.push(`「${down.name}」减少 ${this.fmt(Math.abs(down.deltaMs))}`);
      return `${parts.join('，')}。`;
    }
  },
  watch: {
    selectedDate: { immediate: true, handler() { this.load(); } },
    mode() { this.load(); }
  },
  methods: {
    fmt(ms) {
      const minutes = Math.round((Number(ms) || 0) / 60000);
      if (minutes < 60) return `${minutes} 分钟`;
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
    },
    fmtDelta(ms) {
      // 紧凑格式：+13h25m，双向条右侧空间有限，长中文会换行
      const minutes = Math.round(Math.abs(Number(ms) || 0) / 60000);
      const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
      if (minutes < 60) return `${sign}${minutes}m`;
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return `${sign}${h}h${m ? `${m}m` : ''}`;
    },
    async load() {
      const w = this.windows;
      if (!w) { this.current = null; this.previous = null; return; }
      const id = ++this.requestId;
      this.loading = true;
      try {
        const { ipcRenderer } = require('electron');
        const [current, previous] = await Promise.all([
          ipcRenderer.invoke('get-range-analytics', { from: w.from, to: w.to }),
          ipcRenderer.invoke('get-range-analytics', { from: w.previousFrom, to: w.previousTo })
        ]);
        if (id !== this.requestId) return;
        this.current = current?.ok ? current.report : null;
        this.previous = previous?.ok ? previous.report : null;
      } catch (_) {
        if (id === this.requestId) { this.current = null; this.previous = null; }
      } finally {
        if (id === this.requestId) this.loading = false;
      }
    }
  }
};
</script>

<style scoped>
.compare-card { grid-column: 1 / -1; }
.compare-head { align-items: flex-start; }
.compare-title { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.range-switch { padding: 2px; border-radius: 999px; background: var(--bg-inset); }
.range-switch button { border: 0; padding: 4px 10px; border-radius: 999px; background: transparent; color: var(--text-tertiary); font-size: var(--fs-11); cursor: pointer; }
.range-switch button.active { background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-sm); }

.compare-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); }
.metric { display: grid; gap: 2px; padding: var(--sp-3); border-radius: var(--r-sm); background: var(--bg-inset); }
.metric-label { color: var(--text-secondary); font-size: var(--fs-11); }
.metric strong { font-size: var(--fs-20); font-weight: var(--fw-semibold); color: var(--text-primary); line-height: var(--lh-tight); }
.metric strong small { font-size: var(--fs-11); color: var(--text-tertiary); font-weight: var(--fw-normal); }
.metric-sub { color: var(--text-tertiary); font-size: var(--fs-10); }
.delta-chip { justify-self: start; margin-top: 4px; padding: 2px 7px; border-radius: var(--r-full); font-size: var(--fs-10); }
.delta-chip.up { color: var(--accent); background: var(--accent-soft); }
.delta-chip.down { color: var(--text-secondary); background: var(--bg-active); }
.delta-chip.flat { color: var(--text-tertiary); background: var(--bg-active); }

.compare-warn { margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--warning-soft); color: var(--text-secondary); font-size: var(--fs-11); }

.compare-section { margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--border-subtle); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
.section-label { color: var(--text-secondary); font-size: var(--fs-11); font-weight: var(--fw-semibold); }
.section-hint { color: var(--text-tertiary); font-size: var(--fs-10); }
.section-legend { display: flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: var(--fs-10); }
.section-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.lg-cur { background: var(--accent); }
.lg-prev { margin-left: 8px; background: var(--border-strong); }

.day-chart { display: flex; align-items: end; gap: 4px; height: 104px; margin-top: var(--sp-3); }
.day-col { display: flex; flex: 1; min-width: 0; height: 100%; flex-direction: column; justify-content: end; align-items: center; gap: 4px; }
.day-bars { display: flex; align-items: end; justify-content: center; gap: 2px; width: 100%; height: 82px; }
.bar { display: block; width: min(9px, 42%); min-height: 1px; border-radius: 2px 2px 0 0; }
.bar-cur { background: var(--accent); }
.bar-prev { background: var(--border-strong); }
.day-label { min-height: 12px; white-space: nowrap; font-size: 9px; color: var(--text-tertiary); }
.day-chart.dense .day-bars { gap: 1px; }
.day-chart.dense .bar { width: min(5px, 45%); }

.diff-list { display: grid; gap: 6px; margin-top: var(--sp-3); }
.diff-row { display: grid; grid-template-columns: 92px 1fr 78px; align-items: center; gap: var(--sp-3); }
.diff-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: var(--fs-11); }
.diff-track { position: relative; height: 8px; border-radius: 4px; background: var(--bg-inset); }
.diff-axis { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--border-default); }
.diff-bar { position: absolute; top: 0; height: 8px; border-radius: 3px; }
.diff-value { text-align: right; font-size: var(--fs-11); font-variant-numeric: tabular-nums; }
.diff-value.up { color: var(--text-primary); }
.diff-value.down { color: var(--text-tertiary); }

.project-list { margin: var(--sp-3) 0 0; padding: 0; list-style: none; }
.project-list li { display: grid; grid-template-columns: 1fr auto 78px; align-items: center; gap: var(--sp-3); padding: 5px 0; border-bottom: 1px solid var(--border-subtle); font-size: var(--fs-11); }
.project-list li:last-child { border-bottom: 0; }
.project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.project-nums { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.project-nums em { color: var(--text-tertiary); font-style: normal; }

.compare-note { margin: var(--sp-4) 0 0; color: var(--text-tertiary); font-size: var(--fs-10); line-height: var(--lh-snug); }
.compare-empty { padding: var(--sp-6); text-align: center; color: var(--text-tertiary); font-size: var(--fs-11); }

@media (max-width: 700px) {
  .compare-metrics { grid-template-columns: 1fr; }
  .diff-row { grid-template-columns: 74px 1fr 66px; }
  .project-list li { grid-template-columns: 1fr auto; }
  .project-list li .diff-value { grid-column: 2; }
  .day-chart { height: 88px; }
  .day-bars { height: 68px; }
  .day-label { font-size: 8px; }
}
</style>
