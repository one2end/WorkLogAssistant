<template>
  <div class="timeline">
    <!-- 日期导航 -->
    <div class="tl-toolbar">
      <DateNav
        :selected-date="selectedDate"
        :dates-with-data="datesWithData"
        @update:selected-date="$emit('update:selectedDate', $event)"
        @shift="$emit('shift', $event)"
        @today="$emit('today')"
      />
    </div>

    <!-- 四格统计（UpTimer 风格）：展示层看工作量，记录层看原始采样 -->
    <div class="stat-strip">
      <template v-for="(cell, i) in statCells" :key="cell.label">
        <i v-if="i" class="stat-div" />
        <div class="stat-cell">
          <b>{{ cell.value }}</b>
          <span><Icon :name="cell.icon" :size="11" /> {{ cell.label }}</span>
        </div>
      </template>
    </div>

    <!-- 常用视图直接可见，原始记录作为次级入口 -->
    <div class="view-head">
      <div class="view-switch" role="group" aria-label="时间视图">
        <button v-for="opt in viewOptions.slice(0, 2)" :key="opt.id" class="view-tab"
          :class="{ active: mode === opt.id }" :aria-pressed="mode === opt.id"
          :title="opt.title" @click="setMode(opt.id)">
          <Icon :name="opt.icon" :size="13" />{{ opt.label }}
        </button>
      </div>
      <span class="view-date">{{ dateLabel }}</span>
      <button class="record-toggle" :class="{ active: mode === 'record' }"
        :aria-pressed="mode === 'record'" title="查看只读的原始窗口采样"
        @click="setMode(mode === 'record' ? 'timeline' : 'record')">
        <Icon name="database" :size="12" />原始记录
      </button>
      <button
        v-if="mode === 'timeline'"
        class="order-btn"
        :title="sortDesc ? '切换为从早到晚' : '切换为最新在上'"
        @click="sortDesc = !sortDesc"
      >
        <Icon name="filter" :size="12" />
        {{ sortDesc ? '最新在上' : '从早到晚' }}
      </button>
    </div>

    <!-- 手工补记（记录层是只读事实层，不提供写入入口） -->
    <div v-if="manualOpen && mode !== 'record'" class="manual-panel">
      <div class="manual-fields">
        <label class="mf">
          <span>开始</span>
          <input v-model="manualTime" type="time" step="900">
        </label>
        <label class="mf narrow">
          <span>时长(分)</span>
          <input v-model.number="manualDuration" type="number" min="15" step="15" max="1440">
        </label>
      </div>
      <label class="mf full">
        <span>事项</span>
        <input v-model="manualApp" type="text" placeholder="这段时间在做什么（必填）">
      </label>
      <div class="mf full">
        <span>分类</span>
        <div class="manual-categories" role="group" aria-label="分类">
          <button v-for="c in categories" :key="c" type="button" class="manual-category"
            :class="{ selected: manualCategory === c }" :aria-pressed="manualCategory === c"
            :style="{ '--category-color': colorOf(c) }" @click="manualCategory = c">{{ c }}</button>
        </div>
      </div>
      <label class="mf full">
        <span>备注</span>
        <input v-model="manualTitle" type="text" placeholder="补充说明，可留空">
      </label>
      <div class="manual-actions">
        <span class="manual-hint">最小 15 分钟，按 15 分钟对齐；保存后计入当日记录时长</span>
        <button class="btn btn-ghost btn-sm" @click="manualOpen = false">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="savingManual || !manualApp.trim()" @click="submitManual">
          {{ savingManual ? '保存中' : '保存' }}
        </button>
      </div>
    </div>

    <!-- 记录层：原始采样，只读；按小时分组 + 可筛选，避免一天几百行平铺 -->
    <div v-if="mode === 'record'" class="record-layer">
      <div class="rl-head">
        <Icon name="shield" :size="12" />
        <span>记录层 · {{ rawRows.length }} 条原始采样</span>
        <em>只读：这是事实，能看不能改</em>
      </div>
      <div class="rl-tools">
        <label class="rl-search">
          <Icon name="search" :size="12" />
          <input v-model="rawQuery" type="search" placeholder="筛应用或窗口标题">
        </label>
        <button class="rl-order" :title="rawDesc ? '切换为从早到晚' : '切换为最新在上'" @click="rawDesc = !rawDesc">
          <Icon name="filter" :size="12" />
          {{ rawDesc ? '最新在上' : '从早到晚' }}
        </button>
      </div>
      <div v-if="!rawRows.length" class="empty">
        <span class="empty-title">这一天没有自动录制</span>
        <span class="empty-desc">只有你补记或导入的标注，切回时间轴查看</span>
      </div>
      <div v-else-if="!filteredRawRows.length" class="empty">
        <span class="empty-title">没有匹配的采样</span>
        <span class="empty-desc">换个关键词试试</span>
      </div>
      <div v-else class="rl-list">
        <template v-for="g in rawHourGroups" :key="g.label + '-' + g.rows[0].timestamp">
          <div class="rl-hour">
            <span>{{ g.label }}</span>
            <em>{{ g.rows.length }} 条</em>
          </div>
          <div v-for="(r, i) in g.rows" :key="(r.timestamp || '') + '-' + i" class="rl-row">
            <span class="rl-time">{{ clock(minOfDay(r.timestamp)) }}</span>
            <span class="rl-app">{{ r.processName || r.app || '—' }}</span>
            <span class="rl-title" :title="r.windowTitle || r.title">{{ r.windowTitle || r.title || '(无标题)' }}</span>
            <span class="rl-dur">{{ r.durationMs ? fmtCN(r.durationMs) : '—' }}</span>
          </div>
        </template>
        <button v-if="rawHiddenCount" class="rl-more" @click="rawLimit += 300">
          还有 {{ rawHiddenCount }} 条采样，再加载 {{ Math.min(300, rawHiddenCount) }} 条
        </button>
      </div>
    </div>

    <template v-else>
      <!-- 时间轴：卡片流，空闲时段显式成块 -->
      <div v-if="mode === 'timeline'" class="tl-flow">
        <template v-if="displayBlocks.length">
          <div
            v-for="(b, i) in displayBlocks"
            :key="`${b.type}-${b.startMin}-${i}`"
            class="tl-row"
            :class="{ 'is-focus': highlightMin === b.startMin }"
            :data-min="b.startMin.toFixed(2)"
          >
            <div class="tl-time">
              <span class="tl-start">{{ clock(b.startMin) }}</span>
              <span class="tl-end">{{ clock(b.endMin) }}</span>
            </div>
            <div class="tl-axis">
              <span class="tl-node" :style="{ background: b.type === 'activity' ? colorOf(b.category) : 'var(--text-tertiary)' }" />
              <span class="tl-line" />
            </div>

            <!-- 活动卡片 -->
            <div
              v-if="b.type === 'activity'"
              class="tl-card"
              :style="{ borderLeftColor: colorOf(b.category), background: cardBg(b.category) }"
              @contextmenu.prevent.stop="openCtx($event, selectedDate, b)"
            >
              <div class="card-top">
                <span class="card-badge" :style="{ color: colorOf(b.category), background: softColor(b.category, 0.22) }">
                  <Icon :name="iconOf(b.category)" :size="13" />
                </span>
                <span class="card-app" :title="cardTitle(b)">{{ cardTitle(b) }}</span>
                <span class="card-dur"><Icon name="clock" :size="11" /> {{ fmtCN(b.durationMs) }}</span>
                <button class="card-more" title="编辑或删除这一段" @click.stop="openSegment(b, $event)">⋯</button>
              </div>
              <div v-if="cardNote(b)" class="card-note" :title="cardNote(b)">{{ cardNote(b) }}</div>
              <div class="card-meta">
                <span class="cat-chip" :style="{ color: colorOf(b.category), background: softColor(b.category) }">
                  {{ b.category || '其他' }}
                </span>
                <span v-if="b.tag" class="mini-tag focus">{{ b.tag }}</span>
                <span v-else-if="b.manual" class="mini-tag">标注</span>
                <span v-if="b.uncertain" class="mini-tag warn" title="该段存在数据空档，时长可能不准">
                  <Icon name="alert" :size="10" /> 不确定
                </span>
              </div>
            </div>

            <!-- 空闲卡片：整卡可点补记。
                 原先右侧那个圆形 + 会和右下角 FAB 撞在一起，像两个重复按钮。 -->
            <div v-else class="tl-card is-gap" @click="openManualFor(b)">
              <span class="gap-mark">?</span>
              <span class="gap-label">空闲：{{ fmtCN(b.durationMin * 60000) }}</span>
              <span class="gap-hint">点击补记 ›</span>
            </div>
          </div>
        </template>

        <div v-else class="empty">
          <span class="empty-icon"><EmptyIllustration variant="timeline" :size="88" /></span>
          <span class="empty-title">这一天还没有记录</span>
          <span class="empty-desc">切换到有数据的日期，或点击右下角 + 手工补记</span>
        </div>
      </div>

      <!-- 日历：列数随窗口宽度自适应（窄=1 天 / 中=3 天 / 宽=7 天） -->
      <div v-else class="cal-view">
        <div class="cal-head">
          <span>{{ calLabel }}</span>
          <em v-if="calLoading">加载中…</em>
          <span class="cal-span">{{ calSpan }} 天视图</span>
          <span class="cal-tip">空白处按住拖 = 划一段时间；点色块 = 编辑；右键 = 更多</span>
        </div>

        <div class="cal-scroll" ref="calScroll">
        <div class="cal-grid" :style="{ '--cols': calDays.length }">
          <!-- 左侧统一的时间刻度 -->
          <div class="cal-ruler">
            <span
              v-for="h in 25"
              :key="'r' + h"
              class="cal-tick"
              :style="{ top: ((h - 1) / 24 * 100) + '%' }"
            >{{ pad(h - 1) }}</span>
          </div>

          <div
            v-for="d in calDays"
            :key="d.date"
            class="cal-col"
            :class="{ 'is-current': d.date === selectedDate }"
          >
            <button class="cal-day" @click="$emit('update:selectedDate', d.date)">
              <b>{{ d.label }}</b>
              <span>{{ d.num }}</span>
              <em v-if="d.total">{{ d.total }}h</em>
            </button>

            <div
              class="cal-track"
              :data-date="d.date"
              @pointerdown.self="startDraft($event, d.date)"
              @contextmenu.self.prevent="openTrackCtx($event, d.date)"
            >
              <div
                v-for="(b, i) in d.blocks"
                :key="i"
                class="cal-block"
                :class="{
                  'is-selected': selectedBlock && selectedBlock.key === b.key,
                  'is-manual': b.manual,
                  'is-dim': dragState && dragState.block && dragState.block.key === b.key && dragState.moved,
                  'is-thin': b.height < 1.2
                }"
                :style="calBlockStyle(b)"
                :title="`${clock(b.startMin)}–${clock(b.endMin)} · ${b.category}${b.manual ? ' · 标注' : ''}`"
                @pointerdown.stop="startBlockDrag($event, d.date, b)"
                @contextmenu.prevent.stop="openCtx($event, d.date, b)"
              >
                <span class="cal-block-title">{{ blockLabel(b) }}</span>
                <span class="cal-block-range">{{ clock(b.startMin) }}–{{ clock(b.endMin) }}</span>
                <span v-if="blockSub(b) && b.height >= 6" class="cal-block-note">{{ blockSub(b) }}</span>
                <span class="cal-resize" @pointerdown.stop="startResize($event, d.date, b)" />
              </div>

              <!-- 拖拽/新建时的预览块：位置、时长都看得见 -->
              <div
                v-if="ghost && ghost.date === d.date"
                class="cal-ghost"
                :class="{ 'is-new': ghost.isNew }"
                :style="{ top: ghost.top + '%', height: ghost.height + '%' }"
              >
                <span class="ghost-label">{{ ghost.label }}</span>
              </div>

              <div v-if="d.date === todayStr" class="cal-now" :style="{ top: nowPercent + '%' }" />
            </div>
          </div>
        </div>
        </div>
      </div>
    </template>

    <!-- 悬浮补记按钮：记录层是只读事实层，不出现写操作入口 -->
    <button v-if="mode !== 'record'" class="fab" title="手工补记" @click="toggleManual">
      <Icon name="plus" :size="20" />
    </button>

    <!-- 右键菜单 -->
    <transition name="ctx-fade">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @pointerdown.stop
      >
        <template v-if="!ctxMenu.empty">
          <button @click="ctxDo('edit')">编辑这一段</button>
          <button @click="ctxDo('copy')">复制这一段时间</button>
          <i class="ctx-sep" />
          <button class="danger" @click="ctxDo('delete')">删除这一段</button>
          <i class="ctx-sep" />
          <span class="ctx-hint">{{ clock(ctxMenu.block.startMin) }}–{{ clock(ctxMenu.block.endMin) }} · {{ ctxMenu.block.category }}</span>
        </template>
        <template v-else>
          <button @click="ctxDo('new')">在这里新建 15 分钟</button>
          <button v-if="clipBlock" @click="ctxDo('paste')">粘贴已复制的段</button>
          <i class="ctx-sep" />
          <span class="ctx-hint">{{ clock(ctxMenu.minute) }} · {{ ctxMenu.date }}</span>
        </template>
      </div>
    </transition>

    <!-- 统一的分段编辑器：贴着被点的那个块弹出 -->
    <SegmentEditor
      :open="editorOpen"
      :anchor="editorAnchor"
      :initial="editorForm"
      :categories="categories"
      :deletable="editorDeletable"
      :saving="editSaving"
      @save="saveSegment"
      @delete="deleteSegment"
      @close="closeSegment"
    />
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';
import SegmentEditor from '../components/SegmentEditor.vue';
import { colorForCategory } from '../styles/palette.js';

