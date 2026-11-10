<template>
  <section v-if="plan.length" class="card plan-card">
    <div class="card-head">
      <div>
        <span class="card-title">今日节奏</span>
        <span class="head-note">按时间与实际活动对照 · 点击计划查看时间轴</span>
      </div>
      <span class="plan-count">{{ plan.length }} 段</span>
    </div>

    <div class="plan-band" aria-label="今日计划时间分布">
      <span
        v-for="item in plan"
        :key="item.id"
        class="plan-block"
        :style="blockStyle(item)"
        :title="`${clock(item.startMin)}–${clock(item.endMin)} ${item.title}`"
      ></span>
      <i v-if="isToday" class="plan-now" :style="{ left: nowPercent + '%' }"></i>
    </div>
    <div class="plan-ticks"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>

    <div class="plan-list">
      <div v-for="item in visible" :key="item.id" class="plan-row" role="button" tabindex="0"
        :aria-label="`查看 ${item.label} 对应的时间轴`"
        @click="$emit('open', item)" @keydown.enter.prevent="$emit('open', item)" @keydown.space.prevent="$emit('open', item)">
        <span class="plan-time">{{ clock(item.startMin) }}<small>{{ clock(item.endMin) }}</small></span>
        <span class="plan-main">
          <strong>{{ item.label }}</strong>
          <small>{{ comparisonOf(item).detail }}</small>
        </span>
        <span class="plan-state" :class="comparisonOf(item).tone" :title="comparisonOf(item).hint">{{ comparisonOf(item).label }}</span>
      </div>
    </div>
    <button v-if="plan.length > limit" class="plan-more" @click="expanded = !expanded">
      {{ expanded ? '收起' : `查看其余 ${plan.length - limit} 段` }}
    </button>
  </section>
</template>

<script>
import { colorForCategory } from '../styles/palette.js';

export default {
  name: 'PlanOverview',
  emits: ['open'],
  props: {
    plan: { type: Array, default: () => [] },
    threads: { type: Array, default: () => [] },
    selectedDate: { type: String, default: '' },
    theme: { type: String, default: 'dark' }
  },
  data() { return { expanded: false, limit: 6, tick: 0, timer: null }; },
  computed: {
    visible() { return this.expanded ? this.plan : this.plan.slice(0, this.limit); },
    todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    isToday() { return this.selectedDate === this.todayStr; },
    nowMin() { void this.tick; const d = new Date(); return d.getHours() * 60 + d.getMinutes(); },
    nowPercent() { return Math.max(0, Math.min(100, this.nowMin / 1440 * 100)); }
  },
  mounted() { this.timer = setInterval(() => { this.tick += 1; }, 60000); },
  beforeUnmount() { if (this.timer) clearInterval(this.timer); },
  methods: {
    clock(min) {
      const value = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)));
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    },
    blockStyle(item) {
      const start = Math.max(0, Number(item.startMin) || 0);
      const end = Math.max(start + 1, Math.min(1440, Number(item.endMin) || start + 15));
      return {
        left: `${start / 1440 * 100}%`, width: `${(end - start) / 1440 * 100}%`,
        '--plan-color': colorForCategory(this.theme, item.category || '其他')
      };
    },
    fmtMinutes(value) {
      const min = Math.max(0, Math.round(Number(value) || 0));
      if (min < 60) return `${min}m`;
      const h = Math.floor(min / 60);
      return `${h}h${min % 60 ? `${min % 60}m` : ''}`;
    },
    actualFor(item) {
      const byGroup = new Map();
      let minutes = 0;
      for (const thread of this.threads) {
        const start = Number(thread.startMin);
        const end = start + Math.max(0, Number(thread.durationMs) || 0) / 60000;
        const overlap = Math.max(0, Math.min(item.endMin, end) - Math.max(item.startMin, start));
        if (!overlap) continue;
        const group = thread.group || thread.category || '其他';
        minutes += overlap;
        byGroup.set(group, (byGroup.get(group) || 0) + overlap);
      }
      const dominant = [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { minutes, dominant, ratio: minutes / Math.max(1, item.durationMin || item.endMin - item.startMin) };
    },
    comparisonOf(item) {
      const base = `${item.category}${item.repeat && item.repeat !== 'none' ? ' · 重复计划' : ''}`;
      if (item.actual) {
        const source = item.actual.source === 'screen' ? '屏幕活动' : '计划确认';
        const detail = `${base} · ${source} ${this.fmtMinutes(item.actual.durationMin)}`;
        return { label: item.actual.source === 'screen' ? '识别为事实' : '已记为事实', tone: 'good', detail, hint: item.actual.label || source };
      }
      if (this.selectedDate > this.todayStr || (this.isToday && this.nowMin < item.startMin)) {
        return { label: this.isToday ? '稍后' : '计划', tone: 'future', detail: base, hint: '这是一段计划，还没有进入实际对照' };
      }
      if (this.isToday && this.nowMin >= item.startMin && this.nowMin < item.endMin) {
        return { label: '进行中', tone: 'now', detail: base, hint: '当前处于这段计划时间内' };
      }

      const actual = this.actualFor(item);
      const sameGroup = actual.dominant === item.category;
      const actualDetail = actual.minutes >= 1
        ? `${base} · 实际 ${this.fmtMinutes(actual.minutes)}${actual.dominant ? `（${actual.dominant}）` : ''}`
        : `${base} · 暂无实际记录`;
      if (actual.ratio >= 0.5 && sameGroup) {
        return { label: '吻合', tone: 'good', detail: actualDetail, hint: '实际记录覆盖计划一半以上，且主要活动大类一致' };
      }
      if (actual.ratio >= 0.2 && sameGroup) {
        return { label: '部分吻合', tone: 'partial', detail: actualDetail, hint: '实际活动大类一致，但只覆盖了部分计划时段' };
      }
      if (actual.ratio >= 0.2) {
        return { label: '有调整', tone: 'adjusted', detail: actualDetail, hint: '这段时间有实际记录，但主要活动与计划大类不同' };
      }
      return { label: '未记录', tone: 'missing', detail: actualDetail, hint: '计划时段内没有足够的实际记录；这不等于计划没有完成' };
    }
  }
};
</script>

