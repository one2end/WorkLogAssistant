<template>
  <div ref="wrap" class="hm-wrap">
    <div class="hm-nav">
      <button class="hm-nav-btn" :title="`往前 ${weeks} 周`" :aria-label="`往前 ${weeks} 周`" @click="$emit('shift-range', -1)">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <span class="hm-range">{{ rangeLabel }}</span>
      <button
        class="hm-nav-btn"
        :title="`往后 ${weeks} 周`"
        :aria-label="`往后 ${weeks} 周`"
        :disabled="!canGoForward"
        @click="$emit('shift-range', 1)"
      >
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <label class="hm-month" title="跳转到指定月份">
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.6" y="2.4" width="8.8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.1" /><path d="M1.6 4.8h8.8M4 1.4v2M8 1.4v2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
        <input
          type="month"
          :value="monthValue"
          :max="maxMonth"
          aria-label="跳转到指定月份"
          @change="onMonthChange"
        />
      </label>
      <button class="hm-today" :class="{ need: canGoForward }" title="日期与热力图一起回到今天" @click="$emit('heat-today')">今天</button>
    </div>

    <template v-if="days.length">
      <div class="hm-body">
        <div class="hm-weekdays">
          <span v-for="(w, i) in weekdays" :key="w" :style="{ gridRow: i + 1 }">{{ w }}</span>
        </div>
        <div class="hm-grid">
          <button
            v-for="c in cells"
            :key="c.date"
            class="hm-cell"
            :data-level="c.level"
            :class="{ 'is-future': c.isFuture, 'is-selected': c.isSelected }"
            :style="{ gridRow: c.row + 1, gridColumn: c.col + 1 }"
            :disabled="c.isFuture"
            :title="tipText(c)"
            :aria-label="tipText(c)"
            @click="pick(c)"
            @mouseenter="onHover($event, c)"
            @mouseleave="hover = null"
            @focus="onHover($event, c)"
            @blur="hover = null"
          ></button>
        </div>
      </div>

      <div class="hm-foot">
        <span class="hm-hint">每格一天 · 仅计有效工作</span>
        <span class="hm-legend">
          <span>0</span>
          <i v-for="l in [0, 1, 2, 3, 4]" :key="l" class="hm-cell" :data-level="l" :title="['无记录', '少于 1.5 小时', '1.5–3.5 小时', '3.5–6 小时', '至少 6 小时'][l]"></i>
          <span>≥6h</span>
        </span>
      </div>
    </template>

    <div v-else class="hm-none">暂无历史记录，先从今天开始</div>

    <div
      v-if="hover"
      class="hm-tip"
      :style="{ left: hover.x + 'px', top: hover.y + 'px' }"
    >{{ tipText(hover.cell) }}</div>
  </div>
</template>