const { ipcRenderer } = require('electron');

/** 小于这个分钟数的缝隙不单独画空闲块，避免碎片刷屏 */
const GAP_MIN = 5;

const CAT_ICONS = {
  // 展示分组（日历/时间轴用）
  '工作': 'grid',
  '学习': 'chart',
  '生活': 'home',
  '娱乐': 'play',
  '睡眠': 'moon',
  '专注': 'target',
  '其他': 'activity',
  '沟通协作': 'plug',
  'AI 助手': 'cpu',
  '开发编码': 'terminal',
  '文档写作': 'grid',
  '任务与效率': 'target',
  '浏览检索': 'search',
  '影音娱乐': 'play',
  '文件系统': 'folder',
  '系统工具': 'settings',
  '生活事务': 'home',
  '空档': 'pause'
};

export default {
  name: 'TimelineView',
  components: { Icon, DateNav, EmptyIllustration, SegmentEditor },
  props: {
    report: { type: Object, required: true },
    activities: { type: Array, default: () => [] },
    selectedDate: { type: String, required: true },
    datesWithData: { type: Set, default: () => new Set() },
    focusTarget: { type: Object, default: null },
    customCategories: { type: Array, default: () => [] },
    theme: { type: String, default: 'dark' }
  },
  emits: ['update:selectedDate', 'shift', 'today', 'refresh',
    'manual-error', 'focus-consumed', 'focus-missed'],
  data() {
    return {
      // mode 同时表达「视图」和「层」：timeline/calendar 是展示层，record 是只读事实层。
      mode: 'timeline',
      sortDesc: true,
      viewOptions: [
        { id: 'timeline', label: '时间轴', icon: 'timeline', title: '按 15 分钟归并的卡片流' },
        { id: 'calendar', label: '日历', icon: 'calendar', title: '1/3/7 天自适应，可拖拽编辑' },
        { id: 'record', label: '记录层', icon: 'database', hint: '只读', divider: true,
          title: '原始采样：这是事实，能看不能改' }
      ],
      // 记录层一天可能几百条采样：默认倒序（最新在上）、每次只加 300 条
      rawQuery: '',
      rawLimit: 300,
      rawDesc: true,
      // 日历显示几天，由窗口宽度决定：窄窗口看一天，拉宽看三天，全屏看一周
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      calDays: [],
      calLoading: false,
      selectedBlock: null,
      clipBlock: null,
      // 拖动/新建过程中的预览块
      ghost: null,
      dragState: null,
      // 右键菜单
      ctxMenu: null,
      // 统一的分段编辑器（贴近被点的块弹出）
      editorOpen: false,
      editorAnchor: null,
      editorDeletable: false,
      editorTarget: null,
      editorForm: { range: '', startTime: '00:00', durationMin: 15, app: '', category: '其他', note: '' },
      editSaving: false,
      highlightMin: null,
      manualOpen: false,
      manualTime: '09:00',
      manualDuration: 30,
      manualApp: '',
      manualTitle: '',
      manualCategory: '其他',
      savingManual: false,
      tick: 0,
      timer: null
    };
  },
  watch: {
    mode(val) {
      if (val === 'calendar') this.loadCalendar();
    },
    selectedDate() {
      // 换天时清掉记录层的筛选与分页，否则新的一天会沿用旧状态
      this.rawQuery = '';
      this.rawLimit = 300;
      if (this.mode === 'calendar') this.loadCalendar();
    },
    // 拉宽/收窄窗口时自动切换 日 / 三日 / 周
    windowWidth() {
      if (this.mode === 'calendar') this.loadCalendar();
    }
  },
  computed: {
    categories() {
      return [...new Set(['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他', ...this.customCategories.map(c => c.name).filter(Boolean)])];
    },
    todayStr() {
      const n = new Date();
      return `${n.getFullYear()}-${this.pad(n.getMonth() + 1)}-${this.pad(n.getDate())}`;
    },
    /** 当前时刻在一天里的百分比（日历里的红线） */
    nowPercent() {
      void this.tick;
      const n = new Date();
      return ((n.getHours() * 60 + n.getMinutes()) / 1440) * 100;
    },
    /** 日历列数：窗口越宽看得越远 */
    calSpan() {
      const w = this.windowWidth;
      // 阈值按「每列至少 320px」推：再窄就少显示几天，保证块里的字读得清
      if (w < 700) return 1;
      if (w < 1420) return 3;
      return 7;
    },
    calLabel() {
      if (this.calSpan === 1) return this.dateLabel;
      if (!this.calDays.length) return '';
      const a = this.calDays[0];
      const b = this.calDays[this.calDays.length - 1];
      return `${a.date.slice(5)} ~ ${b.date.slice(5)}`;
    },
    /** 记录层原始采样：只含自动录制的部分，不含补记与导入的标注 */
    rawRows() {
      const list = (this.activities || []).filter(a => a && a.timestamp);
      return list
        .filter(a => a.source === 'auto')
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    },
    /** 应用名 / 窗口标题模糊筛选，纯前端，不碰数据 */
    filteredRawRows() {
      const q = (this.rawQuery || '').trim().toLowerCase();
      if (!q) return this.rawRows;
      return this.rawRows.filter(r => {
        const app = String(r.processName || r.app || '').toLowerCase();
        const title = String(r.windowTitle || r.title || '').toLowerCase();
        return app.includes(q) || title.includes(q);
      });
    },
    /** 最新在上，且按批加载：打开记录层第一眼就是刚才在做什么，而不是凌晨的采样 */
    rawVisibleRows() {
      const rows = this.rawDesc ? [...this.filteredRawRows].reverse() : this.filteredRawRows;
      return rows.slice(0, this.rawLimit);
    },
    rawHiddenCount() {
      return Math.max(0, this.filteredRawRows.length - this.rawVisibleRows.length);
    },
    /** 按小时切小节，找某条采样不用在几百行里肉眼扫 */
    rawHourGroups() {
      const groups = [];
      for (const r of this.rawVisibleRows) {
        const hour = Math.floor(this.minOfDay(r.timestamp) / 60);
        const last = groups[groups.length - 1];
        if (last && last.hour === hour) last.rows.push(r);
        else groups.push({ hour, label: `${this.pad(hour)}:00`, rows: [r] });
      }
      return groups;
    },
    /**
     * 四格统计随层切换口径：展示层看「有效/空闲/段数/覆盖」，
     * 记录层看「采样条数/首条/末条/跨度」。以前在记录层也显示工时覆盖率，
     * 会让人误以为那些数字是原始事实。
     */
    statCells() {
      if (this.mode !== 'record') {
        return [
          { value: this.fmtCN(this.trackedMs), label: '有效', icon: 'timer' },
          { value: this.fmtCN(this.gapTotalMs), label: '空闲', icon: 'moon' },
          { value: this.sessionCount, label: '段数', icon: 'activity' },
          { value: `${this.coveragePct}%`, label: '覆盖', icon: 'chart' }
        ];
      }
      const rows = this.rawRows;
      if (!rows.length) {
        return [
          { value: '0', label: '采样', icon: 'database' },
          { value: '—', label: '首条', icon: 'clock' },
          { value: '—', label: '末条', icon: 'clock' },
          { value: '—', label: '跨度', icon: 'timer' }
        ];
      }
      const mins = rows.map(r => this.minOfDay(r.timestamp));
      const first = Math.min(...mins);
      const last = Math.max(...mins);
      return [
        { value: rows.length, label: '采样', icon: 'database' },
        { value: this.clock(first), label: '首条', icon: 'clock' },
        { value: this.clock(last), label: '末条', icon: 'clock' },
        { value: this.fmtCN((last - first) * 60000), label: '跨度', icon: 'timer' }
      ];
    },
    stats() {
      return (this.report && this.report.stats) || {};
    },
    trackedMs() {
      return this.stats.trackedMs || 0;
    },
    /** 段数 = 展示层合并后的段数，不是原始采样条数（否则会显示几十上百段） */
    sessionCount() {
      return this.blocks.filter(b => b.type === 'activity').length;
    },
    records() {
      return this.activities || [];
    },
    dayStartMs() {
      const [y, m, d] = this.selectedDate.split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
    },
    /** 今天只画到当前时刻，免得未来时间变成一块巨型「空闲」 */
    dayEndMin() {
      return this.isToday ? Math.max(1, Math.min(1440, this.nowMin)) : 1440;
    },
    /**
     * 展示层的时间轴：以 15 分钟格为最小单位。
     *
     * 记录层里一分钟可能切了三次窗口，直接画会得到一堆 0～3 分钟的碎片。
     * 展示层按 15 分钟归并：相邻同分类的格合成一段，一段就是「这段时间主要在做什么」。
     * 专注也走同一条路——它已经作为一条原子事件参与过优先级消解，落进 slot 里，
     * 所以这里不再单独插块，避免和自动录制重复。
     */
    blocks() {
      const slots = (this.report && this.report.slots) || [];
      if (!slots.length) return [];

      const acts = [];
      for (const slot of slots) {
        if (!slot.filledMin || !slot.category) continue;
        const startMin = slot.startMin;
        const endMin = Math.min(1440, startMin + 15);
        const last = acts[acts.length - 1];
        if (last && last.category === slot.category && last.endMin === startMin &&
            last.focusId === (slot.layer === 'focus' ? (slot.focusId || null) : null)) {
          if ((slot.filledMin || 0) > (last.appMin || 0)) {
            last.app = slot.app || last.app;
            last.appMin = slot.filledMin || 0;
          }
          if (slot.note && !last.titles.includes(slot.note)) last.titles.push(slot.note);
          if (slot.layer === 'focus' && slot.focusId && !last.focusId) last.focusId = slot.focusId;
          last.endMin = endMin;
          last.durationMin = endMin - last.startMin;
          last.durationMs = (last.endMin - last.startMin) * 60000;
          last.slotCount += 1;
          last.purity = Math.min(last.purity, slot.purity);
          continue;
        }
        acts.push({
          type: 'activity',
          key: `${startMin}-${slot.category}`,
          startMin,
          endMin,
          durationMin: endMin - startMin,
          durationMs: (endMin - startMin) * 60000,
          app: slot.app || slot.category,
          category: slot.category,
          titles: slot.note ? [slot.note] : [],
          manual: slot.layer === 'manual' || slot.layer === 'imported',
          uncertain: slot.purity > 0 && slot.purity < 0.6,
          purity: slot.purity,
          slotCount: 1,
          appMin: slot.filledMin || 0,
          focusId: slot.layer === 'focus' ? (slot.focusId || null) : null,
          tag: slot.layer === 'focus' ? '专注' : null
        });
      }

      if (!acts.length) return [];
      acts.sort((x, y) => x.startMin - y.startMin || y.durationMs - x.durationMs);

      const dayEndMin = this.dayEndMin;
      const out = [];
      let cursor = 0;
      for (const a of acts) {
        if (a.startMin - cursor >= GAP_MIN) {
          out.push({ type: 'gap', startMin: cursor, endMin: a.startMin,
            durationMin: a.startMin - cursor });
        }
        out.push(a);
        cursor = Math.max(cursor, a.endMin);
      }
      if (dayEndMin - cursor >= GAP_MIN) {
        out.push({ type: 'gap', startMin: cursor, endMin: dayEndMin,
          durationMin: dayEndMin - cursor });
      }
      return out;
    },

    displayBlocks() {
      return this.sortDesc ? [...this.blocks].reverse() : this.blocks;
    },
    gapTotalMs() {
      return this.blocks
        .filter(b => b.type === 'gap')
        .reduce((sum, b) => sum + b.durationMin * 60000, 0);
    },
    coveragePct() {
      // 用 trackedMs（已排除生活事务）除以已过去的时间，避免把吃饭睡觉算进覆盖率
      return Math.min(100, Math.round(this.trackedMs / Math.max(1, this.dayEndMin * 60000) * 100));
    },
    dateLabel() {
      const [y, m, d] = this.selectedDate.split('-').map(Number);
      const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const day = new Date(y, (m || 1) - 1, d || 1).getDay();
      return `${this.pad(m)}月${this.pad(d)}日 ${wd[day]}`;
    },
    isToday() {
      const now = new Date();
      const s = `${now.getFullYear()}-${this.pad(now.getMonth() + 1)}-${this.pad(now.getDate())}`;
      return s === this.selectedDate;
    },
    nowMin() {
      void this.tick;
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    }
  },
  mounted() {
    this.timer = setInterval(() => { this.tick += 1; }, 60000);
    document.addEventListener('click', this.closeMenu);
    this._onResize = () => { this.windowWidth = window.innerWidth; };
    // 捕获阶段的 pointerdown 用来「点外部关菜单」。但必须放过菜单自身：
    // 否则点菜单项时先把 ctxMenu 清空，Vue 会在 click 触发前移除 DOM，
    // 所有菜单项都点不动（表现为「编辑这一段按不了」）。
    this._onDocDown = (e) => {
      if (!this.ctxMenu) return;
      if (e.target && e.target.closest && e.target.closest('.ctx-menu')) return;
      this.ctxMenu = null;
    };
    document.addEventListener('pointerdown', this._onDocDown, true);
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.ctxMenu) { this.ctxMenu = null; return; }
      if (!this.selectedBlock) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'c') {
        this.clipBlock = { ...this.selectedBlock };
        this.$emit('manual-error', '已复制这一段，切到目标日期后 Ctrl+V 粘贴');
      } else if (e.key === 'v') {
        this.pasteBlock();
      }
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKey);
    this.$nextTick(() => this.consumeFocus());
  },
  beforeUnmount() {
    this.endDrag();
    document.removeEventListener('click', this.closeMenu);
    window.removeEventListener('resize', this._onResize);
    if (this._onDocDown) document.removeEventListener('pointerdown', this._onDocDown, true);
    window.removeEventListener('keydown', this._onKey);
    if (this.timer) clearInterval(this.timer);
    if (this._focusTimer) clearTimeout(this._focusTimer);
  },
  methods: {
    pad(n) {
      return String(n).padStart(2, '0');
    },
    toMin(iso) {
      if (!iso) return 0;
      const ms = new Date(iso).getTime();
      if (Number.isNaN(ms)) return 0;
      return Math.max(0, Math.min(1440, (ms - this.dayStartMs) / 60000));
    },
    /**
     * 点开一段进行修改。
     *
     * 展示层的修改不是去动记录层，而是新写一条「标注」，覆盖这一段时间。
     * 标注优先级高于自动录制，所以保存后这一段就变成你写的样子；
     * 原始采样原封不动留在记录层。
     */
    /** 删除 = 删掉这段的标注；没有标注说明它来自记录层，会明确拒绝 */
    async removeBlock(b) {
      if (!b || b.type !== 'activity') return;
      const date = b.date || this.selectedDate;

      if (b.isNew) { this.closeSegment(); return; }   // 还没落库，不用删

      // 专注不是活动记录，它在 arhat/sessions 里，得用另一个接口删
      if (b.focusId) {
        const res = await ipcRenderer.invoke('delete-focus-session', { date, id: b.focusId });
        if (!res || !res.success) {
          this.$emit('manual-error', (res && res.error) || '删除专注失败');
          return;
        }
        await this.refreshAfterWrite();
        return;
      }

      // 记录层是事实，不允许删除。但按钮不能凭空消失：
      // 明确告诉用户「先改一次生成标注」，否则会以为删除坏了。
      if (!b.manual && !b.focusId) {
        this.$emit('manual-error', '这一段来自记录层（只读）：先编辑保存一次生成标注，之后就能删除');
        return;
      }

      const toIso = (min) => {
        const d = new Date(`${date}T00:00:00`);
        d.setMinutes(min);
        return d.toISOString();
      };
      const res = await ipcRenderer.invoke('delete-display-range', {
        date,
        start: toIso(b.startMin),
        end: toIso(b.endMin)
      });
      if (!res || !res.success) {
        this.$emit('manual-error', (res && res.error) || '这一段没有可删的标注');
        return;
      }
      await this.refreshAfterWrite();
    },
    /**
     * 日历：按当前窗口宽度拉 1 / 3 / 7 天。
     * 并发保护：mode、日期、窗口宽度可能连着变，只让最后一次请求写 calDays，
     * 否则慢的旧请求会覆盖新结果，出现「换了日期还显示上一天」。
     * keepScroll 用于写操作后的刷新——保住视野，别把刚拖完的块弹走。
     */
    async loadCalendar({ keepScroll = false } = {}) {
      const token = (this._calToken = (this._calToken || 0) + 1);
      this.calLoading = true;
      try {
        const span = this.calSpan;
        const base = new Date(`${this.selectedDate}T00:00:00`);
        const start = new Date(base);
        if (span === 3) start.setDate(base.getDate() - 1);
        if (span === 7) start.setDate(base.getDate() - ((base.getDay() + 6) % 7));

        const rows = [];
        for (let i = 0; i < span; i += 1) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const date = `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
          let report = null;
          try {
            const res = await ipcRenderer.invoke('get-day-analytics', date);
            report = res && res.ok ? res.report : null;
          } catch (e) { /* 单天失败不影响整体 */ }
          if (token !== this._calToken) return;
          rows.push(this.buildCalDay(date, d, report));
        }
        if (token !== this._calToken) return;
        this.calDays = rows;
        await this.$nextTick();
        if (!keepScroll) this.scrollCalTo();
      } finally {
        if (token === this._calToken) this.calLoading = false;
      }
    },

    /**
     * 写操作后的统一刷新。
     * report 由父组件重载；但 calDays 是本组件从 IPC 拉的本地数据，
     * 不会跟着 report 变——漏掉这一步就会出现「删了块，界面还在」。
     */
    async refreshAfterWrite() {
      this.$emit('refresh');
      if (this.mode === 'calendar') await this.loadCalendar({ keepScroll: true });
    },

    /** 打开日历时滚到「有意义的位置」：今天滚到当前时刻，其它天滚到早上 */
    scrollCalTo() {
      const el = this.$refs.calScroll;
      if (!el) return;
      const hourH = 96;
      const isToday = this.calDays.some(d => d.date === this.todayStr);
      const focusHour = isToday ? new Date().getHours() : 8;
      el.scrollTop = Math.max(0, (focusHour - 1) * hourH);
    },
    buildCalDay(date, d, report) {
      const slots = (report && report.slots) || [];
      const merged = [];
      for (const slot of slots) {
        if (!slot.filledMin || !slot.category) continue;
        const last = merged[merged.length - 1];
        if (last && last.category === slot.category && last.endMin === slot.startMin &&
            last.focusId === (slot.layer === 'focus' ? (slot.focusId || null) : null)) {
          last.endMin = slot.startMin + 15;
          last.minutes += slot.filledMin;
          if (slot.note && !last.notes.includes(slot.note)) last.notes.push(slot.note);
          if (slot.layer === 'focus' && slot.focusId && !last.focusId) last.focusId = slot.focusId;
        } else {
          merged.push({
            category: slot.category,
            app: slot.app,
            startMin: slot.startMin,
            endMin: slot.startMin + 15,
            minutes: slot.filledMin,
            notes: slot.note ? [slot.note] : [],
            // 只有「这一格真由专注主导」才把 focusId 交给前端。
            // 否则删除一个标注主导、但格内带 focusId 的块，会误删专注会话。
            focusId: slot.layer === 'focus' ? (slot.focusId || null) : null,
            manual: slot.layer !== 'auto'
          });
        }
      }
      const wd = ['日', '一', '二', '三', '四', '五', '六'];
      const blocks = merged.map(m => ({
        key: `${date}#${m.startMin}`,
        date,
        startMin: m.startMin,
        endMin: m.endMin,
        app: m.app,
        category: m.category,
        note: (m.notes || []).join(' · ').slice(0, 80),
        focusId: m.focusId || null,
        manual: m.manual,
        top: +((m.startMin / 1440) * 100).toFixed(2),
        height: +Math.max(0.7, ((m.endMin - m.startMin) / 1440) * 100).toFixed(2)
      }));
      const total = merged.reduce((n, m) => n + m.minutes, 0) / 60;
      return {
        date,
        label: `周${wd[d.getDay()]}`,
        num: d.getDate(),
        blocks,
        total: Math.round(total * 10) / 10
      };
    },

    /** 时间轴卡片标题：优先应用名，应用名无意义时退回「做了什么」 */
    cardTitle(b) {
      const app = (b.app || '').trim();
      const note = this.cleanNote(this.noteOf(b));
      if (app && !['记录', '标注', '手工记录', 'unknown'].includes(app)) return app;
      return note || b.category || '其他';
    },
    cardNote(b) {
      const app = (b.app || '').trim();
      const note = b.tag === '专注' ? (b.titles || []).join(' · ') : this.cleanNote(this.noteOf(b));
      // 标题已经用了 note 时，不再重复显示一行
      if (!app || ['记录', '标注', '手工记录', 'unknown'].includes(app) || note === app || note === b.category) return '';
      return note;
    },

    /**
     * 块上的主标题：优先「做了什么」，其次才是应用/来源。
     * 导入记录常带「工作-上班 …」这种前缀，显示前把与分类重复的开头去掉。
     */
    blockLabel(b) {
      if (b.focusId && b.app) return b.app;
      const note = this.cleanNote(b.note);
      if (note) return note;
      const app = (b.app || '').trim();
      if (app && !['记录', '标注', '手工记录', 'unknown'].includes(app)) return app;
      return b.category || '其他';
    },
    blockSub(b) {
      // 一天/三天视图里才显示来源，七天视图太窄
      if (this.calSpan > 3) return '';
      const app = (b.app || '').trim();
      if (b.focusId) return b.note && b.note !== app ? b.note : '';
      if (!app || ['记录', '标注', '手工记录'].includes(app)) return '';
      // 导入记录常是「运动-跑步」，标题里已经去掉前缀，这里再显示就重复了
      if ((b.note || '').startsWith(`${app}-`)) return '';
      if (['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他'].includes(app)) return '';
      return app;
    },
    cleanNote(note) {
      if (!note) return '';
      // 「工作-上班 做下计划」→「上班 做下计划」（前缀已由颜色表达）
      return String(note).replace(/^[^-]{1,4}-\s*/, '').trim();
    },

    /** 把鼠标位置换算成 15 分钟刻度 */
    minuteAt(trackEl, clientY) {
      const rect = trackEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      return Math.max(0, Math.min(1440, Math.round((ratio * 1440) / 15) * 15));
    },
    /** 预览块的几何信息（top/height 用百分比，和真实块同一套坐标） */
    ghostOf(date, startMin, endMin, isNew) {
      const a = Math.max(0, Math.min(startMin, endMin));
      const b = Math.min(1440, Math.max(startMin, endMin));
      return {
        date,
        startMin: a,
        endMin: b,
        top: (a / 1440) * 100,
        height: Math.max(0.5, ((b - a) / 1440) * 100),
        label: `${this.clock(a)} – ${this.clock(b)} · ${b - a} 分钟`,
        isNew
      };
    },

    /**
     * 统一登记拖拽监听。切视图或组件卸载时主动解绑，
     * 否则「拖到一半切走、回来松手」仍会落一条标注，很难查。
     */
    beginDrag(onMove, onUp) {
      this.endDrag();
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (this._dragCleanup === cleanup) this._dragCleanup = null;
      };
      this._dragCleanup = cleanup;
      // 这里必须是真的注册监听。之前批量替换拖拽样板时把这两行
      // 误换成了 this.beginDrag(...)，变成无限递归 → 日历点块直接栈溢出，
      // 编辑浮层、右键菜单、拖拽全都不出来。
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    endDrag() {
      if (this._dragCleanup) {
        this._dragCleanup();
        this._dragCleanup = null;
      }
      this.ghost = null;
      this.dragState = null;
    },

    /**
     * 空白处按住拖动 = 划一段时间，松开后打开编辑器让你填内容。
     * 只单击不拖动不会创建任何东西——新建必须先经过编辑器确认。
     */
    startDraft(e, date) {
      if (e.button !== 0) return;
      const track = e.currentTarget;
      const trackRect = track.getBoundingClientRect();
      const anchor = this.minuteAt(track, e.clientY);
      let current = anchor;
      let moved = false;
      this.closeCtx();
      this.selectedBlock = null;

      const onMove = (ev) => {
        current = this.minuteAt(track, ev.clientY);
        if (Math.abs(current - anchor) >= 15) moved = true;
        if (!moved) return;
        const a = Math.min(anchor, current);
        const b = Math.max(anchor, current);
        this.ghost = this.ghostOf(date, a, Math.max(b, a + 15), true);
      };
      const onUp = () => {
        const g = this.ghost;
        this.endDrag();
        if (!moved || !g) return;      // 只是点了一下：什么都不做
        // 用「刚划出来的那一段」作为锚点，浮层就会贴在那儿
        const anchorRect = {
          top: trackRect.top + (g.startMin / 1440) * trackRect.height,
          left: trackRect.left,
          width: trackRect.width,
          height: Math.max(16, ((g.endMin - g.startMin) / 1440) * trackRect.height)
        };
        anchorRect.bottom = anchorRect.top + anchorRect.height;
        this.openSegment({
          type: 'activity',
          key: `new-${date}-${g.startMin}`,
          date,
          isNew: true,
          startMin: g.startMin,
          endMin: g.endMin,
          durationMin: g.endMin - g.startMin,
          durationMs: (g.endMin - g.startMin) * 60000,
          app: '',
          category: '其他',
          titles: [],
          manual: true,
          focusId: null
        }, { currentTarget: null, _rect: anchorRect });
      };
      this.beginDrag(onMove, onUp);
    },

    /**
     * 拖动色块。
     * 走动时给出预览块（位置 + 时长都可见），松手才落库；
     * 只在原地松手（没动）才算「点击 = 编辑」。
     */
    startBlockDrag(e, date, b) {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      const track = el.parentElement;
      const grabY = e.clientY;
      const originStart = b.startMin;
      const dur = Math.max(15, Math.round((b.endMin - b.startMin) / 15) * 15);
      let moved = false;
      let targetStart = originStart;
      this.closeCtx();

      this.selectedBlock = {
        key: b.key, date, app: b.app, category: b.category,
        startMin: b.startMin, durationMin: dur,
        range: `${this.clock(b.startMin)}-${this.clock(b.endMin)}`
      };

      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientY - grabY) < 4) return;
        moved = true;
        const minute = this.minuteAt(track, ev.clientY);
        const delta = Math.round((minute - originStart) / 15) * 15;
        targetStart = Math.max(0, Math.min(1440 - dur, originStart + delta));
        this.dragState = { block: b, moved: true };
        this.ghost = this.ghostOf(date, targetStart, targetStart + dur, false);
      };
      const onUp = async () => {
        this.endDrag();
        if (!moved) {
          this.openSegment(this.blockOf(date, b), { currentTarget: el });
          return;
        }
        if (targetStart === originStart) return;
        if (!b.manual) {
          this.$emit('manual-error', '这一段来自记录层，不能直接搬：点它改一次生成标注后就能拖动');
          return;
        }
        await this.moveBlock(date, b, targetStart, dur);
      };
      this.beginDrag(onMove, onUp);
    },

    async moveBlock(date, b, newStart, dur) {
      await this.writeAnnotation(date, newStart, dur, b, [b.startMin, b.endMin]);
    },

    /** 右键菜单：和系统日历一致，编辑 / 复制 / 删除 */
    openCtx(e, date, b) {
      this.editorOpen = false;
      this.ghost = null;
      // 记下被右键的那块，菜单里点「编辑这一段」时浮层贴着它弹，
      // 而不是掉到屏幕左上角让人以为没反应
      const el = e.currentTarget && e.currentTarget.closest
        ? (e.currentTarget.closest('.tl-card, .cal-block') || e.currentTarget)
        : null;
      const r = el ? el.getBoundingClientRect() : null;
      this.ctxMenu = {
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 150),
        date,
        block: b,
        empty: false,
        rect: r ? { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom } : null
      };
    },
    /** 轨道空白处右键：这里没有块，给「新建 / 粘贴」而不是什么都不做 */
    openTrackCtx(e, date) {
      const track = e.currentTarget;
      const rect = track.getBoundingClientRect();
      const minute = this.minuteAt(track, e.clientY);
      this.editorOpen = false;
      this.ghost = null;
      this.ctxMenu = {
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 120),
        date,
        minute,
        empty: true,
        rect: { top: e.clientY - 10, left: rect.left, width: rect.width, height: 20, bottom: e.clientY + 10 }
      };
    },
    closeCtx() {
      this.ctxMenu = null;
    },
    ctxDo(action) {
      const menu = this.ctxMenu;
      this.closeCtx();
      if (!menu) return;
      if (menu.empty) {
        if (action === 'new') {
          const startMin = Math.min(1425, menu.minute);
          this.openSegment({
            type: 'activity',
            key: `new-${menu.date}-${startMin}`,
            date: menu.date,
            isNew: true,
            startMin,
            endMin: startMin + 15,
            durationMin: 15,
            durationMs: 15 * 60000,
            app: '', category: '其他', titles: [], manual: true, focusId: null
          }, { currentTarget: null, _rect: menu.rect });
        } else if (action === 'paste') {
          this.pasteAt(menu.date, menu.minute);
        }
        return;
      }
      const block = this.blockOf(menu.date, menu.block);
      if (action === 'edit') {
        this.openSegment(block, { currentTarget: null, _rect: menu.rect });
      } else if (action === 'copy') {
        this.copyBlock(block);
      } else if (action === 'delete') {
        this.removeBlock(block);
      }
    },

    /** 把日历块 / 时间轴块统一转成编辑器用的对象（两者字段不同） */
    blockOf(date, b) {
      const startMin = b.startMin;
      const endMin = b.endMin;
      return {
        type: 'activity',
        key: b.key || `${date}-${startMin}`,
        date,
        isNew: !!b.isNew,
        startMin,
        endMin,
        durationMin: endMin - startMin,
        durationMs: Math.max(15, endMin - startMin) * 60000,
        app: b.app || b.category || '',
        category: b.category || '其他',
        titles: b.titles ? [...b.titles] : (b.note ? [b.note] : []),
        manual: !!b.manual,
        focusId: b.focusId || null
      };
    },
    /** 打开编辑器：浮层贴在触发块旁边，而不是整页居中弹窗 */
    openSegment(b, ev) {
      if (!b || b.type !== 'activity') return;
      // 优先用整张卡片/整个色块作为锚点：贴着「这一块」弹出，而不是贴着那个小按钮
      const el = ev && ev.currentTarget
        ? (ev.currentTarget.closest('.tl-card, .cal-block') || ev.currentTarget)
        : null;
      const rect = (ev && ev._rect) || (el ? el.getBoundingClientRect() : null);
      this.editorAnchor = rect
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }
        : null;
      // 删除按钮始终可见（红色高亮），记录层的段点下去会解释为什么不能删，
      // 比「按钮凭空消失」更容易理解，也不破坏记录层只读约束。
      this.editorDeletable = !b.isNew;
      this.editorTarget = { ...b, date: b.date || this.selectedDate };
      this.editorForm = {
        range: `${this.clock(b.startMin)} – ${this.clock(b.endMin)}`,
        startTime: this.clock(b.startMin),
        durationMin: Math.max(15, Math.round((b.endMin - b.startMin) / 15) * 15),
        app: b.app || '',
        category: b.category || '其他',
        note: b.isNew ? '' : (b.note || (b.titles || []).join(' · '))
      };
      this.editorOpen = true;
    },
    closeSegment() {
      this.editorOpen = false;
      this.editorTarget = null;
    },
    /** 保存 = 写一条人工标注覆盖这段（优先级最高） */
    async saveSegment(payload) {
      if (this.editSaving) return;
      this.editSaving = true;
      try {
        const b = this.editorTarget || {};
        // 块属于哪一天就用哪一天：日历会同时显示好几天，不能用「当前选中日期」
        const date = b.date || this.selectedDate;
        let ranges = [];
        if (b.startMin !== undefined && b.manual && !b.isNew) {
          const toIso = (min) => {
            const d = new Date(`${date}T00:00:00`);
            d.setMinutes(min);
            return d.toISOString();
          };
          ranges = [{ start: toIso(b.startMin), end: toIso(b.endMin) }];
        }
        const record = {
          date,
          startTime: payload.startTime,
          durationMin: payload.durationMin,
          app: payload.app,
          title: payload.note,
          category: payload.category
        };
        const res = ranges.length
          ? await ipcRenderer.invoke('replace-display-ranges', { ranges, record })
          : await ipcRenderer.invoke('add-manual-record', record);
        if (!res || !res.ok) {
          this.$emit('manual-error', (res && res.error) || '保存失败');
          return;
        }
        this.closeSegment();
        await this.refreshAfterWrite();
      } finally {
        this.editSaving = false;
      }
    },
    async deleteSegment() {
      const b = this.editorTarget;
      this.closeSegment();
      if (b) await this.removeBlock(b);
    },
    copyBlock(b) {
      this.clipBlock = {
        key: b.key,
        date: b.date || this.selectedDate,
        app: b.app,
        category: b.category,
        startMin: b.startMin,
        durationMin: Math.max(1, Math.round(b.durationMs / 60000)),
        range: `${this.clock(b.startMin)}-${this.clock(b.endMin)}`
      };
      this.$emit('manual-error', '已复制这一段，切到目标日期后按 Ctrl+V 粘贴');
    },
    /** 拖底边改时长：同样先出预览，松手才写 */
    startResize(e, date, b) {
      if (e.button !== 0) return;
      const el = e.currentTarget.parentElement;
      const track = el.parentElement;
      const grabY = e.clientY;
      const baseDur = Math.max(15, Math.round((b.endMin - b.startMin) / 15) * 15);
      const maxDur = 1440 - b.startMin;
      let newDur = baseDur;
      let moved = false;
      this.closeCtx();

      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientY - grabY) < 3) return;
        moved = true;
        const minute = this.minuteAt(track, ev.clientY);
        newDur = Math.max(15, Math.min(maxDur, Math.round((minute - b.startMin) / 15) * 15));
        this.dragState = { block: b, moved: true };
        this.ghost = this.ghostOf(date, b.startMin, b.startMin + newDur, false);
      };
      const onUp = async () => {
        this.endDrag();
        if (!moved || newDur === baseDur) return;
        await this.writeAnnotation(date, b.startMin, newDur, b);
      };
      this.beginDrag(onMove, onUp);
    },

    /** 原子地替换目标区间内旧标注；拖动时同时移除原区间。 */
    async writeAnnotation(date, startMin, durationMin, b, oldRange = null) {
      const toIso = (min) => {
        const d = new Date(`${date}T00:00:00`);
        d.setMinutes(min);
        return d.toISOString();
      };
      const ranges = [{ start: toIso(startMin), end: toIso(startMin + durationMin) }];
      if (oldRange) ranges.push({ start: toIso(oldRange[0]), end: toIso(oldRange[1]) });
      const res = await ipcRenderer.invoke('replace-display-ranges', { ranges, record: {
        date,
        startTime: this.clock(startMin),
        durationMin,
        app: b.app || b.category || '其他',
        title: '',
        category: b.category
      } });
      if (!res?.ok) {
        this.$emit('manual-error', res?.error || '保存失败，原记录未更改');
        return;
      }
      await this.refreshAfterWrite();
    },

    async pasteBlock() {
      if (!this.clipBlock) return;
      await this.pasteAt(this.selectedDate, this.clipBlock.startMin);
    },
    /** 把剪贴板里的段写到指定日期的某个 15 分钟刻度（轨道右键粘贴用） */
    async pasteAt(date, startMin) {
      const c = this.clipBlock;
      if (!c) return;
      await ipcRenderer.invoke('add-manual-record', {
        date,
        startTime: this.clock(Math.min(1425, startMin)),
        durationMin: c.durationMin,
        app: c.app || c.category || '其他',
        title: '',
        category: c.category
      });
      await this.refreshAfterWrite();
    },

    minOfDay(ts) {
      const d = new Date(ts);
      return d.getHours() * 60 + d.getMinutes();
    },
    clock(min) {
      const m = Math.max(0, Math.min(1440, Math.round(min)));
      return `${this.pad(Math.floor(m / 60))}:${this.pad(m % 60)}`;
    },
    setMode(id) {
      if (!this.viewOptions.some(o => o.id === id)) return;
      this.mode = id;
      // 切视图时收掉所有临时浮层：拖拽预览、右键菜单、编辑器、补记面板
      // 都不该跟着飘到下一个视图上（拖拽监听也必须在这里解绑）
      this.endDrag();
      this.ctxMenu = null;
      this.editorOpen = false;
      this.manualOpen = false;
      if (id === 'record') {
        this.rawQuery = '';
        this.rawLimit = 300;
      }
    },
    iconOf(cat) {
      return CAT_ICONS[cat] || 'activity';
    },
    colorOf(name) {
      const custom = this.customCategories.find(c => c.name === name);
      if (custom && /^#[0-9a-fA-F]{6}$/.test(custom.color)) return custom.color;
      return colorForCategory(this.theme, name);
    },
    softColor(name, alpha) {
      const hex = this.colorOf(name);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha || 0.14})`;
    },
    /**
     * 日历色块：分类色只做「语义边条」和一层极淡的底色。
     * 之前整块铺高饱和纯色 + 白字 + 文字阴影，像 Excel 甘特图，
     * 也是整个界面最显廉价的一处。
     */
    calBlockStyle(b) {
      const cat = b.category;
      // 15 分钟的块只有一格高，块间缝要收窄，否则文字被挤没
      const gap = b.height < 1.2 ? 2 : 4;
      return {
        top: b.top + '%',
        height: `calc(${b.height}% - ${gap}px)`,
        '--cat': this.colorOf(cat),
        background: this.softColor(cat, this.theme === 'light' ? 0.11 : 0.16),
        color: 'var(--text-primary)'
      };
    },
    cardBg(cat) {
      return this.softColor(cat, 0.07);
    },
    noteOf(b) {
      if (b.titles && b.titles.length) return b.titles.join(' · ');
      return b.category || '—';
    },
    consumeFocus() {
      const t = this.focusTarget;
      this.$emit('focus-consumed');
      if (!t) return;
      if (t.minutes === null || t.minutes === undefined) {
        this.scrollTop();
        return;
      }
      this.setMode('timeline');
      const list = this.blocks;
      if (!list.length) {
        this.scrollTop();
        this.$emit('focus-missed');
        return;
      }
      let best = list[0].startMin;
      let bestDist = Infinity;
      list.forEach(b => {
        const dist = (t.minutes >= b.startMin && t.minutes < b.endMin)
          ? 0
          : Math.min(Math.abs(t.minutes - b.startMin), Math.abs(t.minutes - b.endMin));
        if (dist < bestDist) { bestDist = dist; best = b.startMin; }
      });
      this.highlightMin = best;
      const row = this.$el.querySelector(`.tl-row[data-min="${best.toFixed(2)}"]`);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (row) row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      else this.scrollTop();
      if (this._focusTimer) clearTimeout(this._focusTimer);
      this._focusTimer = setTimeout(() => { this.highlightMin = null; }, 2400);
    },
    scrollTop() {
      const sc = this.$el.closest('.content') || document.querySelector('.content');
      if (sc) sc.scrollTop = 0;
    },
    toggleManual() {
      this.manualOpen = !this.manualOpen;
      if (this.manualOpen) {
        this.manualApp = '';
        this.manualTitle = '';
        this.manualCategory = '其他';
        const now = new Date();
        const m = Math.floor(now.getMinutes() / 5) * 5;
        this.manualTime = `${this.pad(now.getHours())}:${this.pad(m)}`;
        this.$nextTick(() => this.scrollTop());
      }
    },
    /** 点空闲块的 + ：把该空白段的起止时间直接带进补记表单 */
    openManualFor(b) {
      this.manualApp = '';
      this.manualTitle = '';
      this.manualCategory = '其他';
      this.manualTime = this.clock(Math.min(1439, b.startMin));
      this.manualDuration = Math.max(1, Math.min(1440, Math.round(b.durationMin)));
      this.manualOpen = true;
      this.$nextTick(() => this.scrollTop());
    },
    async submitManual() {
      if (!this.manualApp.trim()) {
        this.$emit('manual-error', '请填写事项');
        return;
      }
      const payload = {
        date: this.selectedDate,
        startTime: this.manualTime,
        durationMin: this.manualDuration,
        app: this.manualApp,
        title: this.manualTitle,
        category: this.manualCategory
      };
      this.savingManual = true;
      try {
        const res = await ipcRenderer.invoke('add-manual-record', payload);
        if (res && res.ok) {
          this.manualOpen = false;
          this.manualTitle = '';
          await this.refreshAfterWrite();
        } else {
          this.$emit('manual-error', (res && res.error) || '保存失败');
        }
      } catch (error) {
        this.$emit('manual-error', error.message);
      } finally {
        this.savingManual = false;
      }
    },
    fmtCN(ms) {
      if (!ms || ms <= 0) return '0分';
      const total = Math.round(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return m > 0 ? `${h}时${m}分` : `${h}时`;
      if (m > 0) return s > 0 ? `${m}分${s}秒` : `${m}分`;
      return `${s}秒`;
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
    hm(iso) {
      if (!iso) return '--:--';
      const d = new Date(iso);
      return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`;
    }
  }
};
</script>

