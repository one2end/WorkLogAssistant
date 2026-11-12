<template>
  <div class="projects">
    <div class="proj-head">
      <div class="proj-title">
        <h2>项目投入</h2>
        <span class="proj-sub">{{ rangeLabel }} · 按项目规则归属</span>
      </div>

      <div class="proj-controls">
        <!-- 三个尺度，一次点击切换。不给日期选择器：查看项目投入用的是
             「这周/这月」，不是「从几号到几号」。 -->
        <div class="seg-group" role="group" aria-label="时间范围">
          <button
            v-for="opt in ranges" :key="opt.id"
            class="seg-btn" :class="{ active: range === opt.id }"
            @click="setRange(opt.id)"
          >{{ opt.label }}</button>
        </div>
        <button class="btn btn-ghost btn-sm" @click="reload" :disabled="loading">刷新</button>
      </div>
    </div>

    <!-- 加载 / 无数据 / 失败 / 正常，四种状态都要有明确呈现 -->
    <!-- 检索与项目统计是同一件事的两面：一个按项目聚合，一个按关键词查找 -->
    <div class="proj-section">
      <button class="section-toggle" @click="showSearch = !showSearch">
        <span>{{ showSearch ? '▾' : '▸' }}</span> 检索历史记录
        <span class="section-hint">按应用、标题、项目或备注查</span>
      </button>
      <div v-if="showSearch" class="section-body">
        <HistorySearch
          ref="search"
          :preset-project="presetSearchProject"
          :projects="projectNames"
          @jump-date="$emit('jump-date', $event)"
          @jump-segment="$emit('jump-segment', $event)"
        />
      </div>
    </div>

    <div v-if="loading" class="proj-state">正在统计…</div>

    <div v-else-if="error" class="proj-state is-error">
      <span>{{ error }}</span>
      <button class="btn btn-secondary btn-sm" @click="reload">重试</button>
    </div>

    <div v-else-if="!report || !report.projects.length" class="proj-state is-empty">
      <p>这段时间还没有归属到项目的记录。</p>
      <p class="proj-hint">
        项目靠「设置 → 项目规则」里的关键词匹配应用名与窗口标题。
        <button class="link-btn" @click="$emit('open-project-rules')">去配置项目规则</button>
      </p>
    </div>

    <template v-else>
      <!-- 概览：三个数字，不画图 -->
      <div class="proj-summary">
        <div class="sum-item">
          <span class="sum-label">项目总投入</span>
          <strong>{{ fmt(report.projectTotalMs) }}</strong>
        </div>
        <div class="sum-item">
          <span class="sum-label">全部记录</span>
          <strong>{{ fmt(report.totalMs) }}</strong>
        </div>
        <div class="sum-item" :class="{ 'is-warn': report.unassignedMs > 0 }">
          <span class="sum-label">未归属项目</span>
          <strong>{{ fmt(report.unassignedMs) }}</strong>
        </div>
      </div>

      <div v-if="report.unassignedMs > 0" class="proj-note">
        有 {{ fmt(report.unassignedMs) }} 的记录没有匹配到任何项目。补一条项目规则就能把它们归进去。
      </div>

      <!-- 项目列表：点开看详情，不跳页 -->
      <ul class="proj-list">
        <li v-for="p in report.projects" :key="p.name" class="proj-row" :class="{ open: expanded === p.name }">
          <button class="proj-row-head" @click="toggle(p.name)">
            <span class="proj-caret">{{ expanded === p.name ? '▾' : '▸' }}</span>
            <span class="proj-name">{{ p.name }}</span>
            <span class="proj-bar-wrap">
              <span class="proj-bar" :style="{ width: barWidth(p) }"></span>
            </span>
            <span class="proj-dur">{{ fmt(p.durationMs) }}</span>
            <span class="proj-pct">{{ pct(p.percent) }}</span>
          </button>

          <div v-if="expanded === p.name" class="proj-detail">
            <div class="detail-col">
              <span class="detail-label">涉及应用</span>
              <div class="detail-chips">
                <span v-for="a in p.apps.slice(0, 6)" :key="a.app" class="chip">
                  {{ a.app }} <em>{{ fmt(a.durationMs) }}</em>
                </span>
              </div>
            </div>

            <div class="detail-col">
              <span class="detail-label">按天分布</span>
              <div class="detail-days">
                <span v-for="(ms, date) in sortedDays(p)" :key="date" class="day-item">
                  <span class="day-date">{{ shortDate(date) }}</span>
                  <span class="day-ms">{{ fmt(ms) }}</span>
                </span>
              </div>
            </div>

            <div class="detail-actions">
              <button class="btn btn-ghost btn-sm" @click="openSearchFor(p.name)">
                查看全部记录
              </button>
            </div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<script>
