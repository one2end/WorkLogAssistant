<template>
  <div class="summary-view">
    <div class="sv-toolbar">
      <DateNav
        :selected-date="selectedDate"
        :dates-with-data="datesWithData"
        @update:selected-date="$emit('update:selectedDate', $event)"
        @shift="$emit('shift', $event)"
        @today="$emit('today')"
      />
      <button class="btn btn-primary btn-sm" :disabled="generating" @click="$emit('generate')">
        <Icon :name="generating ? 'refresh' : 'zap'" :size="13" :class="{ spin: generating }" />
        {{ generating ? '生成中' : '生成摘要' }}
      </button>
    </div>

    <div class="sv-range">
      <button class="range-toggle" @click="showRange = !showRange">
        <Icon :name="showRange ? 'chevronDown' : 'chevronRight'" :size="12" />
        按时间段生成
      </button>
      <div v-if="showRange" class="range-body">
        <div class="range-field">
          <label>开始</label>
          <input
            :value="rangeStart"
            type="datetime-local"
            @input="$emit('update:rangeStart', $event.target.value)"
          >
        </div>
        <div class="range-field">
          <label>结束</label>
          <input
            :value="rangeEnd"
            type="datetime-local"
            @input="$emit('update:rangeEnd', $event.target.value)"
          >
        </div>
        <button class="btn btn-secondary btn-sm" :disabled="generating" @click="$emit('generate-range')">
          生成
        </button>
      </div>
    </div>

    <div class="sv-list">
      <template v-if="summaries.length">
        <article v-for="s in summaries" :key="s.id" class="sv-card card">
          <header class="sv-card-head">
            <span class="sv-time">
              <Icon name="clock" :size="11" />
              {{ timeRange(s) }}
            </span>
            <span class="sv-count">{{ s.activityCount }} 个片段</span>
          </header>
          <div class="md" v-html="render(s.summary)"></div>
        </article>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="summary" :size="88" /></span>
        <span class="empty-title">还没有摘要</span>
        <span class="empty-desc">
          点右上角「生成摘要」，AI 会把这一天的窗口活动整理成结构化工作日志
        </span>
      </div>
    </div>
  </div>
</template>

<script>
import { marked } from 'marked';
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';

export default {
  name: 'SummaryView',
  components: { Icon, DateNav, EmptyIllustration },
  props: {
    summaries: { type: Array, default: () => [] },
    selectedDate: { type: String, required: true },
    datesWithData: { type: Set, default: () => new Set() },
    generating: { type: Boolean, default: false },
    rangeStart: { type: String, default: '' },
    rangeEnd: { type: String, default: '' }
  },
  emits: ['generate', 'generate-range', 'update:selectedDate', 'shift', 'today',
    'update:rangeStart', 'update:rangeEnd'],
  data() {
    return { showRange: false };
  },
  methods: {
    render(md) {
      try {
        return marked.parse(md || '', { breaks: true });
      } catch (e) {
        return String(md || '');
      }
    },
    timeRange(s) {
      const a = new Date(s.startTime || s.timestamp);
      const b = new Date(s.endTime || s.timestamp);
      const f = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${f(a)} – ${f(b)}`;
    }
  }
};
</script>

<style scoped>
.summary-view {
  display: flex;
  flex-direction: column;
  padding: var(--sp-4);
  gap: var(--sp-3);
  min-height: 100%;
}

.sv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.spin {
  animation: wl-spin 1s linear infinite;
}

.sv-range {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.range-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  transition: color var(--dur-1) var(--ease);
}

.range-toggle:hover {
  color: var(--text-secondary);
}

.range-body {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
}

.range-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.range-field label {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.range-field input {
  font-size: var(--fs-11);
  padding: 5px 7px;
}

.sv-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sv-list > .empty {
  flex: 1;
}

.sv-card {
  padding: var(--sp-4);
}

.sv-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: var(--sp-2);
  margin-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
}

.sv-time {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-11);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.sv-count {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

/* Markdown 排版 */
.md {
  font-size: var(--fs-12);
  line-height: var(--lh-normal);
  color: var(--text-secondary);
  user-select: text;
  word-break: break-word;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  margin: var(--sp-3) 0 var(--sp-2);
  letter-spacing: 0.02em;
}

.md :deep(h1:first-child),
.md :deep(h2:first-child),
.md :deep(h3:first-child) {
  margin-top: 0;
}

.md :deep(p) {
  margin: 0 0 var(--sp-2);
}

.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 var(--sp-2);
  padding-left: 18px;
}

.md :deep(li) {
  margin-bottom: 3px;
}

.md :deep(strong) {
  color: var(--text-primary);
  font-weight: var(--fw-semibold);
}

.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--bg-inset);
  color: var(--accent);
}

.md :deep(blockquote) {
  margin: var(--sp-2) 0;
  padding-left: var(--sp-3);
  border-left: 2px solid var(--border-default);
  color: var(--text-tertiary);
}

.md :deep(hr) {
  border: none;
  height: 1px;
  background: var(--border-subtle);
  margin: var(--sp-3) 0;
}
</style>
