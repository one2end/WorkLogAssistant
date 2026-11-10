<template>
  <transition name="modal-fade">
    <div v-if="open" class="plan-mask" @click.self="$emit('close')">
      <div class="plan-modal" role="dialog" aria-label="计划编辑器">
        <div class="pm-head">
          <strong>{{ isEdit ? '编辑计划' : '新建计划' }}</strong>
          <span v-if="form.repeat !== 'none'" class="pm-badge">{{ repeatLabel }}</span>
          <button class="pm-x" title="关闭" @click="$emit('close')">×</button>
        </div>
        <label class="pm-field pm-date"><span>日期</span><input v-model="form.date" type="date"></label>
        <TimeRangePicker :start-time="form.time" :duration="Number(form.duration) || 15"
          @update:start-time="form.time = $event" @update:duration="form.duration = $event" />

        <label class="pm-field">
          <span>计划内容</span>
          <input
            v-model="form.label"
            type="text"
            maxlength="100"
            placeholder="例如：整理周报"
            @keydown.enter.prevent="submit"
          >
        </label>

        <div class="pm-field">
          <span>分类</span>
          <div class="pm-cats">
            <button
              v-for="c in categories"
              :key="c"
              type="button"
              class="pm-cat"
              :class="{ on: form.category === c }"
              :style="{ '--cat': colorOf(c) }"
              @click="form.category = c"
            >{{ categoryLabel(c) }}</button>
          </div>
        </div>

        <div class="pm-row">
          <label class="pm-field">
            <span>重复</span>
            <select v-model="form.repeat">
              <option v-for="r in repeatOptions" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </label>
          <label v-if="form.repeat !== 'none'" class="pm-field">
            <span>结束于（可留空）</span>
            <input v-model="form.repeatEnd" type="date">
          </label>
        </div>

        <p v-if="form.repeat !== 'none'" class="pm-hint">{{ repeatHint }}</p>
        <p v-if="isRecurringEdit" class="pm-hint">修改将应用到本次及以后。</p>

        <div class="pm-field">
          <span>项目（可选）</span>
          <input v-model="form.project" type="text" maxlength="60" placeholder="输入项目名称">
          <div v-if="matchingProjects.length" class="pm-project-hints"><button v-for="p in matchingProjects" :key="p" type="button" @click="form.project = p">{{ p }}</button></div>
        </div>

        <div class="pm-actions">
          <button
            v-if="isEdit"
            class="btn btn-ghost btn-sm pm-delete"
            :disabled="saving"
            @click="$emit('delete', { localId: initial.localId, label: initial.label, repeat: initial.repeat })"
          >删除</button>
          <span class="pm-spacer" />
          <button class="btn btn-ghost btn-sm" @click="$emit('close')">取消</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="saving || !form.label.trim()"
            @click="submit"
          >{{ saving ? '保存中' : (isEdit ? '更新计划' : '保存计划') }}</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import { colorForCategory } from '../styles/palette.js';
import TimeRangePicker from './TimeRangePicker.vue';

const REPEATS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'workday', label: '工作日' },
  { value: 'holiday', label: '节假日' },
  { value: 'weekend', label: '周末' }
];

const HINTS = {
  daily: '每天都会出现，直到结束日期或手动删除。',
  workday: '周一至周五，自动排除法定假日，并包含调休上班日。',
  holiday: '周末和法定假日都会出现，调休上班日不算。',
  weekend: '只看自然周六周日，不考虑调休。'
};