<style scoped>
.timeline {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-bottom: 72px;
}

.tl-toolbar {
  display: flex;
  align-items: center;
}

/* ---------- 四格统计 ---------- */
.stat-strip {
  display: flex;
  align-items: center;
  padding: var(--sp-4) var(--sp-3);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-sm);
}
.stat-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.stat-cell b {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.025em;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.stat-cell span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.stat-div {
  width: 1px;
  height: 24px;
  background: var(--border-subtle);
  flex: none;
}

/* ---------- 视图切换 ---------- */
.view-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-1) 0;
}
.view-switch {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 3px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
}
.view-tab, .record-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  font-size: var(--fs-12);
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  cursor: pointer;
}
.view-tab:hover, .record-toggle:hover { color: var(--text-primary); background: var(--bg-hover); }
.view-tab.active, .record-toggle.active {
  color: var(--accent);
  background: var(--bg-surface);
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}
.record-toggle { flex: none; font-size: var(--fs-11); }
.view-date {
  flex: 1;
  text-align: center;
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-tertiary);
  letter-spacing: .02em;
}
.order-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 5px 9px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-full);
  cursor: pointer;
}
.order-btn:hover { color: var(--text-primary); border-color: var(--border-default); }

@media (max-width: 700px) {
  .view-head { flex-wrap: wrap; }
  .view-date { order: 3; flex-basis: 100%; text-align: left; }
  .order-btn { margin-left: auto; }
}

