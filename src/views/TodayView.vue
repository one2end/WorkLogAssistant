<template>
  <div class="today">
    <div class="today-head">
      <DateNav
        :selected-date="selectedDate"
        :dates-with-data="datesWithData"
        @update:selected-date="$emit('select-date', $event)"
        @shift="$emit('shift-date', $event)"
        @today="$emit('go-today')"
      />
      <div class="head-actions">
        <button class="custom-launch" title="自定义首页卡片" @click="$emit('open-plugin-settings', 'dashboard')">
          <Icon name="settings" :size="13" />
          <span>自定义首页</span>
        </button>
        <button v-if="pomodoroOn" class="focus-launch" @click="$emit('start-focus')">
          <Icon name="zen" :size="14" />
          <span>开始专注</span>
        </button>
      </div>
    </div>

    <!-- 首屏：核心数字 + 一天的时间带 -->
    <section class="hero card">
      <div class="hero-top">
        <div class="hero-lead">
          <div class="hero-label">
            <span class="live-dot"></span>
            {{ isToday ? '今日记录时长' : '当日记录时长' }}
            <span class="hero-date">{{ isToday ? '今天' : report.date }}</span>
          </div>
          <div class="hero-value">
            <span>{{ heroHours }}</span><span class="hero-unit">小时</span>
            <span class="hero-min">{{ heroMinutes }}</span><span class="hero-unit">分钟</span>
          </div>
          <div class="hero-sub">
            <span v-if="hasData">
              15 分钟格 00:00 – {{ coverageEnd }}
              · 覆盖 {{ pct(recordedCoverage) }}
            </span>
            <span v-else>还没有记录</span>
          </div>

          <!-- 支撑数字的三个次级指标：小一号，跟着数字走，不跟它抢位置 -->
          <div class="hero-stats">
            <span class="stat">
              <span class="stat-label">应用</span>
              <span class="stat-value">{{ appCount }}</span>
            </span>
            <span class="stat">
              <span class="stat-label">片段</span>
              <span class="stat-value">{{ sessionCount }}</span>
            </span>
            <span class="stat" :class="{ 'is-warn': idleMinutes >= 60 }">
              <span class="stat-label">离座</span>
              <span class="stat-value">
                <template v-if="idleParts.h">{{ idleParts.h }}<i>h</i></template>
                <template v-if="idleParts.m">{{ idleParts.m }}<i>m</i></template>
                <template v-if="!idleParts.h && !idleParts.m">0</template>
              </span>
            </span>
          </div>
        </div>

        <!-- 今日首屏最重要的一格：此刻正在做什么 -->
        <div v-if="isToday && cards.session" class="hero-live" :class="{ 'is-idle': !current || current.idle, 'is-off': !recorder || !recorder.running }">
          <div class="live-head">
            <span class="live-pip"></span>
            <span class="live-label">{{ liveLabel }}</span>
            <span v-if="current && !current.idle" class="live-time">{{ elapsedText }}</span>
          </div>
          <template v-if="current && !current.idle">
            <div class="live-app" :title="current.app">{{ current.app }}</div>
            <div class="live-title" :title="current.title">{{ current.title || '当前窗口' }}</div>
          </template>
          <template v-else>
            <div class="live-app">{{ liveIdleTitle }}</div>
            <div class="live-title">{{ liveIdleHint }}</div>
          </template>
        </div>
      </div>

      <div v-if="hasBlank" class="hero-meta">
        <div class="hero-blank">
          <Icon name="moon" :size="12" />
          <span>{{ blankHint }}</span>
          <button v-if="biggestBlank" class="hero-blank-go" @click="jumpToBlank">去补记</button>
        </div>
      </div>

      <EmptyIllustration
        v-if="!hasData"
        class="hero-illustration"
        variant="clock"
        :size="120"
      />

      <div class="day-band">
        <div class="band-head">
          <span class="band-title">一天的时间分布</span>
          <span class="band-legend">彩色有记录 · 深色无记录 · 白线为现在</span>
        </div>
        <div class="band-track">
          <button
            v-for="(cell, i) in bandCells"
            :key="i"
            type="button"
            class="band-cell"
            :class="{ 'is-empty': !cell.hasData }"
            :style="{ background: cell.color, opacity: cell.opacity }"
            :title="cell.title"
            :aria-label="cell.title"
            @click="onBandClick(i, cell)"
          ></button>
          <span v-if="isToday" class="band-now" :style="{ left: nowPercent + '%' }"></span>
        </div>
        <div class="band-ticks">
          <span v-for="t in bandTicks" :key="t.label" :style="{ left: t.left + '%' }">{{ t.label }}</span>
        </div>
      </div>
    </section>

    <section v-if="hasData" class="card balance-card">
      <div class="card-head">
        <span class="card-title">一天的时间账本</span>
        <span class="head-note">按 15 分钟格估算 · 未解释不等于休息</span>
      </div>
      <div class="balance-track" role="img" :aria-label="dayBalance.map(x => `${x.label} ${Math.round(x.minutes)} 分钟`).join('，')">
        <span v-for="item in dayBalance" :key="item.label" :style="{ width: (item.minutes / 1440 * 100) + '%', background: item.color }" :title="`${item.label} ${Math.round(item.minutes)} 分钟`"></span>
      </div>
      <div class="balance-legend">
        <div v-for="item in dayBalance" :key="item.label"><i :style="{ background: item.color }"></i><span>{{ item.label }}</span><strong>{{ fmt(item.minutes * 60000) }}</strong></div>
      </div>
    </section>

    <section v-if="suggestions.length" class="card suggestion-card">
      <div class="card-head">
        <span class="card-title">可一键确认的分类</span>
        <span class="head-note">根据过去 90 天的手工确认 · 仅存本机</span>
      </div>
      <div v-for="item in suggestions" :key="item.startMin" class="suggestion-row">
        <span class="suggestion-time">{{ pad(Math.floor(item.startMin / 60)) }}:{{ pad(item.startMin % 60) }}</span>
        <span class="suggestion-copy"><strong>{{ item.app }}</strong><small>{{ item.previousCategory || '未分类' }} → {{ item.category }} · {{ item.evidence }} 次历史确认</small></span>
        <button class="btn btn-secondary btn-sm" :aria-label="`把 ${item.app} 的这一格标为 ${item.category}`" @click="$emit('accept-suggestion', item)">确认</button>
        <button class="btn btn-ghost btn-sm" :aria-label="`忽略 ${item.app} 的这条建议`" @click="$emit('dismiss-suggestion', item)">忽略</button>
      </div>
    </section>

    <!-- AI：能力开启后才出现在这里；关闭时只是一行提示 -->
    <div class="ai-row">
    <AiPanel
      :enabled="aiEnabled"
      :ready="aiReady"
      :summaries="summaries"
      :generating="generatingSummary"
      :selected-date="selectedDate"
      :has-data="hasData"
      :provider="aiProvider"
      @generate="$emit('generate-summary')"
      @open-settings="$emit('open-ai-settings')"
    />
    </div>

    <!-- 本地规则提示与模型回顾分开，避免把确定性统计误称为 AI 建议。 -->
    <section v-if="cards.aiInsights && (hasData || report.dataNotes?.length)" class="card insight-card">
      <div class="card-head">
        <span class="card-title">记录提示</span>
        <span class="insight-tag">本地检查</span>
      </div>
      <div class="insight-list">
        <div v-for="(it, i) in insights" :key="i" class="insight-item">
          <span class="insight-dot" :style="{ background: it.color }" />
          <span class="insight-text">{{ it.text }}</span>
          <span class="insight-meta">{{ it.meta }}</span>
        </div>
        <div v-for="(n, i) in report.dataNotes || []" :key="'data-' + i" class="insight-item">
          <span class="insight-dot" style="background: var(--warning)" />
          <span class="insight-text">{{ n }}</span>
          <span class="insight-meta">数据口径</span>
        </div>
      </div>
      <p class="insight-note">依据当前记录计算，仅供检查；不会自动修改原始数据。</p>
    </section>

    <!-- 活跃度：跨度由设置页的热力图周数决定 -->
    <section v-if="cards.heatmap" class="card heat-card">
      <div class="card-head">
        <span class="card-title">记录时长 · {{ heatWeeks }} 周</span>
        <span class="head-note">{{ selectedDate }} · {{ heatSummary }}</span>
      </div>
      <ActivityHeatmap
        :days="heatDaily"
        :selected-date="selectedDate"
        :range-from="heatFrom"
        :range-to="heatTo"
        :can-go-forward="heatCanGoForward"
        :weeks="heatWeeks"
        @select-date="$emit('select-date', $event)"
        @shift-range="$emit('shift-range', $event)"
        @pick-month="$emit('pick-month', $event)"
        @heat-today="$emit('heat-today')"
      />
    </section>

    <!-- 分类分布 -->
    <section v-if="cards.composition" class="card">
      <div class="card-head">
        <span class="card-title">已记录时间的构成</span>
        <span class="head-note">不含未记录时段 · {{ catList.length }} 类</span>
      </div>

      <template v-if="hasData">
        <div class="stack">
          <div
            v-for="c in catList"
            :key="c.name"
            class="stack-seg"
            :style="{ width: (c.percent * 100).toFixed(2) + '%', background: colorOf(c.name) }"
            :title="`${categoryLabel(c.name)} ${fmt(c.durationMs)}`"
          ></div>
        </div>

        <ul class="cat-list">
          <li v-for="c in catList" :key="c.name" class="cat-row">
            <span class="cat-dot" :style="{ background: colorOf(c.name) }"></span>
            <span class="cat-name">{{ categoryLabel(c.name) }}</span>
            <span class="cat-bar">
              <span class="cat-bar-fill" :style="{ width: (c.percent * 100).toFixed(1) + '%', background: colorOf(c.name) }"></span>
            </span>
            <span class="cat-time">{{ fmt(c.durationMs) }}</span>
            <span class="cat-pct">{{ pct(c.percent) }}</span>
          </li>
        </ul>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="chart" :size="88" /></span>
        <span class="empty-title">暂无数据</span>
        <span class="empty-desc">保持记录，稍后这里会显示时间构成</span>
      </div>
    </section>

    <!-- 应用排行 -->
    <section v-if="cards.apps" class="card">
      <div class="card-head">
        <span class="card-title">应用排行</span>
        <span class="head-note">仅后台录制 · 按应用汇总 · Top {{ topRankedApps.length }}</span>
      </div>

      <template v-if="topRankedApps.length">
        <ul class="app-list">
          <li v-for="(a, i) in topRankedApps" :key="a.processName || a.name" class="app-row">
            <span class="app-rank">{{ i + 1 }}</span>
            <span class="app-main">
              <span class="app-name-row">
                <span class="app-name" :title="a.processName || a.name">{{ a.processName || a.name }}</span>
                <span class="app-time">{{ fmt(a.durationMs) }}</span>
              </span>
              <span class="app-bar">
                <span
                  class="app-bar-fill"
                  :style="{ width: (a.durationMs / maxAppMs * 100).toFixed(1) + '%', background: colorOf(a.category) }"
                ></span>
              </span>
              <span v-if="windowHint(a)" class="app-titles" :title="windowHint(a)">{{ windowHint(a) }}</span>
            </span>
          </li>
        </ul>
      </template>

      <div v-else class="empty">
        <span class="empty-icon"><EmptyIllustration variant="grid" :size="88" /></span>
        <span class="empty-title">暂无应用记录</span>
      </div>
    </section>

    <!-- 专注与随手记 -->
    <section v-if="hasFocus && cards.focusNotes" class="card">
      <div class="card-head">
        <span class="card-title">专注与随手记</span>
        <span class="head-note">{{ focus.sessions.length }} 次专注 · {{ focus.notes.length }} 条记录</span>
      </div>

      <ul v-if="focus.sessions.length" class="focus-list">
        <li v-for="(s, i) in focus.sessions" :key="'s' + i" class="focus-row">
          <Icon name="zen" :size="13" />
          <span v-if="editingFocus?.kind === 'session' && editingFocus.id === s.id" class="focus-edit">
            <input v-model="focusDraft" maxlength="160" aria-label="专注内容" placeholder="专注内容">
            <input v-model="focusNoteDraft" maxlength="1000" aria-label="专注备注" placeholder="备注，可留空">
            <button class="btn btn-primary btn-sm" :disabled="!focusDraft.trim()" @click="saveFocusEdit">保存</button>
            <button class="btn btn-ghost btn-sm" @click="editingFocus = null">取消</button>
          </span>
          <span v-else class="focus-text"><strong>{{ s.focusText || '未命名专注' }}</strong><small v-if="s.note">{{ s.note }}</small></span>
          <span class="focus-time">{{ fmt(s.durationMs) }}</span>
          <button v-if="editingFocus?.id !== s.id" class="btn btn-ghost btn-sm" :aria-label="`修改专注 ${s.focusText}`" @click="startFocusEdit('session', s)">修改</button>
        </li>
      </ul>

      <ul v-if="focus.notes.length" class="note-items">
        <li v-for="(n, i) in focus.notes" :key="'n' + i" class="note-item">
          <span class="note-time">{{ hm(n.time) }}</span>
          <span v-if="editingFocus?.kind === 'note' && editingFocus.id === n.id" class="focus-edit">
            <input v-model="focusDraft" maxlength="1000" aria-label="随手记内容" @keyup.enter="saveFocusEdit">
            <button class="btn btn-primary btn-sm" :disabled="!focusDraft.trim()" @click="saveFocusEdit">保存</button>
            <button class="btn btn-ghost btn-sm" @click="editingFocus = null">取消</button>
          </span>
          <span v-else class="note-text">{{ n.text }}</span>
          <button v-if="editingFocus?.id !== n.id" class="btn btn-ghost btn-sm" :aria-label="`修改随手记 ${n.text}`" @click="startFocusEdit('note', n)">修改</button>
        </li>
      </ul>
    </section>

    <!-- 插件坞固定在首页最底部：不抢主视觉，作为整机的「能力底座」 -->
    <PluginDock
      :config="config"
      :dida-status="didaStatus"
      :insight-count="insights.filter(item => item.meta !== '已就绪').length"
      @toggle="$emit('toggle-plugin', $event)"
      @settings="$emit('open-plugin-settings', $event)"
    />
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import ActivityHeatmap from '../components/ActivityHeatmap.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';
import AiPanel from '../components/AiPanel.vue';
import PluginDock from '../components/PluginDock.vue';
import { colorForCategory } from '../styles/palette.js';
import { readPath } from '../plugins/registry.js';