<script>
function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default {
  name: 'ActivityHeatmap',
  props: {
    // 84 项 dense 升序：周一开头、每 7 项一列，由 App 的 heatRange() 生成
    days: { type: Array, default: () => [] },
    weeks: { type: Number, default: 12 },
    selectedDate: { type: String, default: '' },
    thresholds: { type: Array, default: () => [90, 210, 360] }, // 分钟
    rangeFrom: { type: String, default: '' },
    rangeTo: { type: String, default: '' },
    canGoForward: { type: Boolean, default: false }
  },
  emits: ['select-date', 'shift-range', 'pick-month', 'heat-today'],
  data() {
    return {
      hover: null,
      weekdays: ['一', '二', '三', '四', '五', '六', '日']
    };
  },
  computed: {
    rangeLabel() {
      if (!this.rangeFrom || !this.rangeTo) return `最近 ${this.weeks} 周`;
      const short = (s) => `${s.slice(2, 4)}/${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
      return `${short(this.rangeFrom)} – ${short(this.rangeTo)}`;
    },
    monthValue() {
      return this.rangeTo ? this.rangeTo.slice(0, 7) : '';
    },
    maxMonth() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    },
    cells() {
      // 固定阈值使不同月份的色阶可比；短时记录不被放大成「满格」。
      const t = this.thresholds.length === 3 ? this.thresholds : [90, 210, 360];
      const today = localDateStr(new Date());

      return this.days.map((d, i) => {
        const ms = d.trackedMs || 0;
        const minutes = ms / 60000;
        let level = 0;
        if (minutes > 0) {
          level = minutes < t[0] ? 1
            : minutes < t[1] ? 2
              : minutes < t[2] ? 3 : 4;
        }
        return {
          date: d.date,
          trackedMs: ms,
          level,
          row: i % 7,
          col: Math.floor(i / 7),
          isFuture: d.date > today,
          isSelected: d.date === this.selectedDate && d.date <= today
        };
      });
    }
  },
  methods: {
    pick(c) {
      if (!c.isFuture) this.$emit('select-date', c.date);
    },
    onMonthChange(e) {
      if (e.target.value) this.$emit('pick-month', e.target.value);
    },
    onHover(e, c) {
      const rect = this.$refs.wrap.getBoundingClientRect();
      // focus 事件没有 clientX/clientY，退回用格子自身的位置
      const cellRect = e.currentTarget && e.currentTarget.getBoundingClientRect
        ? e.currentTarget.getBoundingClientRect() : { left: rect.left, top: rect.top };
      const cx = Number.isFinite(e.clientX) ? e.clientX : cellRect.left;
      const cy = Number.isFinite(e.clientY) ? e.clientY : cellRect.top;
      const x = Math.min(Math.max(0, cx - rect.left + 12), Math.max(0, rect.width - 150));
      const y = Math.max(0, cy - rect.top - 32);
      this.hover = { x, y, cell: c };
    },
    tipText(c) {
      if (!c) return '';
      return `${c.date} · ${c.trackedMs > 0 ? this.fmt(c.trackedMs) : '无记录'}`;
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
    }
  }
};
</script>

<style scoped>
.hm-wrap {
  position: relative;
  --hm-cell: 12px;
}

/* 窗口拉宽后格子一起放大，保持正方形不变形 */
@media (min-width: 900px) {
  .hm-wrap { --hm-cell: 15px; }
}

.hm-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}

.hm-nav-btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-xs);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.hm-nav-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.hm-nav-btn:disabled {
  opacity: 0.32;
  cursor: default;
}

.hm-range {
  font-size: var(--fs-10);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  white-space: nowrap;
}

.hm-month {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--r-xs);
  border: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.hm-month:hover {
  border-color: var(--border-default);
  color: var(--text-secondary);
}

.hm-month input {
  width: 94px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--fs-10);
  font-variant-numeric: tabular-nums;
  outline: none;
  cursor: pointer;
  color-scheme: inherit;
}

.hm-today {
  margin-left: auto;
  height: 20px;
  padding: 0 9px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  font-size: var(--fs-10);
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
    border-color var(--dur-1) var(--ease);
}

.hm-today:hover {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent-border);
}

.hm-today.need {
  color: var(--accent);
  border-color: var(--accent-border);
}

.hm-body {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
}

.hm-weekdays {
  display: grid;
  grid-template-rows: repeat(7, var(--hm-cell));
  gap: 3px;
  flex: 0 0 auto;
}

.hm-weekdays span {
  width: 12px;
  font-size: 9px;
  line-height: var(--hm-cell);
  text-align: right;
  color: var(--text-tertiary);
}

.hm-grid {
  display: grid;
  grid-template-rows: repeat(7, var(--hm-cell));
  grid-auto-columns: var(--hm-cell);
  gap: 3px;
}

.hm-cell {
  display: block;
  width: var(--hm-cell);
  height: var(--hm-cell);
  padding: 0;
  border-radius: 2px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  cursor: pointer;
  transition: transform var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease),
    background-color 320ms var(--ease), border-color 320ms var(--ease);
}

.hm-cell[data-level="1"] { background: color-mix(in srgb, var(--accent) 22%, var(--bg-inset)); }
.hm-cell[data-level="2"] { background: color-mix(in srgb, var(--accent) 45%, var(--bg-inset)); }
.hm-cell[data-level="3"] { background: color-mix(in srgb, var(--accent) 70%, var(--bg-inset)); }
.hm-cell[data-level="4"] { background: var(--accent); border-color: transparent; }

.hm-cell:hover:not(:disabled) {
  transform: scale(1.18);
  box-shadow: 0 0 0 1px var(--text-primary);
}

.hm-cell.is-future {
  opacity: 0.3;
  cursor: default;
}

.hm-cell.is-selected {
  box-shadow: 0 0 0 1.5px var(--text-primary);
}

.hm-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.hm-hint {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.hm-legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.hm-legend .hm-cell {
  width: 10px;
  height: 10px;
  cursor: default;
}

.hm-none {
  padding: var(--sp-5) 0;
  text-align: center;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}

.hm-tip {
  position: absolute;
  z-index: 5;
  pointer-events: none;
  padding: 4px 8px;
  border-radius: var(--r-xs);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-10);
  color: var(--text-primary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