/* ---------- 补记面板 ---------- */
.manual-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--bg-elevated);
  border: 1px solid var(--accent-border);
  border-radius: var(--r-md);
}
.manual-fields { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.mf { display: flex; flex-direction: column; gap: 4px; min-width: 110px; }
.mf.narrow { min-width: 88px; }
.mf.grow { flex: 1; }
.mf.full { width: 100%; }
.mf > span { font-size: var(--fs-11); color: var(--text-tertiary); }
.manual-categories { display: flex; flex-wrap: wrap; gap: 6px; }
.manual-category { padding: 5px 10px; border: 1px solid var(--border-subtle); border-radius: 999px; background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; }
.manual-category.selected { border-color: var(--category-color); color: var(--category-color); background: var(--accent-soft); }
.manual-actions { display: flex; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
.manual-hint { flex: 1; font-size: var(--fs-11); color: var(--text-tertiary); }

/* ---------- 时间轴卡片流 ---------- */
.tl-flow { display: flex; flex-direction: column; }
.tl-row {
  display: grid;
  grid-template-columns: 46px 16px 1fr;
  gap: var(--sp-2);
  padding-bottom: var(--sp-3);
  border-radius: var(--r-md);
  transition: background var(--dur-2) var(--ease);
}
.tl-row.is-focus { background: var(--accent-soft); }
.tl-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  padding-top: 9px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.tl-start { font-size: var(--fs-14); color: var(--text-secondary); font-weight: var(--fw-semibold); }
.tl-end { font-size: var(--fs-11); color: var(--text-tertiary); }
.tl-axis { display: flex; flex-direction: column; align-items: center; }
.tl-node {
  width: 9px;
  height: 9px;
  margin-top: 13px;
  border-radius: 50%;
  flex: none;
  box-shadow: 0 0 0 3px var(--bg-canvas);
}
.tl-line { flex: 1; width: 2px; background: var(--border-default); margin-top: 4px; }

.tl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-left: 3px solid var(--accent);
  border-radius: var(--r-md);
  transition: box-shadow var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
}
.tl-card:hover { box-shadow: var(--shadow-sm); }
.card-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
.card-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  flex: none;
}
.card-app {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.card-dur {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: var(--fs-12);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
/* 三点按钮是时间轴卡片唯一的编辑入口，得让人一眼看见 */
.card-more {
  flex: none;
  width: 28px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-xs);
  font-size: 18px;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.card-more:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.card-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cat-chip, .mini-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 9px;
  border-radius: var(--r-full);
  font-size: var(--fs-11);
}
.mini-tag { color: var(--text-tertiary); background: var(--bg-active); }
.mini-tag.warn { color: var(--warning); background: var(--warning-soft); }

/* 空闲块：与活动卡片并列，但用虚线 + 问号区分 */
.tl-card.is-gap {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: var(--bg-inset);
  border: 1px dashed var(--border-default);
  border-left: 1px dashed var(--border-default);
}
.gap-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  color: var(--text-tertiary);
  background: var(--bg-active);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}