import { ipc } from '../utils/ipc.mjs';
import HistorySearch from '../components/HistorySearch.vue';

export default {
  name: 'ProjectsView',
  components: { HistorySearch },
  emits: ['open-project-rules', 'search-project', 'jump-date', 'jump-segment'],
  data() {
    return {
      range: 'week',
      loading: false,
      error: '',
      report: null,
      expanded: '',
      showSearch: false,
      presetSearchProject: '',
      requestId: 0,
      ranges: [
        { id: 'day', label: '今天' },
        { id: 'week', label: '本周' },
        { id: 'month', label: '本月' }
      ]
    };
  },
  computed: {
    projectNames() {
      return (this.report && this.report.projects ? this.report.projects : []).map(p => p.name);
    },
    dateRange() {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start = new Date(end);
      if (this.range === 'week') {
        // 周一为一周起点：国内习惯，也与「本周」这个词的直觉一致
        const dow = (end.getDay() + 6) % 7;
        start.setDate(end.getDate() - dow);
      } else if (this.range === 'month') {
        start.setDate(1);
      }
      return { from: this.dateStr(start), to: this.dateStr(end) };
    },
    rangeLabel() {
      const { from, to } = this.dateRange;
      return from === to ? from : `${from} — ${to}`;
    }
  },
  watch: {
    range: { handler() { this.reload(); } }
  },
  mounted() { this.reload(); },
  methods: {
    dateStr(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    setRange(id) { this.range = id; },
    async reload() {
      const id = ++this.requestId;
      this.loading = true;
      this.error = '';
      try {
        const res = await ipc.invoke('get-project-report', this.dateRange);
        if (id !== this.requestId) return;
        if (!res || !res.ok) {
          this.error = (res && res.error) || '统计失败';
          this.report = null;
          return;
        }
        this.report = res.report;
        // 展开的项目如果在新结果里没了（换了时间范围），就收起来，
        // 否则会留下一个引用不存在项目的空面板
        if (this.expanded && !this.report.projects.some(p => p.name === this.expanded)) {
          this.expanded = '';
        }
      } catch (e) {
        if (id === this.requestId) { this.error = e.message || '统计失败'; this.report = null; }
      } finally {
        if (id === this.requestId) this.loading = false;
      }
    },
    toggle(name) { this.expanded = this.expanded === name ? '' : name; },
    /** 展开检索区并预填项目名：不跳到别的页面，保持上下文 */
    openSearchFor(name) {
      this.showSearch = true;
      this.presetSearchProject = name;
    },
    sortedDays(p) {
      return Object.fromEntries(Object.entries(p.byDate || {}).sort((a, b) => a[0].localeCompare(b[0])));
    },
    shortDate(date) {
      const [, m, d] = date.split('-');
      return `${Number(m)}/${Number(d)}`;
    },
    barWidth(p) {
      // 相对于「最大的那个项目」而不是相对总量：项目多的时候
      // 相对总量会让所有条都很短，看不出差异
      const max = Math.max(...this.report.projects.map(x => x.durationMs), 1);
      return `${Math.max(2, Math.round((p.durationMs / max) * 100))}%`;
    },
    fmt(ms) {
      const m = Math.round((Number(ms) || 0) / 60000);
      if (m < 60) return `${m} 分钟`;
      const h = Math.floor(m / 60);
      const rest = m % 60;
      return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
    },
    pct(n) { return `${Math.round((Number(n) || 0) * 100)}%`; }
  }
};
</script>

<style scoped>
.projects { height: 100%; overflow-y: auto; padding: var(--sp-5); }
.proj-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-4); flex-wrap: wrap; }
.proj-title { display: flex; flex-direction: column; gap: 2px; }
.proj-title h2 { margin: 0; font-size: var(--fs-16); font-weight: var(--fw-semibold); }
.proj-sub { color: var(--text-tertiary); font-size: var(--fs-10); }
.proj-controls { display: flex; align-items: center; gap: var(--sp-2); }

