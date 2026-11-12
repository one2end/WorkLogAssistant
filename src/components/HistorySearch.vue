<template>
  <div class="hist">
    <!-- 一行解决：关键词 + 范围 + 项目筛选，不需要展开「高级选项」 -->
    <div class="hist-bar">
      <div class="hist-input-wrap">
        <Icon name="search" :size="13" />
        <input
          ref="input"
          v-model.trim="keyword"
          class="hist-input"
          type="search"
          placeholder="搜索应用、窗口标题、项目或备注"
          @keydown.enter="search"
          @input="onInput"
        >
        <button v-if="keyword" class="hist-clear" title="清空" @click="clear">×</button>
      </div>

      <div class="seg-group" role="group" aria-label="时间范围">
        <button
          v-for="opt in ranges" :key="opt.id"
          class="seg-btn" :class="{ active: range === opt.id }"
          @click="setRange(opt.id)"
        >{{ opt.label }}</button>
      </div>

      <select v-if="projects.length" v-model="project" class="hist-select" @change="search">
        <option value="">全部项目</option>
        <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <div v-if="loading" class="hist-state">正在检索…</div>

    <div v-else-if="error" class="hist-state is-error">
      <span>{{ error }}</span>
      <button class="btn btn-secondary btn-sm" @click="search">重试</button>
    </div>

    <div v-else-if="!searched" class="hist-state is-empty">
      输入关键词后回车，或选择一个项目。
    </div>

    <div v-else-if="!result || !result.hitCount" class="hist-state is-empty">
      没有找到匹配的记录。可以换个词，或者放宽时间范围。
    </div>

    <template v-else>
      <div class="hist-summary">
        找到 <strong>{{ result.hitCount }}</strong> 条，
        合计 <strong>{{ fmt(result.totalDurationMs) }}</strong>
        <span v-if="result.hitCount > result.hits.length" class="hist-truncated">
          （只显示前 {{ result.hits.length }} 条）
        </span>
      </div>

      <!-- 按日期分组：结果天然是时间序列，平铺一长串会让人不知道哪天是哪天 -->
      <div v-for="group in grouped" :key="group.date" class="hist-group">
        <div class="hist-date">
          <span>{{ group.date }}</span>
          <button class="btn btn-ghost btn-xs" @click="$emit('jump-date', group.date)">跳到这一天</button>
        </div>
        <ul class="hist-list">
          <li
            v-for="hit in group.hits"
            :key="hit.time + hit.app"
            class="hist-hit"
            @click="$emit('jump-segment', hit)"
          >
            <span class="hit-time">{{ timeOf(hit.time) }}</span>
            <span class="hit-dur">{{ fmt(hit.durationMs) }}</span>
            <span class="hit-app">{{ hit.app }}</span>
            <span class="hit-title" :title="hit.title">{{ hit.title || '—' }}</span>
            <span v-if="hit.project" class="hit-tag is-project">{{ hit.project }}</span>
            <span v-if="hit.note" class="hit-tag is-note" :title="hit.note">{{ hit.note }}</span>
            <span class="hit-why">{{ whyLabel(hit.matchedOn) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script>
import Icon from './Icon.vue';
import { ipc } from '../utils/ipc.mjs';

export default {
  name: 'HistorySearch',
  components: { Icon },
  emits: ['jump-date', 'jump-segment'],
  props: {
    /** 外部预填的项目名（从项目页跳过来时） */
    presetProject: { type: String, default: '' },
    /** 可选的项目名列表，用于下拉筛选 */
    projects: { type: Array, default: () => [] }
  },
  data() {
    return {
      keyword: '',
      project: this.presetProject,
      range: 'month',
      loading: false,
      error: '',
      result: null,
      searched: false,
      debounceTimer: null,
      requestId: 0,
      ranges: [
        { id: 'week', label: '本周' },
        { id: 'month', label: '本月' },
        { id: 'year', label: '今年' },
        { id: 'all', label: '全部' }
      ]
    };
  },
  computed: {
    dateRange() {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start = new Date(end);
      if (this.range === 'week') {
        const dow = (end.getDay() + 6) % 7;
        start.setDate(end.getDate() - dow);
      } else if (this.range === 'month') {
        start.setDate(1);
      } else if (this.range === 'year') {
        start.setMonth(0, 1);
      } else {
        start.setFullYear(2000, 0, 1);
      }
      return { from: this.dateStr(start), to: this.dateStr(end) };
    },
    grouped() {
      const hits = (this.result && this.result.hits) || [];
      const map = new Map();
      for (const h of hits) {
        if (!map.has(h.date)) map.set(h.date, []);
        map.get(h.date).push(h);
      }
      // 新的日期在前：刚发生的更容易被找
      return [...map.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, list]) => ({ date, hits: list }));
    }
  },
  watch: {
    presetProject(v) {
      if (!v) return;
      this.project = v;
      this.search();
    }
  },
  mounted() {
    if (this.presetProject) this.search();
    else if (this.$refs.input) this.$refs.input.focus();
  },
  methods: {
    dateStr(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    setRange(id) {
      this.range = id;
      if (this.searched) this.search();
    },
    onInput() {
      // 输入停顿再查：每敲一个字就发一次会让人等得心焦，
      // 也会让后端把同一段范围反复扫很多遍
      clearTimeout(this.debounceTimer);
      if (!this.keyword && !this.project) { this.searched = false; this.result = null; return; }
      this.debounceTimer = setTimeout(() => this.search(), 300);
    },
    clear() {
      this.keyword = '';
      this.searched = false;
      this.result = null;
      if (this.$refs.input) this.$refs.input.focus();
    },
    async search() {
      if (!this.keyword && !this.project) {
        this.error = '请输入关键词或选择一个项目';
        return;
      }
      const id = ++this.requestId;
      this.loading = true;
      this.error = '';
      try {
        const res = await ipc.invoke('search-activities', {
          keyword: this.keyword,
          project: this.project || undefined,
          from: this.dateRange.from,
          to: this.dateRange.to
        });
        if (id !== this.requestId) return;
        if (!res || !res.ok) {
          this.error = (res && res.error) || '检索失败';
          this.result = null;
        } else {
          this.result = res.result;
        }
        this.searched = true;
      } catch (e) {
        if (id === this.requestId) { this.error = e.message || '检索失败'; this.result = null; }
      } finally {
        if (id === this.requestId) this.loading = false;
      }
    },
    timeOf(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '--:--';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    /** 命中原因要显示出来，否则用户不知道为什么这条会出现 */
    whyLabel(field) {
      return { app: '应用', title: '标题', project: '项目', note: '备注' }[field] || '';
    },
    fmt(ms) {
      const m = Math.round((Number(ms) || 0) / 60000);
      if (m < 60) return `${m} 分钟`;
      const h = Math.floor(m / 60);
      const rest = m % 60;
      return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
    }
  }
};
</script>

<style scoped>
.hist { display: flex; flex-direction: column; gap: var(--sp-3); }
.hist-bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.hist-input-wrap {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 200px;
  padding: 5px 10px; border: 1px solid var(--border-subtle); border-radius: var(--r-sm);
  background: var(--bg-inset); color: var(--text-tertiary);
}
.hist-input {
  flex: 1; min-width: 0; border: 0; background: none; outline: none;
  color: var(--text-primary); font-size: var(--fs-11);
}
.hist-clear { border: 0; background: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; line-height: 1; }
.hist-select {
  padding: 5px 8px; border: 1px solid var(--border-subtle); border-radius: var(--r-sm);
  background: var(--bg-inset); color: var(--text-primary); font-size: var(--fs-11);
}

.seg-group { display: inline-flex; border: 1px solid var(--border-subtle); border-radius: var(--r-sm); overflow: hidden; }
.seg-btn { padding: 5px 10px; border: 0; background: transparent; color: var(--text-secondary); font-size: var(--fs-11); cursor: pointer; }
.seg-btn + .seg-btn { border-left: 1px solid var(--border-subtle); }
.seg-btn.active { background: var(--bg-raised, #1c1c1c); color: var(--text-primary); font-weight: var(--fw-semibold); }

.hist-state { padding: var(--sp-5); text-align: center; color: var(--text-tertiary); font-size: var(--fs-11); }
.hist-state.is-error { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); color: var(--danger, #e06060); }
.hist-summary { font-size: var(--fs-11); color: var(--text-secondary); }
.hist-truncated { color: var(--text-tertiary); }

.hist-group { border-top: 1px solid var(--border-subtle); padding-top: var(--sp-2); }
.hist-date { display: flex; align-items: center; justify-content: space-between; padding: 2px 0 6px; }
.hist-date span { font-size: var(--fs-11); font-weight: var(--fw-semibold); color: var(--text-secondary); }
.btn-xs { padding: 2px 6px; font-size: var(--fs-10); }

.hist-list { margin: 0; padding: 0; list-style: none; }
.hist-hit {
  display: grid;
  grid-template-columns: 44px 70px minmax(60px, 110px) minmax(0, 1fr) auto auto auto;
  align-items: center; gap: var(--sp-2);
  padding: 5px 4px; border-radius: 4px; cursor: pointer;
  font-size: var(--fs-11);
}
.hist-hit:hover { background: var(--bg-inset); }
.hit-time { color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.hit-dur { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.hit-app { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-title { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-tag { padding: 1px 6px; border-radius: 999px; font-size: var(--fs-10); white-space: nowrap; }
.hit-tag.is-project { background: rgba(110, 168, 254, 0.14); color: var(--accent, #6ea8fe); }
.hit-tag.is-note { background: rgba(126, 200, 169, 0.14); color: var(--success, #7ec8a9); max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.hit-why { color: var(--text-tertiary); font-size: var(--fs-10); width: 28px; text-align: right; }

@media (max-width: 720px) {
  .hist-hit { grid-template-columns: 40px 60px 1fr auto; }
  .hit-title, .hit-why { display: none; }
}
</style>