.gap-label { flex: 1; font-size: var(--fs-13); font-weight: var(--fw-semibold); color: var(--text-secondary); }
.gap-hint {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  white-space: nowrap;
  transition: color var(--dur-1) var(--ease);
}
.tl-card.is-gap {
  cursor: pointer;
  transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
}
.tl-card.is-gap:hover { border-color: var(--accent-border); }
.tl-card.is-gap:hover .gap-hint { color: var(--accent); }

/* ============ 日历 ============ */
.cal-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.cal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.cal-head em { font-style: normal; opacity: 0.7; }
.cal-span { margin-left: auto; }

.cal-tip {
  padding: 2px 8px;
  border-radius: 20px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  font-size: var(--fs-10);
}

/* 日历本体：按「小时高度」排版并纵向滚动，15 分钟才有足够空间 */
.cal-scroll {
  --hour-h: 96px;
  max-height: calc(100vh - 286px);
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: var(--r-sm);
  scrollbar-width: thin;
}

.cal-grid {
  display: grid;
  grid-template-columns: 40px repeat(var(--cols, 1), minmax(0, 1fr));
  gap: var(--sp-2);
  align-items: start;
}

/* 左侧时间刻度：只给参考，不抢注意力 */
.cal-ruler {
  position: relative;
  height: calc(var(--hour-h) * 24);
  margin-top: 26px;
  border-right: 1px solid var(--border-subtle);
}

