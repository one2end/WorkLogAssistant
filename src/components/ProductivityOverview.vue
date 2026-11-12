<template>
  <section class="card productivity-card">
    <div class="card-head productivity-head">
      <div>
        <span class="card-title">生产力趋势</span>
        <span class="head-note">{{ rangeLabel }} · 按活动价值归并</span>
      </div>
      <div class="range-switch" role="group" aria-label="统计范围">
        <button v-for="n in [7, 30]" :key="n" :class="{ active: days === n }" @click="days = n">{{ n }} 天</button>
      </div>
    </div>

    <div v-if="loading" class="overview-empty">正在整理活动趋势…</div>
    <div v-else-if="!hasData" class="overview-empty">这个范围还没有可统计的活动</div>
    <template v-else>
      <div class="pulse-row">
        <div class="pulse-score" :class="scoreTone">
          <strong>{{ score }}</strong><span>分</span>
          <small>生产力得分</small>
        </div>
        <div class="value-buckets">
          <div v-for="bucket in buckets" :key="bucket.id" class="value-bucket">
            <span><i :style="{ background: bucket.color }"></i>{{ bucket.label }}</span>
            <strong>{{ fmt(bucket.ms) }}</strong>
            <small>{{ pct(bucket.ms / totalMs) }}</small>
          </div>
        </div>
      </div>

      <div class="trend" :aria-label="`${rangeLabel}生产力趋势`">
        <div v-for="day in trendDays" :key="day.date" class="trend-day" :title="day.title">
          <div class="trend-column">
            <i v-for="part in day.parts" :key="part.id" :style="{ height: part.height + '%', background: part.color }"></i>
          </div>
          <span>{{ day.label }}</span>
        </div>
      </div>

      <div class="overview-foot">
        <span>{{ qualityText }}</span>
        <button class="btn btn-ghost btn-sm" @click="$emit('open-settings')">调整识别与分级</button>
      </div>
    </template>
  </section>
</template>

<script>
import { ipc } from '../utils/ipc.mjs';
const LEVELS = {
  productive: { label: '积极', color: '#3fa77a' },
  neutral: { label: '平稳', color: '#8391a7' },
  distracting: { label: '消耗', color: '#d46a6a' }
};

const PRODUCTIVE = new Set(['工作', '学习', '专注', '沟通协作', 'AI 助手', '开发编码', '文档写作', '任务与效率', '阅读']);
const DISTRACTING = new Set(['娱乐', '影音娱乐', '游戏']);
const GROUPS = {
  '沟通协作': '工作', 'AI 助手': '工作', '开发编码': '工作', '文档写作': '工作',
  '任务与效率': '工作', '浏览检索': '工作', '文件系统': '工作', '系统工具': '工作',
  '阅读': '学习', '生活事务': '生活', '影音娱乐': '娱乐', '游戏': '娱乐', '空档': '其他'
};

export default {
  name: 'ProductivityOverview',
  props: {
    selectedDate: { type: String, required: true },
    config: { type: Object, default: () => ({}) }
  },
  emits: ['open-settings'],
  data() {
    return { days: 7, loading: false, range: null, requestId: 0 };
  },
  computed: {
    hasData() { return !!(this.range && this.totalMs > 0); },
    totalMs() { return Number(this.range?.stats?.trackedMs) || 0; },
    rangeLabel() { return this.days === 7 ? '近 7 天' : '近 30 天'; },
    levels() { return this.config.analysis?.productivityLevels || {}; },
    buckets() {
      const totals = { productive: 0, neutral: 0, distracting: 0 };
      for (const item of this.range?.categories || []) totals[this.levelOf(item.name)] += Number(item.durationMs) || 0;
      return Object.entries(LEVELS).map(([id, meta]) => ({ id, ...meta, ms: totals[id] }));
    },
    score() {
      if (!this.totalMs) return 0;
      const p = this.buckets.find(x => x.id === 'productive')?.ms || 0;
      const n = this.buckets.find(x => x.id === 'neutral')?.ms || 0;
      return Math.round((p + n * 0.5) / this.totalMs * 100);
    },
    scoreTone() { return this.score >= 70 ? 'good' : this.score >= 45 ? 'steady' : 'low'; },
    trendDays() {
      const byDate = new Map((this.range?.days || []).map(d => [d.date, d]));
      const end = new Date(`${this.selectedDate}T12:00:00`);
      const source = [];
      for (let offset = this.days - 1; offset >= 0; offset -= 1) {
        const date = new Date(end); date.setDate(date.getDate() - offset);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        source.push(byDate.get(key) || { date: key, trackedMs: 0, topCategories: [] });
      }
      const max = Math.max(1, ...source.map(d => Number(d.trackedMs) || 0));
      return source.map((day, index) => {
        const totals = { productive: 0, neutral: 0, distracting: 0 };
        for (const item of day.topCategories || []) totals[this.levelOf(item.name)] += Number(item.durationMs) || 0;
        const total = Math.max(1, Number(day.trackedMs) || 0);
        return {
          date: day.date,
          label: this.days === 7 || index % 5 === 0 ? day.date.slice(5).replace('-', '/') : '',
          title: `${day.date} · ${this.fmt(day.trackedMs)} · 得分 ${Math.round((totals.productive + totals.neutral * 0.5) / total * 100)}`,
          parts: ['distracting', 'neutral', 'productive'].map(id => ({
            id, color: LEVELS[id].color, height: totals[id] / max * 100
          }))
        };
      });
    },
    qualityText() {
      const unknown = (this.range?.categories || []).filter(x => ['其他', '空档'].includes(x.name)).reduce((s, x) => s + (Number(x.durationMs) || 0), 0);
      const ratio = this.totalMs ? unknown / this.totalMs : 0;
      if (ratio >= 0.2) return `有 ${this.pct(ratio)} 活动尚未准确识别，建议补充窗口关键词规则`;
      if (ratio >= 0.08) return `有 ${this.pct(ratio)} 活动待校准，识别结果会随手工确认改进`;
      return '活动识别较稳定；短暂切换已按连续活动合并';
    }
  },
  watch: {
    selectedDate: { immediate: true, handler() { this.load(); } },
    days() { this.load(); }
  },
  methods: {
    levelOf(category) {
      const configured = this.levels[category];
      if (LEVELS[configured]) return configured;
      const group = GROUPS[category] || this.config.analysis?.customCategories?.find(c => (c.key || c.name) === category)?.group || category;
      if (LEVELS[this.levels[group]]) return this.levels[group];
      if (PRODUCTIVE.has(group) || PRODUCTIVE.has(category)) return 'productive';
      if (DISTRACTING.has(group) || DISTRACTING.has(category)) return 'distracting';
      return 'neutral';
    },
    async load() {
      const id = ++this.requestId;
      this.loading = true;
      const to = new Date(`${this.selectedDate}T12:00:00`);
      const from = new Date(to);
      from.setDate(from.getDate() - this.days + 1);
      const dateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      try {
        const res = await ipc.invoke('get-range-analytics', { from: dateStr(from), to: dateStr(to) });
        if (id === this.requestId) this.range = res?.ok ? res.report : null;
      } catch (_) {
        if (id === this.requestId) this.range = null;
      } finally {
        if (id === this.requestId) this.loading = false;
      }
    },
    fmt(ms) {
      const minutes = Math.round((Number(ms) || 0) / 60000);
      if (minutes < 60) return `${minutes}m`;
      const h = Math.floor(minutes / 60); const m = minutes % 60;
      return m ? `${h}h${m}m` : `${h}h`;
    },
    pct(n) { return `${Math.round((Number(n) || 0) * 100)}%`; }
  }
};
</script>