function clock(min) {
  const v = Math.max(0, Math.min(1439, Math.round(Number(min) || 0)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

function toMin(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m) return 0;
  return Math.min(1439, Number(m[1]) * 60 + Number(m[2]));
}

export default {
  name: 'PlanEditor',
  components: { TimeRangePicker },
  props: {
    open: { type: Boolean, default: false },
    initial: { type: Object, default: () => ({}) },
    categories: { type: Array, default: () => [] },
    categoryLabels: { type: Object, default: () => ({}) },
    projectHints: { type: Array, default: () => [] },
    saving: { type: Boolean, default: false },
    theme: { type: String, default: 'dark' }
  },
  emits: ['save', 'delete', 'close'],
  data() {
    return {
      repeatOptions: REPEATS,
      form: {
        label: '', date: '', time: '09:00', duration: 30,
        category: '工作', repeat: 'none', repeatEnd: '', project: ''
      }
    };
  },
  computed: {
    isEdit() { return !!this.initial?.localId; },
    isRecurringEdit() { return this.isEdit && this.initial?.repeat && this.initial.repeat !== 'none'; },
    repeatLabel() {
      return (REPEATS.find(r => r.value === this.form.repeat) || {}).label || '';
    },
    repeatHint() { return HINTS[this.form.repeat] || ''; },
    matchingProjects() {
      const query = String(this.form.project || '').trim().toLowerCase();
      return query ? this.projectHints.filter(p => String(p).toLowerCase().includes(query) && p !== this.form.project).slice(0, 6) : [];
    }
  },
  watch: {
    open: {
      immediate: true,
      handler(val) { if (val) this.sync(); }
    },
    initial: {
      deep: true,
      handler() { if (this.open) this.sync(); }
    }
  },
  methods: {
    colorOf(category) { return colorForCategory(this.theme, category); },
    categoryLabel(c) { return this.categoryLabels[c] || c; },
    sync() {
      const it = this.initial || {};
      this.form = {
        label: it.label || it.title || '',
        date: it.date || '',
        time: clock(it.startMin ?? 540),
        duration: Math.max(15, Number(it.durationMin) || 30),
        category: it.category || '工作',
        project: it.project || '',
        repeat: it.repeat && it.repeat !== 'none' ? it.repeat : 'none',
        repeatEnd: it.repeatEnd || ''
      };
    },
    submit() {
      if (!this.form.label.trim()) return;
      this.$emit('save', {
        localId: this.initial?.localId || '',
        date: this.form.date,
        startMin: toMin(this.form.time),
        durationMin: Number(this.form.duration) || 30,
        label: this.form.label.trim(),
        category: this.form.category,
        project: this.form.project.trim(),
        repeat: this.form.repeat,
        repeatEnd: this.form.repeat === 'none' ? '' : this.form.repeatEnd,
        occurrenceDate: this.isRecurringEdit ? (this.initial.occurrenceDate || this.initial.date) : '',
        scope: this.isRecurringEdit ? 'future' : ''
      });
    }
  }
};
</script>

<style scoped>
.plan-mask {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  background: rgba(0, 0, 0, .42);
  backdrop-filter: blur(2px);
}
.plan-modal {
  width: min(520px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--border-default);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}
.pm-head { display: flex; align-items: center; gap: var(--sp-2); }
.pm-head strong { font-size: var(--fs-14); color: var(--text-primary); }
.pm-badge {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-10);
}
.pm-x {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border-radius: var(--r-xs);
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
}
.pm-x:hover { background: var(--bg-hover); color: var(--text-primary); }

.pm-row { display: flex; gap: var(--sp-2); }
.pm-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.pm-field.narrow { flex: 0 0 96px; }
.pm-date { max-width: 180px; }
.pm-field > span { color: var(--text-tertiary); font-size: var(--fs-10); }
.pm-field input,
.pm-field select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--text-primary);
  font-size: var(--fs-12);
}
.pm-field input:focus,
.pm-field select:focus { outline: none; border-color: var(--accent-border); }

.pm-cats { display: flex; flex-wrap: wrap; gap: 4px; }
.pm-cat {
  padding: 3px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-full);
  background: var(--bg-inset);
  color: var(--text-tertiary);
  font-size: var(--fs-10);
}
.pm-cat.on {
  border-color: var(--cat);
  color: var(--cat);
  background: color-mix(in srgb, var(--cat) 14%, transparent);
}
.pm-hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--fs-10);
  line-height: 1.5;
}
.pm-actions { display: flex; align-items: center; gap: var(--sp-2); }
.pm-spacer { flex: 1; }
.pm-delete { color: var(--danger) !important; }
.pm-project-hints { display: flex; flex-wrap: wrap; gap: 4px; }
.pm-project-hints button { padding: 4px 7px; border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-secondary); font-size: var(--fs-11); }
.pm-project-hints button:hover { color: var(--accent); border-color: var(--accent); }
</style>
