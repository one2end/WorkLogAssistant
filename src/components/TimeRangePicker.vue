<template>
  <div class="time-range">
    <div class="time-fields">
      <label><span>开始</span><input v-model="draftStart" type="text" inputmode="numeric" maxlength="5" placeholder="HH:mm" aria-label="开始时间" @blur="changeStart" @keydown.enter.prevent="changeStart"></label>
      <label class="end-field"><span>结束{{ crossesMidnight ? ' · 次日' : '' }}</span><input v-model="endTime" type="text" inputmode="numeric" maxlength="5" placeholder="HH:mm" aria-label="结束时间；早于开始时间自动视为次日" @blur="changeEnd" @keydown.enter.prevent="changeEnd"></label>
      <label class="duration-field"><span>时长 · 分</span><input type="number" min="15" :max="maxDuration" step="15" :value="duration" @change="setDuration($event.target.value)"></label>
    </div>
    <input class="time-slider" type="range" min="15" :max="sliderLimit" step="15" :value="Math.min(duration, sliderLimit)" aria-label="拖动调整时长，最长五小时" @input="setDuration($event.target.value)">
    <small class="time-limit">拖动最多 5 小时{{ maxDuration > 300 ? '；跨夜可直接修改结束时间' : '' }}</small>
  </div>
</template>

<script>
import { parseClock, clockOf, durationFromClocks } from '../utils/timeRange.mjs';
export default {
  name: 'TimeRangePicker',
  props: {
    startTime: { type: String, default: '00:00' },
    duration: { type: Number, default: 15 },
    maxDuration: { type: Number, default: 1440 }
  },
  emits: ['update:startTime', 'update:duration'],
  data() { return { draftStart: '00:00', endTime: '00:15' }; },
  computed: {
    sliderLimit() { return Math.min(300, this.maxDuration); },
    crossesMidnight() { return (parseClock(this.startTime) ?? 0) + Number(this.duration || 15) >= 1440; }
  },
  watch: {
    startTime: { immediate: true, handler() { this.draftStart = this.startTime; this.syncEnd(); } },
    duration: { immediate: true, handler() { this.syncEnd(); } }
  },
  methods: {
    syncEnd() {
      const total = (parseClock(this.startTime) ?? 0) + (Number(this.duration) || 15);
      this.endTime = clockOf(total % 1440);
    },
    changeStart() {
      const minute = parseClock(this.draftStart);
      if (minute === null) { this.draftStart = this.startTime; return; }
      const value = clockOf(minute);
      this.draftStart = value;
      this.$emit('update:startTime', value);
    },
    setDuration(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) { this.syncEnd(); return; }
      const next = Math.min(this.maxDuration, Math.max(15, Math.round(numeric / 15) * 15));
      this.$emit('update:duration', next);
    },
    changeEnd() {
      const next = durationFromClocks(this.startTime, this.endTime);
      if (next === null) { this.syncEnd(); return; }
      this.setDuration(next);
      this.$nextTick(() => this.syncEnd());
    }
  }
};
</script>

<style scoped>
.time-range { min-width: 0; }
.time-fields { display: grid; grid-template-columns: minmax(68px, 1fr) minmax(90px, 1fr) 62px; gap: 5px; align-items: end; }
.time-fields label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.time-fields span { color: var(--text-tertiary); font-size: var(--fs-10); }
.time-fields input { box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 2px 6px; border: 1px solid var(--border-default); border-radius: 5px; background: var(--bg-inset); color: var(--text-primary); font-size: var(--fs-11); font-family: inherit; font-variant-numeric: tabular-nums; }
.time-slider { display: block; width: 100%; height: 15px; margin: 7px 0 0; accent-color: var(--accent); cursor: pointer; }
.time-limit { display: block; margin-top: 2px; color: var(--text-tertiary); font-size: 10px; }
</style>