<style scoped>
.productivity-card { grid-column: 1 / -1; }
.productivity-head, .productivity-head > div { display: flex; align-items: center; gap: var(--sp-2); }
.productivity-head { justify-content: space-between; }
.range-switch { padding: 2px; border-radius: 999px; background: var(--bg-inset); }
.range-switch button { border: 0; padding: 4px 10px; border-radius: 999px; background: transparent; color: var(--text-tertiary); font-size: var(--fs-11); cursor: pointer; }
.range-switch button.active { background: var(--bg-elevated); color: var(--text-primary); box-shadow: var(--shadow-sm); }
.pulse-row { display: grid; grid-template-columns: 120px 1fr; gap: var(--sp-5); align-items: center; }
.pulse-score { display: grid; grid-template-columns: auto auto; align-items: baseline; justify-content: center; padding: var(--sp-4); border-radius: var(--r-md); background: var(--bg-inset); color: var(--text-secondary); }
.pulse-score strong { font-size: 32px; line-height: 1; color: var(--text-primary); }
.pulse-score.good strong { color: #3fa77a; }.pulse-score.low strong { color: #d46a6a; }
.pulse-score span { font-size: var(--fs-11); }.pulse-score small { grid-column: 1 / -1; margin-top: 6px; color: var(--text-tertiary); }
.value-buckets { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); }
.value-bucket { display: grid; grid-template-columns: 1fr auto; gap: 4px; padding: var(--sp-3); border: 1px solid var(--border-subtle); border-radius: var(--r-sm); }
.value-bucket span { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: var(--fs-11); }.value-bucket i { width: 7px; height: 7px; border-radius: 50%; }
.value-bucket strong { grid-column: 1; font-size: var(--fs-14); }.value-bucket small { grid-column: 2; grid-row: 2; color: var(--text-tertiary); }
.trend { display: flex; height: 116px; align-items: end; gap: 3px; margin-top: var(--sp-4); padding-top: var(--sp-2); border-top: 1px solid var(--border-subtle); }
.trend-day { display: flex; flex: 1; min-width: 2px; height: 100%; flex-direction: column; justify-content: end; align-items: center; gap: 4px; }
.trend-column { display: flex; width: min(16px, 80%); height: 86px; flex-direction: column-reverse; justify-content: flex-start; overflow: hidden; border-radius: 3px 3px 1px 1px; background: var(--bg-inset); }
.trend-column i { display: block; width: 100%; min-height: 0; }.trend-day span { min-height: 12px; white-space: nowrap; font-size: 9px; color: var(--text-tertiary); }
.overview-foot { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); margin-top: var(--sp-3); color: var(--text-tertiary); font-size: var(--fs-11); }
.overview-empty { padding: var(--sp-6); text-align: center; color: var(--text-tertiary); }
@media (max-width: 700px) { .pulse-row { grid-template-columns: 1fr; }.value-buckets { grid-template-columns: 1fr; }.trend-day span { display: none; } }
</style>