<style scoped>
.plan-card { grid-column: 1 / -1; }
.card-head > div { display: flex; align-items: baseline; gap: var(--sp-2); }
.plan-count { color: var(--text-tertiary); font-size: var(--fs-10); }
.plan-band { position: relative; height: 22px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 7px; background: var(--bg-inset); }
.plan-block { position: absolute; top: 4px; bottom: 4px; min-width: 2px; border: 1px dashed var(--plan-color); border-radius: 4px; background: color-mix(in srgb, var(--plan-color) 22%, transparent); }
.plan-now { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--text-primary); opacity: .7; }
.plan-ticks { display: flex; justify-content: space-between; margin-top: 3px; color: var(--text-tertiary); font: 9px var(--font-mono); }
.plan-list { display: grid; margin-top: var(--sp-3); }
.plan-row { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); padding: 7px 0; border-top: 1px solid var(--border-subtle); }
.plan-row { cursor: pointer; border-radius: var(--r-sm); }
.plan-row:hover, .plan-row:focus-visible { background: var(--bg-hover); outline: none; }
.plan-time { display: flex; flex-direction: column; color: var(--text-secondary); font: var(--fs-11) var(--font-mono); }.plan-time small { color: var(--text-tertiary); font-size: 9px; }
.plan-main { display: flex; min-width: 0; flex-direction: column; }.plan-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-11); }.plan-main small { color: var(--text-tertiary); font-size: var(--fs-10); }
.plan-state { padding: 2px 7px; border-radius: 999px; color: var(--text-tertiary); background: var(--bg-inset); font-size: var(--fs-10); white-space: nowrap; }
.plan-state.now { color: var(--accent); background: var(--accent-soft); }
.plan-state.good { color: var(--success); background: var(--success-soft); }
.plan-state.partial, .plan-state.adjusted { color: var(--warning); background: var(--warning-soft); }
.plan-state.missing { color: var(--text-tertiary); background: var(--bg-inset); }
.plan-more { width: 100%; border: 0; padding: var(--sp-2); background: transparent; color: var(--text-tertiary); font-size: var(--fs-11); cursor: pointer; }
</style>