function balanceFromSlots(report) {
  const totals = { work: 0, life: 0, sleep: 0, other: 0, unknown: 1440 };
  for (const slot of report.slots || []) {
    const minutes = Math.max(0, Math.min(15, Number(slot.filledMin) || 0));
    totals.unknown -= minutes;
    if (slot.category === '睡眠') totals.sleep += minutes;
    else if (['生活', '娱乐'].includes(slot.category)) totals.life += minutes;
    else if (['工作', '学习', '专注'].includes(slot.category)) totals.work += minutes;
    else totals.other += minutes;
  }
  totals.unknown = Math.max(0, totals.unknown);
  return totals;
}

export default {
  name: 'TodayView',
  components: { Icon, DateNav, ActivityHeatmap, EmptyIllustration, AiPanel, PluginDock },
  props: {
    config: { type: Object, default: () => ({}) },
    report: { type: Object, required: true },
    recorder: { type: Object, default: null },
    isToday: { type: Boolean, default: true },
    heatDaily: { type: Array, default: () => [] },
    selectedDate: { type: String, default: '' },
    datesWithData: { type: Set, default: () => new Set() },
    theme: { type: String, default: 'dark' },
    heatFrom: { type: String, default: '' },
    heatTo: { type: String, default: '' },
    heatCanGoForward: { type: Boolean, default: false },
    heatWeeks: { type: Number, default: 12 },
    didaStatus: { type: Object, default: () => ({}) },
    // AI 是能力层：关闭时这里只显示一条提示，开启后才变成一张卡片
    summaries: { type: Array, default: () => [] },
    suggestions: { type: Array, default: () => [] },
    aiEnabled: { type: Boolean, default: false },
    aiReady: { type: Boolean, default: false },
    aiProvider: { type: String, default: '' },
    generatingSummary: { type: Boolean, default: false }
  },
  emits: ['jump-to-time', 'select-date', 'shift-date', 'go-today',
    'shift-range', 'pick-month', 'heat-today', 'start-focus',
    'generate-summary', 'open-ai-settings', 'toggle-plugin', 'open-plugin-settings', 'accept-suggestion', 'dismiss-suggestion', 'update-focus'],
  data() {
    return { tick: 0, timer: null, editingFocus: null, focusDraft: '', focusNoteDraft: '' };
  },
  computed: {
    /** 首页卡片显隐：配置缺字段时默认全开，旧配置不用迁移 */
    cards() {
      const all = {};
      ['heatmap', 'session', 'composition', 'apps', 'dataNotes', 'focusNotes', 'aiInsights']
        .forEach(k => { all[k] = true; });
      return { ...all, ...((this.config && this.config.dashboard && this.config.dashboard.cards) || {}) };
    },
    pomodoroOn() {
      const v = readPath(this.config || {}, 'focus.enabled');
      return v === undefined ? true : !!v;
    },
    dayBalance() {
      const totals = this.report.dayBalance || balanceFromSlots(this.report);
      return [
        { label: ['工作', '学习', '专注'].map(c => this.categoryLabel(c)).join('/'), minutes: totals.work, color: 'var(--accent)' },
        { label: ['生活', '娱乐'].map(c => this.categoryLabel(c)).join('/'), minutes: totals.life, color: 'var(--success)' },
        { label: this.categoryLabel('睡眠'), minutes: totals.sleep, color: '#8d80ba' },
        { label: '已记录其他', minutes: totals.other, color: 'var(--text-tertiary)' },
        { label: '未解释', minutes: Math.max(0, totals.unknown), color: 'var(--border-strong)' }
      ];
    },
    /**
     * 本地规则提示独立于 AI 开关，避免将统计结果误称为模型建议。
     */
    insights() {
      const r = this.report || {};
      const st = r.stats || {};
      const sessions = r.sessions || [];
      const out = [];
      const short = sessions.filter(s => {
        const d = Number(s.durationMs) || 0;
        return d > 0 && d < 15 * 60000;
      }).length;
      if (short >= 3) {
        out.push({ text: `有 ${short} 段短于 15 分钟的记录，可能是在同一件事里来回切换`, meta: '合并候选', color: '#3b7ddd' });
      }
      const idleMin = Math.round((Number(st.idleMs) || 0) / 60000);
      if (idleMin >= 60) {
        out.push({ text: `记录到 ${(idleMin / 60).toFixed(1)} 小时离座；如有需要，可补充这段时间在做什么`, meta: '可补充', color: '#d99a2b' });
      }
      const cov = this.recordedCoverage;
      if (cov > 0 && cov < 0.6 && (Number(st.recordedMs) || 0) > 0) {
        out.push({ text: `从 00:00 至今，已有 ${Math.round(cov * 100)}% 的 15 分钟格包含记录；可查看时间轴补充空格`, meta: '查看时间轴', color: '#8374c9' });
      }
      if (!out.length) {
        out.push({ text: '今天的记录比较完整，暂无明显待确认线索', meta: '已就绪', color: '#2f9c73' });
      }
      return out.slice(0, 4);
    },
    /** 时间构成用 7 个展示分组；后端没给分组时退回细分分类 */
    catList() {
      const r = this.report || {};
      return (r.categoriesGrouped && r.categoriesGrouped.length ? r.categoriesGrouped : r.categories) || [];
    },
    // 把 report.sessions 摊到 24h / 96 格（15 分钟一格），取每格的主导分类着色
    bandCells() {
      const cells = Array.from({ length: 96 }, () => ({ total: 0, byCat: {} }));
      const sessions = (this.report && this.report.sessions) || [];
      for (const s of sessions) {
        const start = new Date(s.start);
        const end = new Date(s.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        const a = start.getHours() * 60 + start.getMinutes();
        let b = end.getHours() * 60 + end.getMinutes();
        if (b <= a) b = Math.min(1440, a + Math.max(1, Math.round((s.durationMs || 0) / 60000)));
        b = Math.min(1440, b);
        const cat = s.category || '其他';
        for (let idx = Math.floor(a / 15); idx <= Math.floor((b - 1) / 15) && idx < 96; idx++) {
          if (idx < 0) continue;
          const from = Math.max(a, idx * 15);
          const to = Math.min(b, (idx + 1) * 15);
          const mins = Math.max(0, to - from);
          if (!mins) continue;
          cells[idx].total += mins;
          cells[idx].byCat[cat] = (cells[idx].byCat[cat] || 0) + mins;
        }
      }
      return cells.map((cell, i) => {
        const top = Object.entries(cell.byCat).sort((x, y) => y[1] - x[1])[0];
        const mins = i * 15;
        const at = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
        const common = { minutes: mins, hasData: !!top };
        if (!top) {
          return { ...common, color: 'var(--bg-inset)', opacity: 1, title: `${at} · 无记录` };
        }
        return {
          ...common,
          color: this.colorOf(top[0]),
          opacity: (0.42 + Math.min(1, cell.total / 15) * 0.58).toFixed(2),
          title: `${at} · ${this.categoryLabel(top[0])} ${Math.round(cell.total)} 分钟`
        };
      });
    },
    bandTicks() {
      return [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
        label: `${String(h).padStart(2, '0')}:00`,
        left: (h / 24 * 100).toFixed(2)
      }));
    },
    nowPercent() {
      void this.tick;
      const d = new Date();
      return ((d.getHours() * 60 + d.getMinutes()) / 1440 * 100).toFixed(2);
    },
    hasData() {
      return this.report && this.report.stats && this.report.stats.recordCount > 0;
    },
    heatSummary() {
      const days = this.heatDaily || [];
      const active = days.filter((d) => (d.trackedMs || 0) > 0).length;
      const total = days.reduce((s, d) => s + (d.trackedMs || 0), 0);
      return `${active} 天有记录 · 累计 ${Math.round(total / 3600000)}h`;
    },
    focus() {
      const f = (this.report && this.report.focus) || {};
      return {
        sessions: [...(f.arhatSessions || f.sessions || []), ...(f.didaSessions || [])]
          .sort((a, b) => new Date(a.start) - new Date(b.start)),
        notes: f.notes || []
      };
    },
    hasFocus() {
      return this.focus.sessions.length > 0 || this.focus.notes.length > 0;
    },
    heroHours() {
      return Math.floor(this.heroTotalMinutes / 60);
    },
    heroMinutes() {
      return String(this.heroTotalMinutes % 60).padStart(2, '0');
    },
    appCount() {
      return (this.report.recordedApps || this.rankedApps || []).length;
    },
    sessionCount() {
      return this.report.stats.sessionCount || 0;
    },
    idleMinutes() {
      return Math.round((this.report.stats.idleMs || 0) / 60000);
    },
    /** 拆成 h/m 两段，单位用更小的字重排，跟「8 小时 45 分钟」的排版语言一致 */
    idleParts() {
      const total = this.idleMinutes;
      return { h: Math.floor(total / 60), m: total % 60 };
    },
    heroTotalMinutes() {
      // 必须是 15 分钟的整数倍：一天被 15 分钟格切分，已记录的格数就是全部。
      // 所以 21 小时必然意味着还有 3 小时空白，界面据此提示去补录。
      return Math.round(this.recordedMs / 60000);
    },
    recordedCoverage() {
      return this.report.stats.coverage || 0;
    },
    coverageEnd() {
      const count = this.report.stats.elapsedSlots || (this.isToday ? Math.ceil((new Date().getHours() * 60 + new Date().getMinutes() + 1) / 15) : 96);
      const minutes = Math.min(1440, count * 15);
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    },
    /**
     * 当日记录时长：按 15 分钟格算，必为 15 的倍数。
     *
     * 优先用后端的 slotFilledMs（满格数 × 15 分钟）；
     * 字段缺失时（例如后端未升级、report 是旧结构）就地按 slots 现算，
     * 保证不会出现 7 分 23 秒这种数字。
     */
    recordedMs() {
      const stats = (this.report && this.report.stats) || {};
      if (stats.slotFilledMs !== undefined && stats.slotFilledMs !== null) return stats.slotFilledMs;
      const slotMin = stats.slotMin || 15;
      const slots = (this.report && this.report.slots) || [];
      const full = slots.filter(x => (x.filledMin || 0) >= slotMin).length;
      return full * slotMin * 60000;
    },
    /** 真正的空白：完全没有任何记录的格子 */
    blankMs() {
      const stats = (this.report && this.report.stats) || {};
      if (stats.blankMs !== undefined && stats.blankMs !== null) return stats.blankMs;
      const slotMin = stats.slotMin || 15;
      const slots = (this.report && this.report.slots) || [];
      const empty = slots.filter(x => !x.filledMin).length;
      return empty * slotMin * 60000;
    },
    /** 连续空白段，区分「集中 4 小时」还是「零散十几分钟」 */
    blankRanges() {
      const stats = this.report && this.report.stats ? this.report.stats : {};
      const r = stats.blankRanges;
      if (Array.isArray(r)) return r;
      // 兜底：就地按 slots 找连续空白格
      const slotMin = stats.slotMin || 15;
      const elapsed = stats.elapsedSlots || 0;
      const out = [];
      let start = -1;
      const slots = (this.report && this.report.slots) || [];
      for (let i = 0; i <= elapsed; i += 1) {
        const empty = i < elapsed && !(slots[i] && slots[i].filledMin);
        if (empty && start < 0) start = i;
        if (!empty && start >= 0) {
          out.push({ startMin: start * slotMin, endMin: i * slotMin, durationMin: (i - start) * slotMin });
          start = -1;
        }
      }
      return out;
    },
    /** 未记满的格子数（记了但不足 15 分钟） */
    partialSlots() {
      const s = this.report.stats || {};
      if (s.partialSlots !== undefined && s.partialSlots !== null) return s.partialSlots;
      const slotMin = s.slotMin || 15;
      return (this.report.slots || []).filter(x => x.filledMin > 0 && x.filledMin < slotMin).length;
    },
    /** 有欠账才显示提示条：完全空白，或有没记满的格子 */
    hasBlank() {
      return this.blankMs > 0 || this.partialSlots > 0;
    },
    /** 最长的一段空白 */
    biggestBlank() {
      let best = null;
      for (const r of this.blankRanges) {
        if (!best || r.durationMin > best.durationMin) best = r;
      }
      return best;
    },
    /**
     * 欠账提示。
     *
     * 现在「没记满」这种状态基本不存在了：自动录制必须占满整格才算数，
     * 否则那格就是空白、可以手工补记。所以这里只讲「完全空白」，
     * 以及零碎的自动采样（它们让某格看起来有内容但其实没做多少事）。
     */
    blankHint() {
      const blankMin = Math.round(this.blankMs / 60000);
      if (blankMin < 15) return '';
      const h = Math.floor(blankMin / 60);
      const m = blankMin % 60;
      const blankText = h ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${m} 分钟`;
      const big = this.biggestBlank;
      const bigText = big && big.durationMin >= 60
        ? `最长一段 ${Math.floor(big.durationMin / 60)} 小时${big.durationMin % 60 ? ` ${big.durationMin % 60} 分` : ''}`
        : '都是零散空白';
      return `有 ${blankText} 完全空白 · ${bigText}`;
    },
    rankedApps() {
      return this.report.recordedApps || (this.report.apps || []).filter(a => !a.manual);
    },
    topRankedApps() {
      return this.rankedApps.slice(0, 6);
    },
    maxAppMs() {
      return this.topRankedApps.length ? this.topRankedApps[0].durationMs : 1;
    },
    current() {
      if (!this.recorder || !this.recorder.running || !this.isToday) return null;
      const c = this.recorder.current;
      if (!c) return null;
      // 用 since 本地算，避免依赖后端轮询频率
      const elapsed = Date.now() - new Date(c.since).getTime();
      return { ...c, elapsedMs: Math.max(elapsed, 0) };
    },
    elapsedText() {
      if (!this.current) return '';
      const total = Math.floor(this.current.elapsedMs / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    },
    /** 「正在记录 / 离座中 / 已暂停」——这一格的标签由状态决定，不用三个分支写三遍 */
    liveLabel() {
      if (!this.recorder || !this.recorder.running) return '记录已暂停';
      if (!this.current) return '正在记录';
      return this.current.idle ? '离座中' : '正在记录';
    },
    /** 非活动态的主行：说得具体些，别和上面的标签重复同一个词 */
    liveIdleTitle() {
      if (!this.recorder || !this.recorder.running) return '记录已停止';
      if (this.current && this.current.idle) return '离开电脑';
      return '等待操作';
    },
    liveIdleHint() {
      if (!this.recorder || !this.recorder.running) return '在设置里重新开启记录';
      if (this.current && this.current.idle) return '检测到没有键鼠操作';
      return '有窗口活动后会立刻更新';
    }
  },
  mounted() {
    this.timer = setInterval(() => { this.tick += 1; }, 1000);
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    pad(n) { return String(n).padStart(2, '0'); },
    startFocusEdit(kind, item) {
      this.editingFocus = { kind, id: item.id };
      this.focusDraft = kind === 'note' ? item.text : item.focusText;
      this.focusNoteDraft = kind === 'session' ? (item.note || '') : '';
    },
    saveFocusEdit() {
      if (!this.editingFocus || !this.focusDraft.trim()) return;
      const { kind, id } = this.editingFocus;
      this.$emit('update-focus', kind === 'note'
        ? { kind, id, text: this.focusDraft.trim() }
        : { kind, id, focusText: this.focusDraft.trim(), note: this.focusNoteDraft.trim() });
      this.editingFocus = null;
    },
    windowHint(app) {
      const name = app.processName || app.name;
      return this.report.recordedWindows?.find(w => w.app === name)?.title || app.titles?.[0] || '';
    },
    onBandClick(i, cell) {
      this.$emit('jump-to-time', {
        minutes: cell && Number.isFinite(cell.minutes) ? cell.minutes : i * 15,
        date: (this.report && this.report.date) || this.selectedDate
      });
    },
    /**
     * 「去补记」：跳到最长的一段完全空白。
     * 只跳空白格——未满格的格子本来就有内容，跳过去用户会发现「这里有东西啊」，
     * 那是统计口径没对齐，不是真的空缺。
     */
    jumpToBlank() {
      const big = this.biggestBlank;
      if (!big) return;
      this.$emit('jump-to-time', {
        minutes: big.startMin,
        date: (this.report && this.report.date) || this.selectedDate
      });
    },
    colorOf(name) {
      const metaColor = this.config.analysis?.categoryMeta?.[name]?.color;
      if (metaColor && /^#[0-9a-fA-F]{6}$/.test(metaColor)) return metaColor;
      const custom = this.config.analysis?.customCategories?.find(c => (c.key || c.name) === name);
      if (custom && /^#[0-9a-fA-F]{6}$/.test(custom.color)) return custom.color;
      return colorForCategory(this.theme, name);
    },
    categoryLabel(name) {
      return this.config.analysis?.categoryMeta?.[name]?.name ||
        this.config.analysis?.customCategories?.find(c => (c.key || c.name) === name)?.name || name;
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
    },
    pct(n) {
      return `${Math.round((n || 0) * 100)}%`;
    },
    hm(iso) {
      if (!iso) return '--:--';
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
};
</script>

<style scoped>
.today {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  align-items: start;
  gap: var(--sp-5);
  padding: var(--sp-6);
  width: 100%;
  /* 不再锁死 max-width：窗口拉宽时内容跟着重排，而不是两侧留白 */
}

.today > * {
  min-width: 0;
}

/* AI 面板横跨整行：它是一句结论，不该挤在某一列里 */
.today > .ai-row {
  grid-column: 1 / -1;
}

.today > .balance-card { grid-column: 1 / -1; }
.balance-track { display: flex; height: 18px; overflow: hidden; border-radius: var(--r-sm); background: var(--bg-inset); }
.balance-track span { min-width: 0; }
.balance-legend { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); margin-top: var(--sp-4); }
.balance-legend div { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-11); color: var(--text-secondary); }
.balance-legend i { width: 8px; height: 8px; border-radius: 2px; }
.balance-legend strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }

.today > .suggestion-card { grid-column: 1 / -1; }
.suggestion-card { border-color: var(--accent-border); }
.suggestion-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--border-subtle);
}
.suggestion-time { font: var(--fs-12) var(--font-mono); color: var(--text-secondary); }
.suggestion-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.suggestion-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-13); }
.suggestion-copy small { color: var(--text-tertiary); font-size: var(--fs-11); }

/* 顶部条：日期导航 + 专注入口 */
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.custom-launch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--fs-11);
  white-space: nowrap;
}

.custom-launch:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.focus-launch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  color: var(--accent);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease), transform var(--dur-1) var(--ease),
    box-shadow var(--dur-1) var(--ease);
}

.focus-launch:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

/* 宽窗口：只有顶部条与主视觉跨满，其余所有区域一起并排 */
@media (min-width: 900px) {
  .today {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .today > .today-head,
  .today > .hero {
    grid-column: 1 / -1;
  }
}

/* 更宽时升到三列，热力图 / 时间构成 / 应用排行 / 会话 / 专注都能并排 */
@media (min-width: 1320px) {
  .today {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .today > .today-head,
  .today > .hero {
    grid-column: 1 / -1;
  }
}

/* Hero：首屏主视觉。纯表面 + 一层柔影，靠数字本身建立层级；
   之前叠了径向光、线性渐变和彩色描边，反而像一条系统提示横幅。 */
.hero {
  padding: var(--sp-5);
  background: var(--bg-surface);
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-md);
}

.hero-top {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: var(--sp-5);
}

.hero-lead {
  flex: 1 1 auto;
  min-width: 0;
}

/* 次级指标：应用 / 片段 / 离座。
   它们解释「这 8 小时 45 分钟是怎么来的」，跟着数字放在同一列，
   字号小一档、用发丝点分隔，避免和主数字抢视线。 */
.hero-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1) var(--sp-4);
  margin-top: var(--sp-3);
}

.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.stat-value {
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.stat-value i {
  font-style: normal;
  font-size: var(--fs-10);
  font-weight: var(--fw-normal);
  margin-left: 1px;
}

.stat.is-warn .stat-value {
  color: var(--warning);
}

/* 今日首屏最重要的一格：此刻在做什么。
   它和时长数字并排——左边是「已经记了多久」，右边是「现在在记什么」，
   一眼就能看完今天最要紧的两件事。
   底色用 elevated 而不是 accent-soft：浅色主题下 accent-soft 只有 0.1 的透明度，
   整块会淡得像没渲染出来；改成实体表面 + 左侧强调竖条，两套主题都有分量。 */
.hero-live {
  position: relative;
  flex: 0 1 300px;
  min-width: 210px;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--sp-3) var(--sp-4) var(--sp-3) calc(var(--sp-4) + 6px);
  border: 1px solid var(--border-default);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  overflow: hidden;
}

.hero-live::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
}

.hero-live.is-idle,
.hero-live.is-off {
  border-color: var(--border-subtle);
  background: var(--bg-inset);
}

.hero-live.is-idle::before,
.hero-live.is-off::before {
  background: var(--border-strong);
}

.live-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-bottom: 2px;
}

/* 录制中会呼吸的小圆点；静止态就是一颗普通的灰点 */
.live-pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--accent);
  animation: pip 2s var(--ease) infinite;
}

.hero-live.is-idle .live-pip,
.hero-live.is-off .live-pip {
  background: var(--text-tertiary);
  animation: none;
}

@keyframes pip {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.live-label {
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.live-time {
  margin-left: auto;
  font: var(--fs-11) var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  flex: 0 0 auto;
}

.live-app {
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-live.is-idle .live-app,
.hero-live.is-off .live-app {
  color: var(--text-secondary);
  font-weight: var(--fw-medium);
}

.live-title {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 空档提示单独一行，压在首屏底部 */
.hero-meta {
  margin-top: var(--sp-4);
}
.hero-meta > * {
  width: 100%;
  min-width: 0;
}

.hero-label {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--text-secondary);
  font-weight: var(--fw-medium);
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  flex: 0 0 auto;
}

.hero-date {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.hero-value {
  display: flex;
  align-items: baseline;
  gap: 1px;
  margin-top: 6px;
  font-size: var(--fs-40);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.03em;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}

.hero-min {
  margin-left: 6px;
}

.hero-unit {
  font-size: var(--fs-14);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  margin: 0 8px 0 2px;
}

.hero-sub {
  margin-top: 6px;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 极窄（贴边竖条、窗口拖到最窄）时才堆叠。
   断点之所以从 860 降到 560：应用默认主窗口只有 620px 宽，
   断点定在 860 意味着默认状态永远看不到「时长 + 此刻」并排——
   而那正是首屏最该一眼看全的两件事。

   堆叠时用 order 把「此刻」翻到最上面，而不是让它掉到数字下面：
   窗口窄成这样时，用户在找一个答案——「现在记的是什么」，
   累计时长反而是第二位的。DOM 顺序不动，只改视觉顺序。 */
@media (max-width: 560px) {
  .hero-top {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-3);
  }
  .hero-live {
    order: -1;
    flex: 0 0 auto;
    min-width: 0;
    align-self: stretch;
    padding: var(--sp-2) var(--sp-3) var(--sp-2) calc(var(--sp-3) + 6px);
  }
  /* 窄窗里把三行压成两行：标题和时间同一行，窗口标题单独一行 */
  .live-head { margin-bottom: 1px; }
  .live-app { font-size: var(--fs-13); }
}

.hero-illustration {
  display: flex;
  justify-content: center;
  margin-top: var(--sp-4);
  opacity: 0.9;
}

/* 24 小时时间带：借鉴 Rize / Toggl Timeline 的日色带 */
.day-band {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-subtle);
}

.band-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.band-title {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.band-legend {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.band-track {
  position: relative;
  display: flex;
  gap: 1px;
  height: 34px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
}

.band-cell {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  transition: opacity var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease),
    background-color 420ms var(--ease);
}

.band-cell:hover {
  opacity: 1 !important;
  box-shadow: inset 0 0 0 1px var(--accent);
}
.band-cell:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.band-cell.is-empty:hover {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.band-now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--text-primary);
  box-shadow: 0 0 0 1px var(--bg-surface);
  pointer-events: none;
}

.band-ticks {
  position: relative;
  height: 18px;
  margin-top: 7px;
}

.band-ticks span {
  position: absolute;
  transform: translateX(-50%);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 当前会话 */
.session {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.session.idle {
  border-color: var(--border-subtle);
  background: var(--bg-surface);
}

.session-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  color: var(--accent);
  flex: 0 0 auto;
}

.session.idle .session-icon {
  color: var(--text-tertiary);
}

.session-body {
  flex: 1;
  min-width: 0;
}

.session-app {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.session-time {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.session-title {
  font-size: var(--fs-11);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

.session-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--r-full);
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
  background: var(--bg-inset);
  color: var(--text-tertiary);
}

.session-badge.live {
  background: var(--success-soft);
  color: var(--success);
}

/* 堆叠条 */
.head-note {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.stack {
  display: flex;
  height: 18px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
  gap: 2px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
}

.stack-seg {
  height: 100%;
  border-radius: 2px;
  transition: opacity var(--dur-1) var(--ease), background-color 420ms var(--ease);
}

.stack-seg:hover {
  opacity: 0.78;
}

/* 分类列表 */
.cat-list {
  list-style: none;
  margin: var(--sp-4) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cat-row {
  display: grid;
  grid-template-columns: 8px 74px 1fr auto 34px;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
}

.cat-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  transition: background-color 420ms var(--ease);
}

.cat-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat-bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  overflow: hidden;
}

.cat-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease), background-color 420ms var(--ease);
}

.cat-time {
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  font-weight: var(--fw-medium);
}

.cat-pct {
  text-align: right;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-11);
}

/* 应用列表 */
.app-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.app-row {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}

.app-rank {
  width: 16px;
  flex: 0 0 auto;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  padding-top: 1px;
}

.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.app-name-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.app-name {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-time {
  font-size: var(--fs-11);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.app-bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  overflow: hidden;
}

.app-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease), background-color 420ms var(--ease);
}

.app-titles {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manual-note {
  margin: var(--sp-3) 0 0;
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

/* 数据说明 */
.note-card {
  background: var(--bg-surface);
  border-color: var(--border-subtle);
}

.note-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-11);
  font-weight: var(--fw-semibold);
  color: var(--warning);
  margin-bottom: 6px;
}

.note-list {
  margin: 0;
  padding-left: 16px;
  font-size: var(--fs-11);
  color: var(--text-secondary);
  line-height: var(--lh-snug);
}

/* 专注 */
.focus-list,
.note-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.focus-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--accent);
}

.focus-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  color: var(--text-primary);
}
.focus-text strong,
.focus-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.focus-text strong { font-size: var(--fs-12); font-weight: var(--fw-medium); }
.focus-text small { color: var(--text-secondary); font-size: var(--fs-11); }
.focus-edit { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 5px; }
.focus-edit input { flex: 1 1 130px; min-width: 90px; }

.focus-time {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.note-items {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

.note-item {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-11);
  line-height: var(--lh-snug);
}

.note-time {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  flex: 0 0 auto;
}

.note-text {
  flex: 1;
  color: var(--text-secondary);
}

/* ---------- AI 分析与提示 ---------- */
.insight-tag {
  padding: 2px 8px;
  border-radius: var(--r-full);
  font-size: var(--fs-11);
  color: var(--accent);
  background: var(--accent-soft);
}
.insight-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.insight-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}
.insight-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.insight-text { flex: 1; min-width: 0; font-size: var(--fs-13); color: var(--text-primary); }
.insight-meta { flex: none; font-size: var(--fs-11); color: var(--text-tertiary); }
.insight-note { margin-top: var(--sp-3); font-size: var(--fs-11); color: var(--text-tertiary); line-height: 1.6; }

/* ---------- 空档提示 ---------- */
.hero-blank {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-12);
  color: var(--text-secondary);
  background: var(--bg-inset);
}
.hero-blank { flex-wrap: wrap; }
.hero-blank span { flex: 1 1 160px; min-width: 0; line-height: 1.5; }
.hero-blank-go {
  flex: none;
  padding: 3px 9px;
  border-radius: var(--r-full);
  font-size: var(--fs-11);
  color: var(--accent);
  background: var(--accent-soft);
}
.hero-blank-go:hover { filter: brightness(1.06); }
</style>