.seg-group { display: inline-flex; border: 1px solid var(--border-subtle); border-radius: var(--r-sm); overflow: hidden; }
.seg-btn { padding: 5px 12px; border: 0; background: transparent; color: var(--text-secondary); font-size: var(--fs-11); cursor: pointer; }
.seg-btn + .seg-btn { border-left: 1px solid var(--border-subtle); }
.seg-btn.active { background: var(--bg-raised, #1c1c1c); color: var(--text-primary); font-weight: var(--fw-semibold); }

.proj-section { margin-bottom: var(--sp-4); }
.section-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 2px; border: 0; background: none; cursor: pointer;
  color: var(--text-secondary); font-size: var(--fs-11); text-align: left;
}
.section-toggle:hover { color: var(--text-primary); }
.section-hint { color: var(--text-tertiary); font-size: var(--fs-10); margin-left: auto; }
.section-body { padding: var(--sp-2) 0 var(--sp-3); }
.proj-state { padding: var(--sp-6); text-align: center; color: var(--text-tertiary); font-size: var(--fs-11); }
.proj-state.is-error { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); color: var(--danger, #e06060); }
.proj-state.is-empty p { margin: 4px 0; }
.proj-hint { color: var(--text-tertiary); }
.link-btn { border: 0; background: none; color: var(--accent, #6ea8fe); cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline; }

.proj-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); margin-bottom: var(--sp-3); }
.sum-item { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-3); border-radius: var(--r-sm); background: var(--bg-inset); }
.sum-label { color: var(--text-tertiary); font-size: var(--fs-10); }
.sum-item strong { font-size: var(--fs-18); font-weight: var(--fw-semibold); }
.sum-item.is-warn strong { color: var(--warning, #d09a4a); }

.proj-note {
  margin-bottom: var(--sp-4); padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm); background: rgba(208, 154, 74, 0.08);
  color: var(--text-secondary); font-size: var(--fs-10); line-height: 1.6;
}

.proj-list { margin: 0; padding: 0; list-style: none; }
.proj-row { border-bottom: 1px solid var(--border-subtle); }
.proj-row-head {
  display: grid; grid-template-columns: 16px minmax(80px, 180px) 1fr auto auto;
  align-items: center; gap: var(--sp-3); width: 100%;
  padding: 10px 4px; border: 0; background: none; cursor: pointer; text-align: left;
  color: var(--text-primary);
}
.proj-row-head:hover { background: var(--bg-inset); }
.proj-caret { color: var(--text-tertiary); font-size: 10px; }
.proj-name { font-size: var(--fs-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-bar-wrap { height: 6px; border-radius: 3px; background: var(--bg-inset); overflow: hidden; }
.proj-bar { display: block; height: 100%; border-radius: 3px; background: var(--accent, #6ea8fe); opacity: 0.75; }
.proj-dur { font-size: var(--fs-11); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.proj-pct { font-size: var(--fs-10); color: var(--text-tertiary); width: 40px; text-align: right; font-variant-numeric: tabular-nums; }

.proj-detail { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); padding: var(--sp-3) 4px var(--sp-4) 32px; }
.detail-col { display: flex; flex-direction: column; gap: 6px; }
.detail-label { color: var(--text-tertiary); font-size: var(--fs-10); font-weight: var(--fw-semibold); }
.detail-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 3px 8px; border-radius: 999px; background: var(--bg-inset); font-size: var(--fs-10); color: var(--text-secondary); }
.chip em { font-style: normal; color: var(--text-tertiary); margin-left: 4px; }
.detail-days { display: flex; flex-wrap: wrap; gap: 8px; }
.day-item { display: flex; flex-direction: column; font-size: var(--fs-10); color: var(--text-secondary); }
.day-date { color: var(--text-tertiary); }
.detail-actions { grid-column: 1 / -1; display: flex; gap: var(--sp-2); }

@media (max-width: 720px) {
  .proj-row-head { grid-template-columns: 16px 1fr auto auto; }
  .proj-bar-wrap { display: none; }
  .proj-detail { grid-template-columns: 1fr; padding-left: 20px; }
  .proj-summary { grid-template-columns: 1fr; }
}
</style>