.cal-tick {
  position: absolute;
  right: 6px;
  transform: translateY(-50%);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.cal-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cal-day {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
  height: 22px;
  background: none;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}

.cal-day b { font-weight: var(--fw-medium); }

.cal-day em {
  font-style: normal;
  font-size: var(--fs-10);
  opacity: 0.75;
}

.cal-col.is-current .cal-day { color: var(--accent); }

.cal-track {
  position: relative;
  height: calc(var(--hour-h) * 24);
  border-radius: var(--r-sm);
  /* 轨道用纯表面色，小时线只留极淡的一根，色块才是主角 */
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  background-image: repeating-linear-gradient(
    to bottom,
    var(--border-subtle) 0 1px,
    transparent 1px calc(100% / 12)
  );
  cursor: crosshair;
  overflow: hidden;
}

.cal-block {
  position: absolute;
  left: 4px;
  right: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  box-sizing: border-box;
  border-radius: var(--r-sm);
  border: 1px solid color-mix(in srgb, var(--cat) 16%, transparent);
  border-left: 3px solid var(--cat);
  overflow: hidden;
  cursor: grab;
  transition: box-shadow var(--dur-1) var(--ease), transform var(--dur-1) var(--ease),
    opacity var(--dur-1) var(--ease);
}

.cal-block:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
  z-index: 3;
}

