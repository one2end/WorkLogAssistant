<template>
  <section class="card weekly-card">
    <div class="card-head weekly-head">
      <div><span class="card-title">本周回顾草稿</span><span class="head-note">{{ from }} 至 {{ to }} · 本地统计生成</span></div>
      <button class="btn btn-secondary btn-sm" :disabled="!hasData" @click="copyReview">{{ copied ? '已复制' : '复制 Markdown' }}</button>
    </div>
    <div v-if="loading" class="weekly-empty">正在整理这一周…</div>
    <div v-else-if="!hasData" class="weekly-empty">这一周还没有足够的记录</div>
    <template v-else>
      <div class="weekly-metrics">
        <div><strong>{{ fmt(report.stats.trackedMs) }}</strong><span>记录投入</span></div>
        <div><strong>{{ report.stats.activeDayCount }}</strong><span>有记录天数</span></div>
        <div><strong :class="{ up: delta > 0, down: delta < 0 }">{{ deltaText }}</strong><span>较前一周</span></div>
      </div>
      <div class="weekly-body">
        <div>
          <span class="weekly-label">{{ hasProjects ? '项目投入' : '主要活动' }}</span>
          <ol><li v-for="item in topWorkItems" :key="item.name || item.label"><span>{{ item.name || item.label }}</span><strong>{{ fmt(item.durationMs) }}</strong></li></ol>
        </div>
        <div>
          <span class="weekly-label">时间构成</span>
          <ol><li v-for="item in topCategories" :key="item.name"><span>{{ item.name }}</span><strong>{{ pct(item.percent) }}</strong></li></ol>
        </div>
      </div>
      <p class="weekly-note">这是一份确定性统计草稿；核对低可信活动后，复制出的周报会更准确。</p>
    </template>
  </section>
</template>

<script>
import { ipc } from '../utils/ipc.mjs';
export default {
  name: 'WeeklyReview',
  props: { selectedDate: { type: String, required: true } },
  data() { return { loading: false, report: null, previous: null, from: '', to: '', copied: false, requestId: 0 }; },
  computed: {
    hasData() { return (this.report?.stats?.trackedMs || 0) > 0; },
    topThreads() { return (this.report?.threads || []).filter(x => x.confidence >= 0.65).slice(0, 5); },
    hasProjects() { return (this.report?.projects || []).length > 0; },
    topWorkItems() { return this.hasProjects ? this.report.projects.slice(0, 5) : this.topThreads; },
    topCategories() { return (this.report?.categories || []).slice(0, 5); },
    delta() {
      const current = Number(this.report?.stats?.trackedMs) || 0;
      const before = Number(this.previous?.stats?.trackedMs) || 0;
      return before ? (current - before) / before : 0;
    },
    deltaText() {
      if (!(this.previous?.stats?.trackedMs > 0)) return '无对照';
      if (Math.abs(this.delta) < 0.01) return '持平';
      return `${this.delta > 0 ? '+' : ''}${Math.round(this.delta * 100)}%`;
    },
    markdown() {
      if (!this.hasData) return '';
      const lines = [`# 周回顾｜${this.from}—${this.to}`, '',
        `本周共记录 ${this.fmt(this.report.stats.trackedMs)}，覆盖 ${this.report.stats.activeDayCount} 个有记录日；较前一周${this.deltaText}。`, '',
        '## 主要投入'];
      if (this.topWorkItems.length) this.topWorkItems.forEach(x => lines.push(`- ${x.name || x.label}：${this.fmt(x.durationMs)}（${x.dayCount} 天）`));
      else lines.push('- 活动语义尚未确认，建议先核对首页待确认线程。');
      lines.push('', '## 时间构成');
      this.topCategories.forEach(x => lines.push(`- ${x.name}：${this.fmt(x.durationMs)}（${this.pct(x.percent)}）`));
      lines.push('', '> 数据来自 LifeLog 本地记录；未记录时段和低可信活动未作推断。');
      return lines.join('\n');
    }
  },
  watch: { selectedDate: { immediate: true, handler() { this.load(); } } },
  methods: {
    dateStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    async load() {
      const id = ++this.requestId; this.loading = true; this.copied = false;
      const end = new Date(`${this.selectedDate}T12:00:00`);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      const previousEnd = new Date(start); previousEnd.setDate(previousEnd.getDate() - 1);
      const previousStart = new Date(previousEnd); previousStart.setDate(previousStart.getDate() - 6);
      this.from = this.dateStr(start); this.to = this.dateStr(end);
      try {
        const [current, previous] = await Promise.all([
          ipc.invoke('get-range-analytics', { from: this.from, to: this.to }),
          ipc.invoke('get-range-analytics', { from: this.dateStr(previousStart), to: this.dateStr(previousEnd) })
        ]);
        if (id === this.requestId) { this.report = current?.ok ? current.report : null; this.previous = previous?.ok ? previous.report : null; }
      } catch (_) { if (id === this.requestId) { this.report = null; this.previous = null; } }
      finally { if (id === this.requestId) this.loading = false; }
    },
    async copyReview() {
      if (!this.markdown) return;
      try { await navigator.clipboard.writeText(this.markdown); this.copied = true; }
      catch (_) { this.copied = false; }
    },
    fmt(ms) { const m = Math.round((Number(ms) || 0) / 60000); return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`; },
    pct(n) { return `${Math.round((Number(n) || 0) * 100)}%`; }
  }
};
</script>

<style scoped>
.weekly-card { grid-column: 1 / -1; }.weekly-head, .weekly-head > div { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.weekly-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); }.weekly-metrics div { display: flex; flex-direction: column; padding: var(--sp-3); border-radius: var(--r-sm); background: var(--bg-inset); }.weekly-metrics strong { font-size: var(--fs-18); }.weekly-metrics span { color: var(--text-tertiary); font-size: var(--fs-10); }.weekly-metrics .up { color: var(--success); }.weekly-metrics .down { color: var(--warning); }
.weekly-body { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-5); margin-top: var(--sp-4); }.weekly-label { color: var(--text-secondary); font-size: var(--fs-11); font-weight: var(--fw-semibold); }.weekly-body ol { margin: var(--sp-2) 0 0; padding: 0; list-style: none; }.weekly-body li { display: flex; justify-content: space-between; gap: var(--sp-3); padding: 5px 0; border-bottom: 1px solid var(--border-subtle); font-size: var(--fs-11); }.weekly-body li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.weekly-body li strong { flex: none; color: var(--text-secondary); }
.weekly-note, .weekly-empty { color: var(--text-tertiary); font-size: var(--fs-10); }.weekly-empty { padding: var(--sp-5); text-align: center; }
@media (max-width: 620px) { .weekly-body { grid-template-columns: 1fr; }.weekly-head { align-items: flex-start; }.weekly-head > div { align-items: flex-start; flex-direction: column; } }
</style>
