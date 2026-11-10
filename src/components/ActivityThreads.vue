<template>
  <section v-if="threads.length" class="card thread-card">
    <div class="card-head">
      <div>
        <span class="card-title">今天推进了什么</span>
        <span class="head-note">按连续活动归并，不等同于单个前台应用</span>
      </div>
      <span v-if="uncertainCount" class="thread-alert">{{ uncertainCount }} 条待确认</span>
    </div>
    <div class="thread-list">
      <article v-for="thread in visibleThreads" :key="thread.id" class="thread-row" :class="{ uncertain: thread.needsConfirmation }">
        <span class="thread-time">{{ hm(thread.start) }}<small>{{ fmt(thread.durationMs) }}</small></span>
        <span class="thread-main">
          <strong :title="thread.label">{{ thread.label }}</strong>
          <small><b v-if="thread.project">{{ thread.project }}</b>{{ thread.project ? ' · ' : '' }}{{ thread.group }} · {{ thread.apps.join('、') }}<template v-if="thread.switchCount"> · 切换 {{ thread.switchCount }} 次</template></small>
        </span>
        <span class="confidence" :class="confidenceTone(thread)">{{ confidenceText(thread) }}</span>
        <button v-if="thread.needsConfirmation" class="btn btn-secondary btn-sm" @click="$emit('review', thread)">核对</button>
        <button v-else-if="thread.source !== 'confirmed'" class="btn btn-ghost btn-sm" @click="startConfirm(thread)">确认</button>
        <div v-if="editingId === thread.id" class="thread-confirm">
          <input v-model="draftLabel" maxlength="80" aria-label="活动名称" placeholder="活动名称">
          <input v-model="draftProject" maxlength="60" aria-label="项目名称" placeholder="项目，可留空">
          <button class="btn btn-primary btn-sm" :disabled="!draftLabel.trim()" @click="submitConfirm(thread)">保存</button>
          <button class="btn btn-ghost btn-sm" @click="editingId = null">取消</button>
        </div>
      </article>
    </div>
    <button v-if="threads.length > limit" class="thread-more" @click="expanded = !expanded">
      {{ expanded ? '收起' : `查看其余 ${threads.length - limit} 条` }}
    </button>
  </section>
</template>

<script>
export default {
  name: 'ActivityThreads',
  props: { threads: { type: Array, default: () => [] } },
  emits: ['review', 'confirm'],
  data() { return { expanded: false, limit: 5, editingId: null, draftLabel: '', draftProject: '' }; },
  computed: {
    visibleThreads() { return this.expanded ? this.threads : this.threads.slice(0, this.limit); },
    uncertainCount() { return this.threads.filter(x => x.needsConfirmation).length; }
  },
  methods: {
    startConfirm(thread) {
      this.editingId = thread.id;
      this.draftLabel = thread.label || '';
      this.draftProject = thread.project || '';
    },
    submitConfirm(thread) {
      if (!this.draftLabel.trim()) return;
      this.$emit('confirm', { ...thread, label: this.draftLabel.trim(), project: this.draftProject.trim() });
      this.editingId = null;
    },
    hm(iso) {
      const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    fmt(ms) {
      const min = Math.max(1, Math.round((Number(ms) || 0) / 60000));
      return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}`;
    },
    confidenceText(thread) {
      if (thread.source === 'confirmed') return '已确认';
      if (thread.confidence >= 0.8) return '高可信';
      if (thread.confidence >= 0.65) return '较可信';
      return '待确认';
    },
    confidenceTone(thread) {
      if (thread.source === 'confirmed' || thread.confidence >= 0.8) return 'good';
      return thread.confidence >= 0.65 ? 'steady' : 'low';
    }
  }
};
</script>

<style scoped>
.thread-card { grid-column: 1 / -1; }.card-head > div { display: flex; align-items: baseline; gap: var(--sp-2); }
.thread-alert { padding: 3px 8px; border-radius: 999px; background: var(--warning-soft); color: var(--warning); font-size: var(--fs-10); }
.thread-list { display: grid; gap: 2px; }.thread-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto auto; align-items: center; gap: var(--sp-3); padding: 9px 0; border-top: 1px solid var(--border-subtle); }
.thread-row.uncertain { background: linear-gradient(90deg, color-mix(in srgb, var(--warning-soft) 35%, transparent), transparent 45%); }
.thread-time { display: flex; flex-direction: column; color: var(--text-secondary); font: var(--fs-11) var(--font-mono); }.thread-time small { color: var(--text-tertiary); font-size: 9px; }
.thread-main { display: flex; min-width: 0; flex-direction: column; gap: 2px; }.thread-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-12); }.thread-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); font-size: var(--fs-10); }.thread-main small b { color: var(--accent); font-weight: var(--fw-medium); }
.confidence { min-width: 50px; text-align: center; color: var(--text-tertiary); font-size: var(--fs-10); }.confidence.good { color: var(--success); }.confidence.low { color: var(--warning); }
.thread-confirm { grid-column: 2 / -1; display: grid; grid-template-columns: minmax(140px, 1fr) minmax(120px, .7fr) auto auto; gap: var(--sp-2); padding: var(--sp-2); border-radius: var(--r-sm); background: var(--bg-inset); }.thread-confirm input { min-width: 0; }
.thread-more { width: 100%; border: 0; padding: var(--sp-2); background: transparent; color: var(--text-tertiary); font-size: var(--fs-11); cursor: pointer; }
@media (max-width: 620px) { .thread-row { grid-template-columns: 52px minmax(0, 1fr) auto; }.confidence { display: none; }.thread-confirm { grid-column: 1 / -1; grid-template-columns: 1fr; } }
</style>