.cal-block:active { cursor: grabbing; }

.cal-block.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  box-shadow: var(--shadow-md);
  z-index: 4;
}

/* 拖动中把原块压暗，视线跟着预览块走 */
.cal-block.is-dim { opacity: 0.4; }

/* 15 分钟的块：参考滴答清单改成单行横条，标题和时间都看得见。
   之前这里直接 display:none 把标题藏了，正是「15 分钟任务看不见」的根因。 */
.cal-block.is-thin {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-radius: var(--r-xs);
}
.cal-block.is-thin .cal-block-title {
  flex: 1;
  min-width: 0;
  -webkit-line-clamp: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cal-block.is-thin .cal-block-note { display: none; }

/* 块内时间范围：大块在标题下方一行，短块贴在右侧 */
.cal-block-range {
  flex: none;
  font-size: var(--fs-10);
  line-height: 1.3;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.cal-block.is-thin .cal-block-range { margin-left: auto; }

/* 人工标注过的段用虚线描边区分，比整块斜纹安静 */
.cal-block.is-manual { border-style: dashed; border-left-style: solid; }

.cal-block-title {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  line-height: 1.4;
  color: var(--text-primary);
  /* 允许两行：一行往往只能看到三五个字，等于什么都没写 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.cal-block-note {
  font-size: var(--fs-11);
  line-height: 1.45;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 底部 8px 是拉伸手柄，hover 才显形 */
.cal-resize {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 8px;
  cursor: ns-resize;
}

.cal-resize:hover { background: rgba(255, 255, 255, 0.35); }

/* 预览块：清晰告诉你「会落在哪、有多长」 */
.cal-ghost {
  position: absolute;
  left: 1px;
  right: 1px;
  z-index: 6;
  border-radius: var(--r-sm);
  border: 2px dashed var(--accent);
  background: var(--accent-soft);
  pointer-events: none;
  display: flex;
  align-items: flex-start;
  padding: 2px 6px;
  overflow: hidden;
}

.cal-ghost.is-new { background: var(--bg-elevated); }

.ghost-label {
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
  color: var(--accent);
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 10px;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
}

.cal-now {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--danger);
  pointer-events: none;
  z-index: 5;
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 2100;
  min-width: 190px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.24);
}

.ctx-menu button {
  text-align: left;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: var(--fs-11);
  color: var(--text-secondary);
  background: none;
}

.ctx-menu button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 删除是破坏性操作，默认就该是红的，不能只在 hover 才显形 */
.ctx-menu button.danger {
  margin-top: 2px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent);
  font-weight: var(--fw-medium);
}

.ctx-menu button.danger:hover {
  color: var(--text-inverse);
  background: var(--danger);
}

.ctx-sep {
  display: block;
  height: 1px;
  margin: 3px 4px;
  background: var(--border-subtle);
}

.ctx-hint {
  padding: 2px 9px 4px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.ctx-fade-enter-active,
.ctx-fade-leave-active {
  transition: opacity 110ms var(--ease), transform 130ms var(--ease);
}

.ctx-fade-enter-from,
.ctx-fade-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

.mini-tag.focus {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 记录层：只读原始采样 */
.record-layer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.rl-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.rl-head em {
  margin-left: auto;
  font-style: normal;
  opacity: 0.75;
}

.rl-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.rl-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  max-width: 320px;
  padding: 0 9px;
  height: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--text-tertiary);
}

.rl-search:focus-within { border-color: var(--accent); color: var(--accent); }

.rl-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: var(--fs-11);
  color: var(--text-primary);
}

.rl-order {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  flex: none;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
}

.rl-order:hover { background: var(--bg-hover); color: var(--text-primary); }

.rl-list {
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  overflow: hidden;
}

.rl-hour {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px var(--sp-3);
  background: var(--bg-inset);
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-10);
  font-weight: var(--fw-semibold);
  color: var(--text-tertiary);
  letter-spacing: .04em;
}

.rl-hour:first-child { border-top: none; }
.rl-hour em { font-style: normal; font-weight: normal; opacity: .7; }

.rl-row {
  display: grid;
  grid-template-columns: 52px 92px 1fr 60px;
  gap: var(--sp-2);
  padding: 5px var(--sp-3);
  font-size: var(--fs-11);
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.rl-row:hover { background: var(--bg-hover); }
.rl-time { color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.rl-app { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-dur { text-align: right; color: var(--text-tertiary); }

.rl-more {
  width: 100%;
  padding: 9px;
  font-size: var(--fs-11);
  color: var(--accent);
  background: var(--bg-elevated);
}

.rl-more:hover { background: var(--accent-soft); }

/* ---------- 悬浮按钮 ---------- */
.fab {
  position: fixed;
  right: 28px;
  bottom: 26px;
  z-index: 30;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 50%;
  color: var(--on-accent);
  background: var(--accent);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  transition: transform var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
.fab:hover { transform: scale(1.06); background: var(--accent-hover); }

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-8) 0;
  color: var(--text-tertiary);
}
.empty-title { font-size: var(--fs-14); color: var(--text-secondary); }
.empty-desc { font-size: var(--fs-11); }
</style>
