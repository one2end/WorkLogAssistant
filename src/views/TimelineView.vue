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
      <div class="view-switch" role="group" aria-label="视图模块">
        <button v-for="opt in viewOptions.filter(o => o.id !== 'record')" :key="opt.id" class="view-tab"
          :class="{ active: mode === opt.id }" :aria-pressed="mode === opt.id"
          :title="opt.title" @click="setMode(opt.id)">
          <Icon :name="opt.icon" :size="13" />{{ opt.label }}
        </button>
      </div>
      <span class="view-date">{{ dateLabel }}</span>
      <button v-if="mode !== 'record'" class="record-link" @click="setMode('record')">查看原始采样</button>
      <button v-else class="record-link" @click="setMode('timeline')">返回时间轴</button>
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

    <!-- 计划层只在日历里呈现；时间轴专心做展示层本身 -->


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

            <!-- 活动卡片：整卡可点。
                 点一次打开编辑器，再点同一张卡关闭它；三点菜单已移除。 -->
            <div
              v-if="b.type === 'activity'"
              class="tl-card"
              :class="{ 'is-editing': isEditing(b) }"
              :style="{ borderLeftColor: colorOf(b.category), background: cardBg(b.category) }"
              @click="toggleEditor(b, $event)"
              @contextmenu.prevent.stop="openCtx($event, selectedDate, b)"
            >
              <div class="card-top">
                <span class="card-badge" :style="{ color: colorOf(b.category), background: softColor(b.category, 0.22) }">
                  <Icon :name="iconOf(b.category)" :size="13" />
                </span>
                <span class="card-app" :title="cardTitle(b)">{{ cardTitle(b) }}</span>
                <span class="card-dur"><Icon name="clock" :size="11" /> {{ fmtCN(b.durationMs) }}</span>
              </div>
              <div v-if="cardNote(b)" class="card-note" :title="cardNote(b)">{{ cardNote(b) }}</div>
              <div class="card-meta">
                <span class="cat-chip" :style="{ color: colorOf(b.category), background: softColor(b.category) }">
                  {{ categoryLabel(b.category || '其他') }}
                </span>
                <span v-if="b.project" class="mini-tag project">{{ b.project }}</span>
                <span v-if="b.tag" class="mini-tag focus">{{ b.tag }}</span>
                <span v-else-if="b.manual" class="mini-tag">标注</span>
                <span v-if="b.uncertain" class="mini-tag warn" title="该段存在数据空档，时长可能不准">
                  <Icon name="alert" :size="10" /> 不确定
                </span>
              </div>
            </div>

            <!-- 空闲卡片：整卡可点补记。
                 原先右侧那个圆形 + 会和右下角 FAB 撞在一起，像两个重复按钮。 -->
            <div v-else class="tl-card is-gap" :class="{ 'is-short': b.durationMin < 60 }" @click="openManualFor(b, $event)">
              <span class="gap-label">{{ b.durationMin >= 60 ? '待补充' : '未记录' }} · {{ fmtCN(b.durationMin * 60000) }}</span>
              <span class="gap-hint">补记 ›</span>
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
      <div v-else class="cal-workspace">
        <div class="cal-view">
          <div class="cal-head">
            <span>{{ calLabel }}</span>
            <em v-if="calLoading">加载中…</em>
            <span class="cal-span">{{ calSpan }} 天视图</span>
            <label class="cal-control">显示 <select v-model="calendarLayers" aria-label="日历显示内容"><option value="both">计划与实际</option><option value="plan">仅计划</option><option value="actual">仅实际</option></select></label>
            <span class="cal-drag-tip">点击打开，再点关闭；拖动调整，跨日时可在顶部改结束时间</span>
          </div>

        <div class="cal-scroll" ref="calScroll">
        <div class="cal-grid" :class="{ 'has-lane-heads': calendarLayers === 'both' }" :style="{ '--cols': calDays.length }">
          <!-- 左侧统一的时间刻度 -->
          <div class="cal-ruler">
            <span
              v-for="h in 25"
              :key="'r' + h"
              class="cal-tick"
              :style="{ top: ((h - 1) * 96) + 'px' }"
            >{{ pad(h - 1) }}</span>
          </div>

          <div
            v-for="d in visibleCalDays"
            :key="d.date"
            class="cal-col"
            :class="{ 'is-current': d.date === selectedDate }"
          >
            <button class="cal-day" @click="$emit('update:selectedDate', d.date)">
              <b>{{ d.label }}</b>
              <span>{{ d.num }}</span>
              <em v-if="d.total">{{ d.total }}h</em>
              <span v-if="d.plans.some(p => p.source === 'carryover-plan')" class="cal-day-link" title="上方 00:00 起有前一天计划的续段">↖ 前日</span>
              <span v-if="d.plans.some(p => p.fullEndMin > 1440)" class="cal-day-link" title="下方计划延续到次日">次日 ↘</span>
            </button>
            <div v-if="calendarLayers === 'both'" class="cal-lane-heads"><span>计划</span><span>实际</span></div>

            <div
              class="cal-track"
              :class="{ 'has-both-lanes': calendarLayers === 'both' }"
              :data-date="d.date"
              @pointerdown.self="startDraft($event, d.date)"
              @contextmenu.self.prevent="openTrackCtx($event, d.date)"
              @dragover.prevent="dragPlanOver($event, d.date)"
              @drop.prevent="dropPlan($event, d.date)"
            >
              <div
                v-for="p in d.plans"
                :key="p.planKey || p.id"
                class="cal-plan-block"
                :class="{
                  'is-local': p.source === 'local-plan' || p.source === 'carryover-plan',
                  'is-continuation': p.source === 'carryover-plan',
                  'flows-next': p.source === 'local-plan' && p.fullEndMin > 1440,
                  'is-readonly': p.source !== 'local-plan' && p.source !== 'carryover-plan',
                  'is-dim': dragState?.plan && dragState.plan.id === p.id
                }"
                :style="calPlanBlockStyle(p)"
                role="button"
                tabindex="0"
                :aria-label="`${clock(p.startMin)}到${clock(p.endMin)}，${p.label}，${planStatus(p, d).label}；查看计划与实际`"
                @pointerdown.stop="startPlanBlockDrag($event, d.date, p)"
                @keydown.enter.prevent.stop="openPlanComparison(d.date, p)"
                @keydown.space.prevent.stop="openPlanComparison(d.date, p)"
                @contextmenu.prevent.stop="openPlanCtx($event, d.date, p)"
              >
                <!-- 整块可点开对照或拖动；底边调整时长。 -->
                <span
                  class="cal-plan-handle"
                  :title="`${clock(p.startMin)}–${clock(p.endMin)} · ${p.label} · ${planSourceLabel(p)}`"
                />
                <span class="cal-plan-type">{{ categoryLabel(p.category || '其他') }} · {{ p.source === 'carryover-plan' ? '前日计划续段' : '计划' }}</span>
                <small>{{ clock(p.startMin) }}–{{ clock(p.endMin) }}</small>
                <span v-if="p.source === 'local-plan' && p.fullEndMin > 1440" class="cal-plan-link">↘ 次日 {{ clock(p.fullEndMin - 1440) }}</span>
                <span v-if="p.source === 'carryover-plan'" class="cal-plan-link">↖ {{ p.originDate }} {{ clock(p.originStartMin) }} → 今日 {{ clock(p.endMin) }}</span>
                <span class="cal-plan-label">{{ p.label }}</span>
                <span v-if="p.project" class="cal-plan-label">{{ p.project }}</span>
                <span class="cal-plan-status">{{ planStatus(p, d).label }}</span>
                <span class="cal-plan-resize" title="拖动调整计划时长" @pointerdown.stop="startPlanResize($event, d.date, p)" />
              </div>
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
                :title="`${categoryLabel(b.category || '其他')} · ${clock(b.startMin)}–${clock(b.endMin)} · ${calendarBlockDetails(b)}`"
                @pointerdown.stop="startBlockDrag($event, d.date, b)"
                @contextmenu.prevent.stop="openCtx($event, d.date, b)"
              >
                <span class="cal-block-title">{{ categoryLabel(b.category || '其他') }}</span>
                <span class="cal-block-range">{{ clock(b.startMin) }}–{{ clock(b.endMin) }}</span>
                <span v-if="calendarBlockDetails(b)" class="cal-block-note">{{ calendarBlockDetails(b) }}</span>
                <span class="cal-resize" @pointerdown.stop="startResize($event, d.date, b)" />
              </div>

              <!-- 拖拽/新建时的预览块：位置、时长都看得见 -->
              <div
                v-if="ghost && ghost.date === d.date"
                class="cal-ghost"
                :class="{ 'is-new': ghost.isNew, 'lane-plan': ghost.lane === 'plan', 'lane-fact': ghost.lane === 'fact' }"
                :style="{ top: ghost.top + 'px', height: ghost.height + 'px' }"
              >
                <span class="ghost-label">{{ ghost.label }}</span>
              </div>
              <div v-if="ghost && ghost.nextDate === d.date" class="cal-ghost is-new"
                :class="{ 'lane-plan': ghost.lane === 'plan', 'lane-fact': ghost.lane === 'fact' }"
                :style="{ top: '0px', height: ghost.nextHeight + 'px' }">
                <span class="ghost-label">跨日续段 · 00:00–{{ clock(ghost.totalEndMin - 1440) }}</span>
              </div>

              <div v-if="d.date === todayStr" class="cal-now" :style="{ top: (nowMin / 60 * 96) + 'px' }" />
            </div>
          </div>
        </div>
        </div>
        </div>
      </div>
    </template>

    <div v-if="selectedPlan" class="plan-compare-mask" @click.self="selectedPlan = null">
      <section ref="planCompare" class="plan-compare" role="dialog" aria-label="计划与实际对照" tabindex="-1">
        <header class="pc-head"><div><small>{{ selectedPlan.date }} · {{ clock(selectedPlan.startMin) }}–{{ clock(selectedPlan.endMin) }}</small><h3>{{ selectedPlan.label }}</h3></div><button aria-label="关闭对照" @click="selectedPlan = null">×</button></header>
        <p class="pc-status">{{ selectedPlanStatus.label }} · {{ selectedPlanStatus.detail }}</p>
        <div class="pc-columns">
          <div><strong>计划</strong><p>{{ categoryLabel(selectedPlan.category || '其他') }} · {{ fmtCN(selectedPlan.durationMin * 60000) }}</p></div>
          <div><strong>这段时间的实际记录</strong>
            <p v-if="!selectedPlanBlocks.length">没有足够的实际记录；空白不代表计划没有完成。</p>
            <p v-for="b in selectedPlanBlocks" :key="b.key">{{ clock(Math.max(b.startMin, selectedPlan.startMin)) }}–{{ clock(Math.min(b.endMin, selectedPlan.endMin)) }} · {{ blockLabel(b) }}</p>
          </div>
        </div>
        <p v-if="selectedPlan.actual" class="pc-note">已确认：{{ selectedPlan.actual.label || selectedPlan.label }}。计划确认状态与事实记录分别保存。</p>
        <div class="pc-actions">
          <button class="btn btn-ghost btn-sm" @click="editComparedPlan">编辑计划</button>
          <button class="btn btn-ghost btn-sm" @click="recordComparedActual">实际有调整，手工记录</button>
          <span class="pc-spacer" />
          <template v-if="!selectedPlan.actual">
            <button class="btn btn-secondary btn-sm" :disabled="selectedPlan.source === 'carryover-plan' || !selectedPlanScreenEvidence || !!convertingPlanKey" :title="selectedPlanScreenEvidence ? '' : '该时段没有可确认的屏幕活动'" @click="confirmComparedPlan('screen')">使用屏幕活动</button>
            <button class="btn btn-primary btn-sm" :disabled="!!convertingPlanKey" @click="confirmComparedPlan('plan')">按计划记入</button>
          </template>
        </div>
      </section>
    </div>

    <!-- 悬浮补记按钮：记录层是只读事实层，不出现写操作入口 -->
    <button v-if="mode !== 'record'" class="fab" title="手工补记" @click="toggleManual($event)">
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
        <template v-if="ctxMenu.kind === 'plan'">
          <button @click="ctxDo('edit-plan')">编辑计划</button>
          <button @click="ctxDo('copy-plan')">复制计划</button>
          <template v-if="!ctxMenu.block.actual">
            <i class="ctx-sep" />
            <button @click="ctxDo('convert-plan')">按计划记入事实</button>
            <button v-if="ctxMenu.block.source !== 'carryover-plan'" @click="ctxDo('convert-screen')">从屏幕活动生成事实</button>
          </template>
          <i class="ctx-sep" />
          <button v-if="ctxMenu.block.source === 'local-plan'" class="danger" @click="ctxDo('delete-plan')">删除本地计划</button>
          <span class="ctx-hint">{{ clock(ctxMenu.block.startMin) }}–{{ clock(ctxMenu.block.endMin) }} · {{ ctxMenu.block.label }}</span>
        </template>
        <template v-else-if="!ctxMenu.empty">
          <button @click="ctxDo('edit')">编辑这一段</button>
          <button @click="ctxDo('copy')">复制这一段时间</button>
          <i class="ctx-sep" />
          <button class="danger" @click="ctxDo('delete')">删除这一段</button>
          <i class="ctx-sep" />
          <span class="ctx-hint">{{ clock(ctxMenu.block.startMin) }}–{{ clock(ctxMenu.block.endMin) }} · {{ entryLabel(ctxMenu.block) }}</span>
        </template>
        <template v-else>
          <button @click="ctxDo(ctxMenu.draftType === 'plan' ? 'new-plan' : 'new')">在这里新建{{ ctxMenu.draftType === 'plan' ? '计划' : '事实' }} 15 分钟</button>
          <button v-if="planClip" @click="ctxDo('paste-plan')">在这里粘贴计划</button>
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
      :category-labels="categoryLabels"
      :deletable="editorDeletable"
      :saving="editSaving"
      :max-duration="mode === 'calendar' ? 1440 : 300"
      :note-hints="noteHints"
      :project-hints="projectHints"
      :show-apply-all="canApplyAllDay"
      :anchor-el="editorAnchorEl"
      @save="saveSegment"
      @delete="deleteSegment"
      @close="closeSegment"
      @add-category="createCategoryFromEditor"
      @note-input="onNoteInput"
    />

    <!-- 计划编辑器：新建和编辑都走这个浮层，日历不再有独立侧栏 -->
    <PlanEditor
      :open="planOpen"
      :initial="planDraft"
      :categories="categories"
      :category-labels="categoryLabels"
      :project-hints="projectHints"
      :saving="savingPlan"
      :theme="theme"
      @save="savePlan"
      @delete="removeLocalPlan"
      @close="closePlanEditor"
    />
    <div v-if="pendingPlanMove" class="plan-move-mask" @click.self="pendingPlanMove = null">
      <div class="plan-move-prompt" role="dialog" aria-label="调整重复计划范围">
        <strong>调整哪几次计划？</strong>
        <span>{{ pendingPlanMove.label }} · {{ pendingPlanMove.date }}</span>
        <div><button class="btn btn-ghost btn-sm" @click="pendingPlanMove = null">取消</button>
          <button class="btn btn-secondary btn-sm" @click="applyPendingPlanMove('single')">仅本次</button>
          <button class="btn btn-primary btn-sm" @click="applyPendingPlanMove('future')">本次及以后</button></div>
      </div>
    </div>
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';
import DateNav from '../components/DateNav.vue';
import EmptyIllustration from '../components/EmptyIllustration.vue';
import SegmentEditor from '../components/SegmentEditor.vue';
import PlanEditor from '../components/PlanEditor.vue';
import { colorForCategory } from '../styles/palette.js';
// slotRule 是 CommonJS 模块，Rollup 无法静态分析其命名导出，
// 所以走默认导入再取属性——两个环境下都能拿到同一个函数。
import slotRule from '@slot-rule';

const { snapToStep } = slotRule;

import { ipc } from '../utils/ipc.mjs';

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
  components: { Icon, DateNav, EmptyIllustration, SegmentEditor, PlanEditor },
  props: {
    report: { type: Object, required: true },
    activities: { type: Array, default: () => [] },
    selectedDate: { type: String, required: true },
    datesWithData: { type: Set, default: () => new Set() },
    focusTarget: { type: Object, default: null },
    customCategories: { type: Array, default: () => [] },
    categoryMeta: { type: Object, default: () => ({}) },
    categoryMerges: { type: Object, default: () => ({}) },
    theme: { type: String, default: 'dark' }
  },
  emits: ['update:selectedDate', 'shift', 'today', 'refresh',
    'manual-error', 'manual-success', 'focus-consumed', 'focus-missed', 'add-category'],
  data() {
    return {
      // mode 同时表达「视图」和「层」：timeline/calendar 是展示层，record 是只读事实层。
      mode: 'timeline',
      sortDesc: false,
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
      planClip: null,
      planDragItem: null,
      selectedPlan: null,
      // 日历显示内容：'plan' 仅计划 / 'actual' 仅展示层 / 'both' 两者叠加
      calendarLayers: 'both',
      // 拖动/新建过程中的预览块
      ghost: null,
      dragState: null,
      // 右键菜单
      ctxMenu: null,
      // 统一的分段编辑器（贴近被点的块弹出）
      editorOpen: false,
      editorAnchor: null,
      editorAnchorEl: null,
      editorDeletable: false,
      editorTarget: null,
      editorForm: { key: '', range: '', startTime: '00:00', durationMin: 15, app: '', category: '其他', project: '', note: '' },
      editSaving: false,
      // 备注候选：历史用过的说法，可直接复用
      noteHints: [],
      noteHintSource: { app: '', date: '' },
      highlightMin: null,
      manualOpen: false,
      manualTime: '09:00',
      manualDuration: 30,
      manualTitle: '',
      manualCategory: '其他',
      // 补记备注的历史候选
      manualHints: [],
      addingManualCategory: false,
      newManualCategory: '',
      newManualCategoryColor: '#6f9fe8',
      savingManual: false,
      planOpen: false,
      // 交给 PlanEditor 的初始值：localId 为空表示新建
      planDraft: {},
      pendingPlanMove: null,
      // 上次保存用的重复规则，新建时默认沿用
      lastPlanRepeat: 'none',
      savingPlan: false,
      convertingPlanKey: '',
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
      this.closePlanEditor();
      this.selectedPlan = null;
      this.pendingPlanMove = null;
      if (this.mode === 'calendar') this.loadCalendar();
    },
    // 拉宽/收窄窗口时自动切换 日 / 三日 / 周
    windowWidth() {
      if (this.mode === 'calendar') this.loadCalendar();
    }
  },
  computed: {
    categories() {
      return [...new Set(['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他', ...this.customCategories.map(c => c.key || c.name).filter(Boolean)])]
        .filter(key => !this.categoryMerges[key]);
    },
    projectHints() {
      const names = [
        ...((this.report?.slots || []).map(s => s.project)),
        ...((this.report?.plan || []).map(p => p.project)),
        ...this.calDays.flatMap(d => [...d.blocks, ...d.plans].map(x => x.project))
      ];
      return [...new Set(names.map(x => String(x || '').trim()).filter(Boolean))].sort();
    },
    categoryLabels() {
      return Object.fromEntries(this.categories.map(key => [key, this.categoryLabel(key)]));
    },
    /**
     * 「当天同应用全部同步」只在自动录制的应用上有意义：
     * 手工标注本来就是一条一条的，同步反而会覆盖掉别的标注。
     */
    canApplyAllDay() {
      const b = this.editorTarget || {};
      if (!b || b.isNew) return false;
      const app = (this.editorForm && this.editorForm.app) || '';
      if (!app || app === '手工标注') return false;
      const date = b.date || this.selectedDate;
      // 当天这个应用散落在多处时才提供同步；只出现一处就没有「全部」可言
      const spans = this.appSpansOfDay(date, app);
      return spans.length > 1 || (spans.length === 1 && spans[0].durationMin > 15);
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
    /** 日历显示内容：仅计划 / 仅实际 / 两者同时，只影响渲染，不改数据 */
    visibleCalDays() {
      const withPlans = this.calendarLayers !== 'actual';
      const withBlocks = this.calendarLayers !== 'plan';
      return this.calDays.map(d => ({
        ...d,
        plans: withPlans ? (d.plans || []) : [],
        blocks: withBlocks ? (d.blocks || []) : []
      }));
    },
    selectedPlanDay() {
      return this.calDays.find(d => d.date === this.selectedPlan?.date);
    },
    selectedPlanBlocks() {
      if (!this.selectedPlanDay) return [];
      return this.selectedPlanDay.blocks.filter(b => this.overlapMinutes(this.selectedPlan, b) >= 5);
    },
    selectedPlanStatus() {
      return this.selectedPlan ? this.planStatus(this.selectedPlan, this.selectedPlanDay) : { label: '', detail: '' };
    },
    selectedPlanScreenEvidence() {
      return (this.selectedPlanDay?.threads || []).some(t => this.overlapMinutes(this.selectedPlan, {
        startMin: Number(t.startMin) || 0,
        endMin: (Number(t.startMin) || 0) + (Number(t.durationMs) || 0) / 60000
      }) >= 5);
    },
    selectedPlanEnded() {
      return this.selectedPlan ? this.isPlanEnded(this.selectedPlan, this.selectedPlan.date) : false;
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
          { value: this.fmtCN(this.report.stats?.recordedMs || 0), label: '已记录', icon: 'timer' },
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
            last.project === (slot.project || '') &&
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
          project: slot.project || '',
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
      const count = Math.max(1, Math.min(96, Math.ceil(this.dayEndMin / 15)));
      const covered = ((this.report && this.report.slots) || []).slice(0, count).filter(s => s.filledMin > 0).length;
      return Math.round(covered / count * 100);
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
      if (e.key === 'Escape' && this.selectedPlan) { this.selectedPlan = null; return; }
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
        const res = await ipc.invoke('delete-focus-session', { date, id: b.focusId });
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
      const res = await ipc.invoke('delete-display-range', {
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
            const res = await ipc.invoke('get-day-analytics', date);
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
      const plans = ((report && report.plan) || []).map(item => ({
        ...item,
        date,
        height: +Math.max(0.7, ((item.endMin - item.startMin) / 1440) * 100).toFixed(2)
      }));
      // 同时段的独立计划和跨日续段分列显示，避免后渲染的块盖住前一个。
      const orderedPlans = [...plans].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
      let cluster = [];
      let clusterEnd = -1;
      const finishCluster = () => {
        const laneEnds = [];
        for (const item of cluster) {
          let lane = laneEnds.findIndex(end => end <= item.startMin);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = item.endMin;
          item.layoutLane = lane;
        }
        for (const item of cluster) item.layoutLanes = laneEnds.length;
      };
      for (const item of orderedPlans) {
        if (cluster.length && item.startMin >= clusterEnd) { finishCluster(); cluster = []; clusterEnd = -1; }
        cluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.endMin);
      }
      if (cluster.length) finishCluster();
      const merged = [];
      for (const slot of slots) {
        if (!slot.filledMin || !slot.category) continue;
        const last = merged[merged.length - 1];
        if (last && last.category === slot.category && last.endMin === slot.startMin &&
            last.project === (slot.project || '') &&
            last.focusId === (slot.layer === 'focus' ? (slot.focusId || null) : null)) {
          last.endMin = slot.startMin + 15;
          last.minutes += slot.filledMin;
          if (slot.note && !last.notes.includes(slot.note)) last.notes.push(slot.note);
          if (slot.layer === 'focus' && slot.focusId && !last.focusId) last.focusId = slot.focusId;
        } else {
          merged.push({
            category: slot.category,
            project: slot.project || '',
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
        project: m.project || '',
        note: (m.notes || []).join(' · ').slice(0, 80),
        focusId: m.focusId || null,
        manual: m.manual,
        height: +Math.max(0.7, ((m.endMin - m.startMin) / 1440) * 100).toFixed(2)
      }));
      const total = merged.reduce((n, m) => n + m.minutes, 0) / 60;
      return {
        date,
        label: `周${wd[d.getDay()]}`,
        num: d.getDate(),
        blocks,
        plans,
        threads: (report && report.activityThreads) || [],
        total: Math.round(total * 10) / 10
      };
    },

    /** 时间轴卡片标题：优先应用名，应用名无意义时退回「做了什么」 */
    cardTitle(b) {
      if (b.manual) return this.entryLabel(b);
      const app = (b.app || '').trim();
      const note = this.cleanNote(this.noteOf(b));
      if (app && !['记录', '标注', '手工记录', 'unknown'].includes(app)) return app;
      return note || this.categoryLabel(b.category || '其他');
    },
    cardNote(b) {
      if (b.manual) return '';
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
      return this.entryLabel(b);
    },
    calendarBlockDetails(b) {
      return [...new Set([this.entryRemark(b), b.project, this.blockSub(b)].filter(Boolean))].join(' · ');
    },
    blockSub(b) {
      // 一天/三天视图里才显示来源，七天视图太窄
      if (this.calSpan > 3) return '';
      if (b.manual) return '';
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
      return String(note).trim();
    },
    entryRemark(b) {
      const cat = b.category || '其他';
      const label = this.categoryLabel(cat);
      let value = String(b.note || (b.titles || []).join(' · ') || '').trim();
      const app = String(b.app || '').trim();
      if (b.focusId && app && value && value !== app) value = `${app} · ${value}`;
      if (!value && app && !['记录', '标注', '手工记录', '手工标注', 'unknown', cat, label].includes(app)) value = app;
      for (const prefix of [cat, label]) {
        if (value.startsWith(`${prefix}-`) || value.startsWith(`${prefix}－`)) {
          value = value.slice(prefix.length + 1).trim();
          break;
        }
      }
      return value === label || value === cat ? '' : value;
    },
    entryLabel(b) {
      const label = this.categoryLabel(b.category || '其他');
      const remark = this.entryRemark(b);
      return remark ? `${label}-${remark}` : label;
    },

    /**
     * 把鼠标位置换算成 15 分钟刻度。
     *
     * 像素→分钟的换算是 UI 坐标问题（96px = 1 小时），只有最后的
     * 「吸附到 15 分钟」是数据规则，交给 slotRule。夹取范围保持不变。
     */
    minuteAt(trackEl, clientY) {
      const rect = trackEl.getBoundingClientRect();
      const rawMinute = (clientY - rect.top) / 96 * 60;
      const minute = snapToStep(rawMinute);
      return Math.max(0, Math.min(1440, minute));
    },
    /** 预览块的几何信息（top/height 用百分比，和真实块同一套坐标） */
    ghostOf(date, startMin, endMin, isNew) {
      const a = Math.max(0, Math.min(startMin, endMin));
      const b = Math.min(1440, Math.max(startMin, endMin));
      return {
        date,
        startMin: a,
        endMin: b,
        top: a / 60 * 96,
        height: Math.max(12, (b - a) / 60 * 96),
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

    startPlanNativeDrag(e, item) {
      this.planDragItem = { ...item };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = item.source === 'local-plan' ? 'move' : 'copy';
        e.dataTransfer.setData('text/plain', item.label || '计划');
      }
    },
    endPlanNativeDrag() {
      this.planDragItem = null;
      this.ghost = null;
    },
    dragPlanOver(e, date) {
      if (!this.planDragItem) return;
      const track = e.currentTarget;
      const startMin = Math.min(1425, this.minuteAt(track, e.clientY));
      this.ghost = this.ghostOf(date, startMin, startMin + this.planDragItem.durationMin, true);
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.planDragItem.source === 'local-plan' ? 'move' : 'copy';
    },
    async dropPlan(e, date) {
      const item = this.planDragItem;
      this.planDragItem = null;
      const track = e.currentTarget;
      const startMin = Math.min(1425, this.minuteAt(track, e.clientY));
      this.ghost = null;
      if (!item) return;
      const original = this.editablePlan(item);
      this.proposePlanMove({ ...original, date, startMin, occurrenceDate: original.date });
    },
    async savePlanAt(item, date, startMin, keepIdentity = false) {
      const res = await ipc.invoke('save-local-plan', {
        localId: keepIdentity ? item.localId : '',
        date,
        startMin,
        durationMin: item.durationMin || 30,
        label: item.label || item.title || '计划',
        category: item.category || '其他',
        // 滴答计划只有 projectName，复制成本地计划时别把项目标签丢了
        project: item.project || item.projectName || ''
      });
      if (!res?.ok) {
        this.$emit('manual-error', res?.error || '移动计划失败');
        return;
      }
      this.$emit('manual-success', keepIdentity ? '计划已移动' : '已复制为本地计划');
      await this.refreshAfterWrite();
    },
    startPlanBlockDrag(e, date, item) {
      if (e.button !== 0) return;
      const originX = e.clientX;
      const originY = e.clientY;
      let moved = false;
      let targetDate = date;
      let targetStart = item.startMin;
      this.closeCtx();

      const onMove = (ev) => {
        if (!moved && Math.hypot(ev.clientX - originX, ev.clientY - originY) < 4) return;
        moved = true;
        const track = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cal-track');
        if (!track) return;
        targetDate = track.dataset.date || date;
        targetStart = Math.min(1425, this.minuteAt(track, ev.clientY));
        this.dragState = { plan: item, moved: true };
        this.ghost = this.ghostOf(targetDate, targetStart, targetStart + item.durationMin, false);
      };
      const onUp = async () => {
        this.endDrag();
        if (!moved) {
          this.openPlanComparison(date, item);
          return;
        }
        const original = this.editablePlan(item);
        if (item.source === 'carryover-plan') {
          const shifted = new Date(`${original.date}T00:00:00`);
          shifted.setMinutes(original.startMin + targetStart - item.startMin);
          targetDate = `${shifted.getFullYear()}-${this.pad(shifted.getMonth() + 1)}-${this.pad(shifted.getDate())}`;
          targetStart = shifted.getHours() * 60 + shifted.getMinutes();
        }
        this.proposePlanMove({ ...original, date: targetDate, startMin: targetStart,
          occurrenceDate: original.date });
      };
      this.beginDrag(onMove, onUp);
    },
    startPlanResize(e, date, item) {
      if (e.button !== 0) return;
      const startY = e.clientY;
      const base = this.editablePlan(item);
      let duration = base.durationMin;
      let moved = false;
      const onMove = ev => {
        if (Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        duration = Math.max(15, Math.min(1440, snapToStep(base.durationMin + (ev.clientY - startY) / 96 * 60)));
        this.dragState = { plan: item, moved: true };
        const visibleEnd = item.source === 'carryover-plan'
          ? Math.max(15, base.startMin + duration - 1440)
          : Math.min(1440, item.startMin + duration);
        this.ghost = this.ghostOf(date, item.startMin, visibleEnd, false);
      };
      const onUp = () => {
        this.endDrag();
        if (!moved) { this.openPlanComparison(date, item); return; }
        this.proposePlanMove({ ...base, durationMin: duration, occurrenceDate: base.date });
      };
      this.beginDrag(onMove, onUp);
    },

    /**
     * 空白处点击预填 15 分钟，拖动可划更长时段；都先进入编辑器确认。
     */
    startDraft(e, date) {
      if (e.button !== 0) return;
      if (this.editorOpen || this.selectedPlan || this.ctxMenu) {
        this.closeSegment();
        this.selectedPlan = null;
        this.closeCtx();
        return;
      }
      const track = e.currentTarget;
      const trackRect = track.getBoundingClientRect();
      const anchor = this.minuteAt(track, e.clientY);
      const lane = this.calendarLayers === 'plan' ? 'plan' : this.calendarLayers === 'actual' ? 'fact'
        : (e.clientX - trackRect.left < trackRect.width * 0.4 ? 'plan' : 'fact');
      let current = anchor;
      let moved = false;
      this.closeCtx();
      this.selectedBlock = null;

      const onMove = (ev) => {
        const hovered = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cal-track');
        const nextDay = this.nextDate(date);
        const onNextDay = hovered?.dataset.date === nextDay;
        const raw = Math.round(((ev.clientY - trackRect.top) / 96 * 60) / 15) * 15;
        current = onNextDay ? 1440 + this.minuteAt(hovered, ev.clientY) : Math.max(0, Math.min(anchor + 1440, raw));
        if (Math.abs(current - anchor) >= 15) moved = true;
        if (!moved) return;
        const a = Math.min(anchor, current);
        const b = Math.min(a + 1440, Math.max(anchor, current, a + 15));
        this.ghost = { ...this.ghostOf(date, a, Math.min(1440, b), true), lane,
          totalEndMin: b, nextDate: b > 1440 ? nextDay : '',
          nextHeight: Math.max(12, (b - 1440) / 60 * 96),
          label: `${this.clock(a)} – ${b > 1440 ? '次日 ' + this.clock(b - 1440) : this.clock(b)} · ${b - a} 分钟` };
      };
      const onUp = () => {
        const g = this.ghost || { ...this.ghostOf(date, Math.min(anchor, 1425), Math.min(anchor + 15, 1440), true), lane };
        this.endDrag();
        if (!g || g.endMin <= g.startMin) return;
        const totalEnd = g.totalEndMin || g.endMin;
        if (lane === 'plan') {
          this.openPlanEditorRange(date, g.startMin, totalEnd - g.startMin);
          return;
        }
        // 用「刚划出来的那一段」作为锚点，浮层就会贴在那儿
        const anchorRect = {
          top: trackRect.top + (g.startMin / 60 * 96),
          left: trackRect.left,
          width: trackRect.width,
          height: Math.max(16, ((g.endMin - g.startMin) / 60 * 96))
        };
        anchorRect.bottom = anchorRect.top + anchorRect.height;
        this.openSegment({
          type: 'activity',
          key: `new-${date}-${g.startMin}`,
          date,
          isNew: true,
          startMin: g.startMin,
          endMin: totalEnd,
          durationMin: totalEnd - g.startMin,
          durationMs: (totalEnd - g.startMin) * 60000,
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
      const dur = Math.max(15, snapToStep(b.endMin - b.startMin));
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
        const delta = snapToStep(minute - originStart);
        targetStart = Math.max(0, Math.min(1440 - dur, originStart + delta));
        this.dragState = { block: b, moved: true };
        this.ghost = this.ghostOf(date, targetStart, targetStart + dur, false);
      };
      const onUp = async () => {
        this.endDrag();
        if (!moved) {
          // 点一下打开编辑器，再点同一块关闭它
          this.toggleEditor(this.blockOf(date, b), { currentTarget: el });
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
    openPlanCtx(e, date, item) {
      this.editorOpen = false;
      this.ctxMenu = {
        kind: 'plan',
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 150),
        date,
        block: { ...item, date },
        empty: false
      };
    },
    overlapMinutes(a, b) {
      return Math.max(0, Math.min(Number(a.endMin) || 0, Number(b.endMin) || 0) - Math.max(Number(a.startMin) || 0, Number(b.startMin) || 0));
    },
    isPlanEnded(plan, date) {
      const end = new Date(`${date}T00:00:00`);
      end.setMinutes(Number(plan.fullEndMin || plan.endMin) || 0);
      return end.getTime() <= Date.now();
    },
    planStatus(plan, day) {
      if (plan.actual) return { label: '已确认', detail: plan.actual.source === 'screen' ? '已使用屏幕活动，不重复累计时长' : '已按计划写入人工事实' };
      const start = new Date(`${plan.date}T00:00:00`);
      start.setMinutes(plan.startMin);
      if (start.getTime() > Date.now()) return { label: '待开始', detail: '计划尚未开始' };
      if (!this.isPlanEnded(plan, plan.date)) return { label: '进行中', detail: '计划时段尚未结束，可在结束后核对实际情况' };
      const matches = (day?.blocks || []).filter(b => this.overlapMinutes(plan, b) >= 5);
      if (!matches.length) return { label: '待核对', detail: '这段时间尚无足够的实际记录' };
      const covered = Math.min(plan.durationMin, matches.reduce((n, b) => n + this.overlapMinutes(plan, b), 0));
      const matching = matches.reduce((n, b) => n + (b.category === plan.category ? this.overlapMinutes(plan, b) : 0), 0);
      if (matching >= (plan.endMin - plan.startMin) / 2) return { label: '活动相近', detail: `同类活动覆盖约 ${Math.round(matching)} 分钟，仍需确认是否完成计划` };
      return { label: '有调整', detail: `记录覆盖约 ${Math.round(covered)} 分钟，活动类别与计划不同或覆盖不足` };
    },
    async openPlanComparison(date, item) {
      this.ctxMenu = null;
      this.closeSegment();
      if (this.selectedPlan?.id === item.id && this.selectedPlan?.date === date) {
        this.selectedPlan = null;
        return;
      }
      this.selectedPlan = { ...item, date };
      await this.$nextTick();
      this.$refs.planCompare?.focus();
    },
    editComparedPlan() {
      const plan = this.selectedPlan;
      this.selectedPlan = null;
      this.editPlanFromCalendar(plan);
    },
    recordComparedActual() {
      const plan = this.selectedPlan;
      if (!plan) return;
      this.selectedPlan = null;
      this.openSegment({
        type: 'activity', key: `new-${plan.date}-${plan.startMin}`, date: plan.date,
        isNew: true, startMin: plan.startMin, endMin: plan.endMin,
        durationMin: plan.endMin - plan.startMin, durationMs: (plan.endMin - plan.startMin) * 60000,
        app: '', category: plan.category || '其他', titles: [], manual: true, focusId: null
      }, { currentTarget: null, _rect: { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 1, height: 1, bottom: window.innerHeight / 2 } });
    },
    async confirmComparedPlan(mode) {
      const plan = this.selectedPlan;
      if (!plan) return;
      const original = this.editablePlan(plan);
      if (await this.convertPlan(original, mode, original.date)) this.selectedPlan = null;
    },
    /** 轨道空白处右键：这里没有块，给「新建 / 粘贴」而不是什么都不做 */
    openTrackCtx(e, date) {
      const track = e.currentTarget;
      const rect = track.getBoundingClientRect();
      const minute = this.minuteAt(track, e.clientY);
      const draftType = this.calendarLayers === 'plan' ? 'plan' : this.calendarLayers === 'actual' ? 'fact'
        : (e.clientX - rect.left < rect.width * 0.4 ? 'plan' : 'fact');
      this.editorOpen = false;
      this.ghost = null;
      this.ctxMenu = {
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 120),
        date,
        minute,
        draftType,
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
      if (menu.kind === 'plan') {
        if (action === 'edit-plan') this.editPlanFromCalendar(menu.block);
        else if (action === 'copy-plan') this.copyPlan(menu.block);
        else if (action === 'delete-plan') this.removeLocalPlan(menu.block);
        else if (action === 'convert-plan') {
          const plan = this.editablePlan(menu.block);
          this.convertPlan(plan, 'plan', plan.date);
        } else if (action === 'convert-screen') {
          const plan = this.editablePlan(menu.block);
          this.convertPlan(plan, 'screen', plan.date);
        }
        return;
      }
      if (menu.empty) {
        const draftDate = menu.minute >= 1440 ? this.nextDate(menu.date) : menu.date;
        const draftStart = menu.minute >= 1440 ? Math.min(225, menu.minute - 1440) : Math.min(1425, menu.minute);
        if (action === 'new-plan') {
          this.openPlanEditorRange(draftDate, draftStart, 15);
        } else if (action === 'paste-plan') {
          if (this.planClip) this.savePlanAt(this.planClip, menu.date, Math.min(1440 - this.planClip.durationMin, menu.minute), false);
        } else if (action === 'new') {
          const startMin = draftStart;
          this.openSegment({
            type: 'activity',
            key: `new-${draftDate}-${startMin}`,
            date: draftDate,
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
    copyPlan(item) {
      this.planClip = { ...item, localId: '' };
      this.$emit('manual-error', '已复制计划；在目标时间右键选择“在这里粘贴计划”');
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
        project: b.project || '',
        titles: b.titles ? [...b.titles] : (b.note ? [b.note] : []),
        manual: !!b.manual,
        focusId: b.focusId || null
      };
    },
    /**
     * 点一下打开编辑器，再点同一项就关闭它。
     * 点别处关闭由 SegmentEditor 自己的「点外部关闭」处理，这里只管「同一项再点一次」。
     */
    toggleEditor(b, ev) {
      if (this.editorOpen && this.isEditing(b)) {
        this.closeSegment();
        return;
      }
      this.openSegment(b, ev);
    },
    /** 当前编辑器是不是正在编辑这一块 */
    isEditing(b) {
      const t = this.editorTarget;
      if (!t || !b) return false;
      const sameKey = !!(t.key && b.key && t.key === b.key);
      const sameRange = !sameKey && t.date === b.date && t.startMin === b.startMin && t.endMin === b.endMin;
      return sameKey || sameRange;
    },
    /** 打开编辑器：浮层贴在触发块旁边，而不是整页居中弹窗 */
    openSegment(b, ev) {
      if (!b || b.type !== 'activity') return;
      this.selectedPlan = null;
      // 优先用整张卡片/整个色块作为锚点：贴着「这一块」弹出，而不是贴着那个小按钮
      const el = ev && ev.currentTarget
        ? (ev.currentTarget.closest('.tl-card, .cal-block') || ev.currentTarget)
        : null;
      const rect = (ev && ev._rect) || (el ? el.getBoundingClientRect() : null);
      this.editorAnchor = rect
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }
        : null;
      // 记住触发元素：再点同一张卡时，编辑器的「点外部关闭」要放过它
      this.editorAnchorEl = el || null;
      // 删除按钮始终可见（红色高亮），记录层的段点下去会解释为什么不能删，
      // 比「按钮凭空消失」更容易理解，也不破坏记录层只读约束。
      this.editorDeletable = !b.isNew;
      this.editorTarget = { ...b, date: b.date || this.selectedDate };
      this.editorForm = {
        key: b.key || `${b.date || this.selectedDate}-${b.startMin}`,
        range: `${this.clock(b.startMin)} – ${this.clock(b.endMin)}`,
        startTime: this.clock(b.startMin),
        durationMin: Math.max(15, snapToStep(b.endMin - b.startMin)),
        // 保留原应用名：写死「手工标注」会让这段时间在应用统计里凭空多出一个应用
        app: b.app || '手工标注',
        category: b.category || '其他',
        project: b.project || '',
        note: b.isNew ? '' : this.entryRemark(b)
      };
      this.editorOpen = true;
      this.noteHints = [];
    },
    closeSegment() {
      this.editorOpen = false;
      this.editorTarget = null;
      this.editorAnchorEl = null;
      this.noteHints = [];
    },
    /**
     * 保存 = 写一条人工标注覆盖这段（优先级最高）。
     * 勾了「当天全部」时，把当天该应用的所有时段逐段覆盖成同一个分类。
     */
    async saveSegment(payload) {
      if (this.editSaving) return;
      this.editSaving = true;
      try {
        const b = this.editorTarget || {};
        // 块属于哪一天就用哪一天：日历会同时显示好几天，不能用「当前选中日期」
        const date = b.date || this.selectedDate;
        const toIso = (min) => {
          const d = new Date(`${date}T00:00:00`);
          d.setMinutes(min);
          return d.toISOString();
        };
        let ranges = [];
        if (b.startMin !== undefined && b.manual && !b.isNew) {
          ranges = [{ start: toIso(b.startMin), end: toIso(b.endMin) }];
        }
        const record = {
          date,
          startTime: payload.startTime,
          durationMin: payload.durationMin,
          app: payload.app,
          title: payload.note,
          category: payload.category,
          project: payload.project || ''
        };

        // 当天同应用全部同步：逐段写覆盖标注，不去改记录层的原始采样
        if (payload.applyToAllDay && payload.app) {
          const spans = this.appSpansOfDay(date, payload.app);
          if (!spans.length) {
            this.$emit('manual-error', `当天没有找到「${payload.app}」的其它时段`);
            return;
          }
          const res = await ipc.invoke('recategorize-app-for-day', {
            date,
            app: payload.app,
            category: payload.category,
            note: payload.note,
            spans: spans.map(s => ({ startMin: s.startMin, durationMin: s.durationMin }))
          });
          if (!res || !res.ok) {
            this.$emit('manual-error', (res && res.error) || '同步失败');
            return;
          }
          this.$emit('manual-success',
            `已把当天「${payload.app}」的 ${spans.length} 段改成「${payload.category}」`);
          this.closeSegment();
          await this.refreshAfterWrite();
          return;
        }

        const res = ranges.length
          ? await ipc.invoke('replace-display-ranges', { ranges, record })
          : await ipc.invoke('add-manual-record', record);
        if (!res || !res.ok) {
          this.$emit('manual-error', (res && res.error) || '保存失败');
          return;
        }
        const [hour, minute] = String(payload.startTime || '00:00').split(':').map(Number);
        const crossesDay = (hour || 0) * 60 + (minute || 0) + Number(payload.durationMin || 0) > 1440;
        this.$emit('manual-success', crossesDay
          ? `已保存跨日记录：${date} 至 ${this.nextDate(date)}；凌晨部分在次日日历显示`
          : '记录已保存');
        this.closeSegment();
        await this.refreshAfterWrite();
      } finally {
        this.editSaving = false;
      }
    },
    /**
     * 当天某个应用占用的所有时段（15 分钟格口径，按连续段合并）。
     * 时间轴视图用 report.slots；日历视图里 report 只是当前选中日，
     * 所以改用日历自己的 blocks（它带 date，能定位到具体那一天）。
     */
    appSpansOfDay(date, app) {
      const spans = [];
      let cur = null;
      const push = (startMin, endMin) => {
        if (!cur) cur = { startMin, endMin };
        else cur.endMin = endMin;
      };
      const flush = () => { if (cur) { spans.push(cur); cur = null; } };

      const inCalendar = this.mode === 'calendar';
      const day = inCalendar ? this.calDays.find(d => d.date === date) : null;
      const items = day
        ? day.blocks.map(b => ({ startMin: b.startMin, endMin: b.endMin, app: b.app }))
        : ((this.report && this.report.slots) || [])
          .filter(s => s.filledMin > 0)
          .map(s => ({ startMin: s.startMin, endMin: s.startMin + 15, app: s.app }));

      // 按时间排序后再合并连续段，否则同一应用的多个区间会连成一大段
      const owned = items
        .filter(x => x.app === app)
        .sort((a, b) => a.startMin - b.startMin);
      for (const x of owned) {
        if (cur && x.startMin !== cur.endMin) flush();
        push(x.startMin, x.endMin);
      }
      flush();

      return spans
        .map(s => ({ startMin: s.startMin, endMin: s.endMin, durationMin: s.endMin - s.startMin }))
        .filter(s => s.durationMin >= 15);
    },
    /**
     * 当天这个应用一共占了几格。
     * 用格子数而不是段数：一段 2 小时的连续占用也算多格，
     * 但「当天全部同步」只有在它散落在多处时才值得提供。
     */
    appSlotCountOfDay(app) {
      const slots = (this.report && this.report.slots) || [];
      return slots.filter(s => s.app === app && s.filledMin > 0).length;
    },
    /**
     * 备注候选：随输入实时检索历史用过的说法。
     * 关键词为空时返回「当前应用 + 当前分类」的常用说法，
     * 输入关键词后（如一个人名）转为跨应用检索。
     */
    /** 补记面板的备注候选：随输入实时检索历史用过的说法 */
    async onManualNoteInput(keyword) {
      this._manualHintSeq = (this._manualHintSeq || 0) + 1;
      const seq = this._manualHintSeq;
      try {
        const res = await ipc.invoke('find-note-hints', { keyword: String(keyword || '').trim() });
        if (!res || !res.ok) return;
        if (seq !== this._manualHintSeq) return;
        this.manualHints = (res.hints || []).slice(0, 6);
      } catch (_) { /* 检索失败不影响手动输入 */ }
    },
    async onNoteInput(keyword) {
      const app = (this.editorForm && this.editorForm.app) || '';
      const category = (this.editorForm && this.editorForm.category) || '';
      const src = this.noteHintSource;
      // 应用或分类变了要重新检索，不能沿用上一次的结果
      if (src.app !== app || src.category !== category) {
        src.app = app;
        src.category = category;
        this.noteHints = [];
      }
      const kw = String(keyword || '').trim();
      // 用请求序号判断新旧，而不是比对输入框内容：
      // 打开编辑器时备注已预填了窗口标题，与传入的空关键词并不相等。
      this._hintSeq = (this._hintSeq || 0) + 1;
      const seq = this._hintSeq;
      if (!kw) { this.noteHints = []; return; }
      try {
        const res = await ipc.invoke('find-note-hints', {
          keyword: kw,
          app: kw ? '' : app,
          category: kw ? '' : category
        });
        if (!res || !res.ok) return;
        if (seq !== this._hintSeq) return;   // 已有更新的请求，丢弃这次结果
        this.noteHints = (res.hints || []).slice(0, 6);
      } catch (_) { /* 检索失败不影响手动输入 */ }
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
        note: this.entryRemark(b),
        category: b.category,
        project: b.project || '',
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
      const trackRect = track.getBoundingClientRect();
      const grabY = e.clientY;
      const baseDur = Math.max(15, snapToStep(b.endMin - b.startMin));
      let newDur = baseDur;
      let moved = false;
      this.closeCtx();

      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientY - grabY) < 3) return;
        moved = true;
        const hovered = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cal-track');
        const nextDay = this.nextDate(date);
        const minute = hovered?.dataset.date === nextDay
          ? 1440 + this.minuteAt(hovered, ev.clientY)
          : Math.round(((ev.clientY - trackRect.top) / 96 * 60) / 15) * 15;
        newDur = Math.max(15, Math.min(1440, snapToStep(minute - b.startMin)));
        this.dragState = { block: b, moved: true };
        const end = b.startMin + newDur;
        this.ghost = { ...this.ghostOf(date, b.startMin, Math.min(1440, end), false),
          totalEndMin: end, nextDate: end > 1440 ? nextDay : '',
          nextHeight: Math.max(12, (end - 1440) / 60 * 96), lane: 'fact' };
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
      const res = await ipc.invoke('replace-display-ranges', { ranges, record: {
        date,
        startTime: this.clock(startMin),
        durationMin,
        app: '手工标注',
        title: this.entryRemark(b),
        category: b.category,
        project: b.project || ''
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
      await ipc.invoke('add-manual-record', {
        date,
        startTime: this.clock(Math.min(1425, startMin)),
        durationMin: c.durationMin,
        app: '手工标注',
        title: c.note || '',
        category: c.category,
        project: c.project || ''
      });
      await this.refreshAfterWrite();
    },

    minOfDay(ts) {
      const d = new Date(ts);
      return d.getHours() * 60 + d.getMinutes();
    },
    clock(min) {
      const m = Math.max(0, Math.min(2880, Math.round(min)));
      return `${this.pad(Math.floor(m / 60))}:${this.pad(m % 60)}`;
    },
    nextDate(date) {
      const d = new Date(`${date}T00:00:00`);
      d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
    },
    setMode(id) {
      if (!this.viewOptions.some(o => o.id === id)) return;
      this.mode = id;
      // 切视图时收掉所有临时浮层：拖拽预览、右键菜单、编辑器、补记面板
      // 都不该跟着飘到下一个视图上（拖拽监听也必须在这里解绑）
      this.endDrag();
      this.ctxMenu = null;
      this.selectedPlan = null;
      this.editorOpen = false;
      this.pendingPlanMove = null;
      this.manualOpen = false;
      this.closePlanEditor();
      if (id === 'record') {
        this.rawQuery = '';
        this.rawLimit = 300;
      }
    },
    iconOf(cat) {
      return CAT_ICONS[cat] || 'activity';
    },
    colorOf(name) {
      const metaColor = this.categoryMeta[name]?.color;
      if (metaColor && /^#[0-9a-fA-F]{6}$/.test(metaColor)) return metaColor;
      const custom = this.customCategories.find(c => (c.key || c.name) === name);
      if (custom && /^#[0-9a-fA-F]{6}$/.test(custom.color)) return custom.color;
      return colorForCategory(this.theme, name);
    },
    categoryLabel(name) {
      return this.categoryMeta[name]?.name || this.customCategories.find(c => (c.key || c.name) === name)?.name || name;
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
      const gap = b.endMin - b.startMin <= 15 ? 2 : 4;
      return {
        top: `${b.startMin / 60 * 96}px`,
        height: `${Math.max(12, (b.endMin - b.startMin) / 60 * 96 - gap)}px`,
        '--cat': this.colorOf(cat),
        background: this.softColor(cat, this.theme === 'light' ? 0.11 : 0.16),
        color: 'var(--text-primary)'
      };
    },
    calPlanBlockStyle(item) {
      const duration = item.endMin - item.startMin;
      const lanes = Math.max(1, item.layoutLanes || 1);
      const lane = item.layoutLane || 0;
      const laneWidth = (this.calendarLayers === 'both' ? 40 : 100) / lanes;
      return {
        top: `${item.startMin / 60 * 96}px`,
        height: `${Math.max(12, duration / 60 * 96 - (duration <= 15 ? 2 : 4))}px`,
        left: `calc(${lane * laneWidth}% + 2px)`,
        right: `calc(${100 - (lane + 1) * laneWidth}% + 2px)`,
        '--plan-color': this.colorOf(item.category || '其他'),
        background: this.softColor(item.category || '其他', this.theme === 'light' ? 0.07 : 0.1)
      };
    },
    cardBg(cat) {
      return this.softColor(cat, 0.07);
    },
    noteOf(b) {
      if (b.titles && b.titles.length) return b.titles.join(' · ');
      return this.categoryLabel(b.category || '—');
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
    toggleManual(ev) {
      if (this.editorOpen && this.editorTarget?.isNew) { this.closeSegment(); return; }
      this.closePlanEditor();
      const now = new Date();
      const startMin = this.selectedDate === this.todayStr
        ? Math.min(1425, Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15)
        : 540;
      this.openSegment(this.newManualBlock(this.selectedDate, startMin, 30), ev);
    },
    newManualBlock(date, startMin, durationMin) {
      return { type: 'activity', key: `new-${date}-${startMin}`, date, isNew: true,
        startMin, endMin: startMin + durationMin, durationMin, durationMs: durationMin * 60000,
        app: '手工标注', category: '其他', project: '', titles: [], manual: true, focusId: null };
    },
    /** 打开计划编辑器；不传 item 即新建，date/startMin 用作预填 */
    openPlanEditor(item = null, date = null, startMin = null, durationMin = null) {
      this.manualOpen = false;
      this.planDraft = item
        ? { ...item }
        : {
            date: date || this.selectedDate,
            startMin: startMin === null ? Math.floor(this.nowMin / 15) * 15 : startMin,
            durationMin: durationMin || 30,
            label: '',
            category: '工作',
            // 沿用上次用过的重复规则，连续排同类计划不用每次重选
            repeat: this.lastPlanRepeat || 'none'
          };
      this.planOpen = true;
    },
    openPlanEditorRange(date, startMin, durationMin, item = null) {
      this.openPlanEditor(item, date, startMin, durationMin);
    },
    closePlanEditor() {
      this.planOpen = false;
      this.planDraft = {};
    },
    editPlanFromCalendar(item) {
      const original = this.editablePlan(item);
      this.openPlanEditorRange(original.date || this.selectedDate, original.startMin, original.durationMin, original);
    },
    editablePlan(item) {
      if (item.source !== 'carryover-plan') return { ...item };
      return { ...item, source: 'local-plan', date: item.originDate,
        startMin: item.originStartMin, durationMin: item.originDurationMin,
        endMin: Math.min(1440, item.originStartMin + item.originDurationMin),
        fullEndMin: item.originStartMin + item.originDurationMin };
    },
    proposePlanMove(draft) {
      const payload = { localId: draft.localId, date: draft.date, startMin: draft.startMin,
        durationMin: draft.durationMin, label: draft.label, category: draft.category,
        project: draft.project || '', repeat: draft.repeat || 'none',
        repeatEnd: draft.repeatEnd || '', occurrenceDate: draft.occurrenceDate || draft.date };
      if (payload.repeat !== 'none') this.pendingPlanMove = payload;
      else this.savePlan(payload);
    },
    async applyPendingPlanMove(scope) {
      const payload = this.pendingPlanMove;
      this.pendingPlanMove = null;
      if (payload) await this.savePlan({ ...payload, scope });
    },
    async savePlan(payload) {
      if (this.savingPlan) return;
      this.savingPlan = true;
      try {
        const res = await ipc.invoke('save-local-plan', payload);
        if (!res?.ok) {
          this.$emit('manual-error', res?.error || '保存计划失败');
          return;
        }
        this.lastPlanRepeat = payload.repeat || 'none';
        this.$emit('manual-success', Number(payload.startMin || 0) + Number(payload.durationMin || 0) > 1440
          ? `跨日计划已保存；凌晨部分在 ${this.nextDate(payload.date)} 的日历显示`
          : (payload.localId ? '计划已更新' : '计划已添加'));
        this.closePlanEditor();
        await this.refreshAfterWrite();
      } catch (error) {
        this.$emit('manual-error', '保存计划失败: ' + (error?.message || error));
      } finally {
        this.savingPlan = false;
      }
    },
    async removeLocalPlan(item) {
      if (!item?.localId) return;
      const repeating = item.repeat && item.repeat !== 'none';
      const text = repeating
        ? `删除整个重复计划「${item.label}」？\n之后所有日期都不会再出现；已经生成的事实不受影响。`
        : `删除计划「${item.label}」？已经生成的事实不会被删除。`;
      if (!window.confirm(text)) return;
      try {
        const res = await ipc.invoke('delete-local-plan', { localId: item.localId });
        if (!res?.ok) {
          this.$emit('manual-error', res?.error || '删除计划失败');
          return;
        }
        this.closePlanEditor();
        await this.refreshAfterWrite();
      } catch (error) {
        this.$emit('manual-error', '删除计划失败: ' + (error?.message || error));
      }
    },
    planSourceLabel(item) {
      if (item?.source === 'carryover-plan') return '前一天计划的续段';
      return item?.source === 'local-plan' ? '本地计划' : '外部计划（只读）';
    },
    planEvidence(item) {
      const start = Number(item.startMin) || 0;
      const end = Number(item.endMin) || start + Number(item.durationMin || 0);
      return (this.report.activityThreads || []).some(thread => {
        const tStart = Number(thread.startMin) || 0;
        const tEnd = tStart + (Number(thread.durationMs) || 0) / 60000;
        return Math.max(0, Math.min(end, tEnd) - Math.max(start, tStart)) >= 5;
      });
    },
    async convertPlan(item, mode, date) {
      if (!item || this.convertingPlanKey) return;
      this.convertingPlanKey = item.planKey || item.id;
      try {
        const res = await ipc.invoke('convert-plan-to-fact', {
          // 日历可能显示多天，按计划自己所属的日期转换，而不是当前选中日
          date: date || item.date || this.selectedDate,
          plan: item,
          mode
        });
        if (!res?.ok) {
          this.$emit('manual-error', res?.error || '生成事实失败');
          return;
        }
        this.$emit('manual-success', mode === 'screen' ? '已用屏幕活动生成事实' : '计划已转为事实');
        await this.refreshAfterWrite();
        return true;
      } catch (error) {
        this.$emit('manual-error', '生成事实失败: ' + (error?.message || error));
      } finally {
        this.convertingPlanKey = '';
      }
    },
    addQuickCategory(item) {
      const name = String(item?.name || '').trim();
      if (!name || this.categories.includes(name) || Object.values(this.categoryLabels).includes(name)) {
        this.$emit('manual-error', '分类名称不能为空或重复');
        return false;
      }
      this.$emit('add-category', { name, color: item.color || '#6f9fe8', group: '其他' });
      return true;
    },
    createManualCategory() {
      const name = this.newManualCategory.trim();
      if (!this.addQuickCategory({ name, color: this.newManualCategoryColor })) return;
      this.manualCategory = name;
      this.newManualCategory = '';
      this.addingManualCategory = false;
    },
    createCategoryFromEditor(item) {
      this.addQuickCategory(item);
    },
    /** 点空闲块的 + ：把该空白段的起止时间直接带进补记表单 */
    openManualFor(b, ev) {
      if (this.editorOpen) { this.closeSegment(); return; }
      const duration = Math.min(this.mode === 'calendar' ? 1440 : 300,
        Math.max(15, snapToStep(b.durationMin || 15)));
      this.openSegment(this.newManualBlock(this.selectedDate, b.startMin, duration), ev);
    },
    async submitManual() {
      const payload = {
        date: this.selectedDate,
        startTime: this.manualTime,
        durationMin: this.manualDuration,
        app: '手工标注',
        title: this.manualTitle,
        category: this.manualCategory
      };
      this.savingManual = true;
      try {
        const res = await ipc.invoke('add-manual-record', payload);
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
.record-link { color: var(--text-tertiary); font-size: var(--fs-11); text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }
.record-link:hover { color: var(--accent); }
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
.manual-new-category { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.manual-new-category input[type="text"] { flex: 1; min-width: 100px; }
.manual-new-category input[type="color"] { width: 38px; padding: 2px; }
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
/* 正在编辑的卡片：给出明确反馈，让人知道「再点一下会关掉」 */
.tl-card.is-editing {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
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
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  border: 1px dashed var(--border-subtle);
  border-left: 1px dashed var(--border-subtle);
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
.gap-label { flex: 1; font-size: var(--fs-11); font-weight: var(--fw-medium); color: var(--text-tertiary); }
.tl-card.is-gap.is-short { border-color: transparent; padding-block: 2px; opacity: .72; }
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
.cal-workspace {
  /* 计划侧栏已移除，日历独占整行 */
  display: block;
}

.cal-plan-sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: calc(100vh - 250px);
  padding: var(--sp-3);
  overflow: auto;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.cal-plan-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.cal-plan-head > div { display: flex; flex-direction: column; }
.cal-plan-head strong { color: var(--text-primary); font-size: var(--fs-12); }
.cal-plan-head small, .cal-plan-tip { color: var(--text-tertiary); font-size: var(--fs-10); }
.cal-plan-tip { margin: 0; line-height: 1.45; }
.plan-editor.compact { margin-top: 0; padding: var(--sp-2); }
.plan-editor.compact .manual-fields { display: grid; grid-template-columns: 1fr 64px; }
.compact-categories { max-height: 92px; overflow: auto; }
.compact-categories .manual-category { padding: 3px 7px; font-size: 10px; }
.compact-plan-actions { display: flex; justify-content: flex-end; gap: 4px; }
.danger-text { margin-right: auto; color: var(--danger) !important; }
.cal-plan-pool { display: grid; gap: 5px; }
.cal-plan-item {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 6px;
  border-left: 3px solid var(--plan-color);
  border-radius: var(--r-xs);
  background: color-mix(in srgb, var(--plan-color) 8%, var(--bg-surface));
  cursor: grab;
}
.cal-plan-item:active { cursor: grabbing; }
.cal-plan-item.done { opacity: .58; }
/* 滴答计划只读：灰掉、光标改 copy，点击只生成本地副本 */
.cal-plan-item.is-readonly {
  opacity: .5;
  cursor: copy;
  background: color-mix(in srgb, var(--plan-color) 4%, var(--bg-inset));
}
.cal-plan-item.is-readonly .cal-plan-item-copy strong { color: var(--text-secondary); }
.cal-plan-item-time { color: var(--plan-color); font: 9px var(--font-mono); }
.cal-plan-item-copy { display: flex; min-width: 0; flex-direction: column; }
.cal-plan-item-copy strong { overflow: hidden; color: var(--text-primary); text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-10); }
.cal-plan-item-copy small { color: var(--text-tertiary); font-size: 9px; }
.cal-plan-grip { color: var(--text-tertiary); letter-spacing: -3px; }
.compact-empty { padding: var(--sp-2); }

.cal-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.cal-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.cal-head em { font-style: normal; opacity: 0.7; }
.cal-span { margin-left: auto; }
.cal-control { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.cal-control select { width: auto; height: 27px; padding: 3px 24px 3px 8px; font-size: var(--fs-11); }
.cal-drag-tip { font-size: var(--fs-10); }

.cal-create-mode { display: inline-flex; padding: 2px; border: 1px solid var(--border-subtle); border-radius: var(--r-full); background: var(--bg-inset); }
.cal-create-mode button { border: 0; padding: 3px 7px; border-radius: var(--r-full); background: transparent; color: var(--text-tertiary); font-size: 9px; }
.cal-create-mode button.active { background: var(--bg-surface); color: var(--accent); box-shadow: var(--shadow-sm); }

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
  max-height: max(240px, calc(100vh - 286px));
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
.cal-grid.has-lane-heads .cal-ruler { margin-top: 48px; }

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
.cal-day-link { font-size: 9px; color: var(--accent); white-space: nowrap; }
.cal-lane-heads { display: grid; grid-template-columns: 40% 60%; height: 18px; align-items: center; color: var(--text-tertiary); font-size: var(--fs-10); text-align: center; }
.cal-lane-heads span:first-child { color: var(--accent); }

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
    transparent 1px var(--hour-h)
  );
  cursor: crosshair;
  overflow: hidden;
}
.cal-track.has-both-lanes::after { content: ''; position: absolute; top: 0; bottom: 0; left: 40%; border-left: 1px dashed var(--border-default); pointer-events: none; }
.cal-track.has-both-lanes .cal-plan-block { right: 60%; }
.cal-track.has-both-lanes .cal-block { left: calc(40% + 4px); }

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
  z-index: 2;
}

.cal-plan-block {
  position: absolute;
  left: 2px;
  right: 2px;
  /* 计划与实际分列，整块可点击或拖动。 */
  z-index: 3;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 10px;
  padding: 2px 5px 2px 19px;
  overflow: hidden;
  border: 1px dashed var(--plan-color);
  border-radius: var(--r-xs);
  color: var(--plan-color);
  opacity: .82;
}
.cal-plan-block:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* 左侧色条提示整块可以拖动 */
.cal-plan-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 13px;
  border-radius: 3px 0 0 3px;
  background: color-mix(in srgb, var(--plan-color) 50%, transparent);
  pointer-events: auto;
  cursor: grab;
}
.cal-plan-handle:active { cursor: grabbing; }
.cal-plan-block.is-local .cal-plan-handle { background: var(--plan-color); }
.cal-plan-block.is-readonly .cal-plan-handle {
  background: repeating-linear-gradient(180deg, var(--plan-color) 0 3px, transparent 3px 6px);
  opacity: .6;
}
.cal-plan-block.is-local { border-style: solid; }
.cal-plan-block.flows-next {
  border-bottom: 3px solid var(--plan-color);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.cal-plan-block.is-continuation {
  border-top: 3px solid var(--plan-color);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  background-image: linear-gradient(to bottom, color-mix(in srgb, var(--plan-color) 16%, transparent), transparent 30px);
}
.cal-plan-block.is-continuation .cal-plan-type { color: var(--text-primary); }
.cal-plan-block.is-readonly { opacity: .7; }
.cal-plan-block.is-dim { opacity: .3; }
.cal-plan-type { font-size: 10px; font-weight: var(--fw-semibold); }
.cal-plan-link { font-size: 9px; line-height: 1.25; color: var(--text-secondary); }
.cal-plan-label { font-size: 9px; line-height: 1.25; overflow-wrap: anywhere; }
.cal-plan-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; opacity: .8; }
.cal-plan-block small { font: 8px var(--font-mono); opacity: .8; }
.cal-plan-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; cursor: ns-resize; }

.cal-block:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
  /* 不再抬 z-index：抬上去会盖住计划块左侧把手，导致把手点不到 */
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
  padding: 2px 6px;
  gap: 1px;
  border-radius: var(--r-xs);
}

/* 块内时间范围：大块在标题下方一行，短块贴在右侧 */
.cal-block-range {
  flex: none;
  font-size: var(--fs-10);
  line-height: 1.3;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 人工标注过的段用虚线描边区分，比整块斜纹安静 */
.cal-block.is-manual { border-style: dashed; border-left-style: solid; }

.cal-block-title {
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  line-height: 1.4;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.cal-block-note {
  font-size: var(--fs-11);
  line-height: 1.45;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
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
.cal-track.has-both-lanes .cal-ghost.lane-plan { right: 60%; }
.cal-track.has-both-lanes .cal-ghost.lane-fact { left: 40%; }

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

@media (max-width: 620px) {
  .cal-workspace { grid-template-columns: 142px minmax(280px, 1fr); }
  .cal-plan-tip { display: none; }
}

/* 右键菜单 */
.plan-compare-mask { position: fixed; inset: 0; z-index: 2050; display: flex; align-items: flex-end; justify-content: flex-end; padding: 18px; pointer-events: none; }
.plan-compare { width: min(430px, 100%); max-height: min(600px, 70vh); overflow: auto; padding: 16px; pointer-events: auto; border: 1px solid var(--border-default); border-radius: var(--r-lg); background: var(--bg-elevated); box-shadow: var(--shadow-lg); }
.plan-move-mask { position: fixed; inset: 0; z-index: 2250; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, .3); }
.plan-move-prompt { width: min(360px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--border-default); border-radius: var(--r-lg); background: var(--bg-elevated); box-shadow: var(--shadow-lg); }
.plan-move-prompt strong { color: var(--text-primary); font-size: var(--fs-14); }
.plan-move-prompt span { color: var(--text-secondary); font-size: var(--fs-11); }
.plan-move-prompt > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.pc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.pc-head small { color: var(--text-tertiary); font-size: var(--fs-11); }
.pc-head h3 { margin: 5px 0 0; font-size: var(--fs-16); }
.pc-head button { padding: 0 5px; color: var(--text-tertiary); font-size: 24px; }
.pc-status { margin: 15px 0; padding: 9px 11px; border-radius: var(--r-sm); background: var(--accent-soft); color: var(--text-primary); font-size: var(--fs-12); }
.pc-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 12px; }
.pc-columns > div { min-width: 0; padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--r-sm); background: var(--bg-surface); }
.pc-columns strong { font-size: var(--fs-12); }
.pc-columns p, .pc-note { margin: 8px 0 0; color: var(--text-secondary); font-size: var(--fs-12); line-height: 1.5; overflow-wrap: anywhere; }
.pc-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.pc-spacer { flex: 1; }
@media (max-width: 620px) { .pc-columns { grid-template-columns: 1fr; } .pc-actions .btn { flex: 1; } }
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

.plan-reference { margin: var(--sp-3) 0; padding: var(--sp-3); border: 1px dashed var(--border-strong); border-radius: var(--r-md); background: var(--bg-inset); }
.plan-reference-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); color: var(--text-secondary); font-size: var(--fs-11); font-weight: var(--fw-semibold); }
.plan-reference-head > div { display: flex; align-items: baseline; gap: var(--sp-2); }
.plan-reference-head em { color: var(--text-tertiary); font-size: var(--fs-10); font-style: normal; font-weight: var(--fw-normal); }
.plan-editor { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--accent-border); border-radius: var(--r-sm); background: var(--bg-surface); }
.plan-reference-list { display: grid; gap: 6px; margin-top: var(--sp-2); }
.plan-reference-item { display: grid; grid-template-columns: 52px minmax(120px, 1fr) auto auto; align-items: center; gap: var(--sp-2); min-width: 0; padding: 8px 9px; border-left: 3px solid var(--plan-color); border-radius: var(--r-sm); color: var(--text-secondary); background: color-mix(in srgb, var(--plan-color) 8%, var(--bg-surface)); font-size: var(--fs-10); }
.plan-range { display: flex; flex-direction: column; font: 9px var(--font-mono); }
.plan-range b { color: var(--plan-color); }
.plan-range small { color: var(--text-tertiary); }
.plan-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.plan-copy strong { overflow: hidden; color: var(--text-primary); text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-11); }
.plan-copy small { color: var(--text-tertiary); }
.plan-actions, .plan-local-actions { display: inline-flex; align-items: center; gap: 5px; }
.plan-local-actions button { border: 0; padding: 2px 3px; background: transparent; color: var(--text-tertiary); font-size: 10px; cursor: pointer; }
.plan-local-actions button:hover { color: var(--text-primary); }
.plan-fact { padding: 3px 7px; border-radius: 999px; background: var(--success-soft); color: var(--success); white-space: nowrap; }
.plan-empty { margin-top: var(--sp-2); padding: var(--sp-3); color: var(--text-tertiary); text-align: center; font-size: var(--fs-11); }
@media (max-width: 760px) {
  .plan-reference-item { grid-template-columns: 44px minmax(0, 1fr); }
  .plan-actions, .plan-local-actions, .plan-fact { grid-column: 2; justify-self: start; }
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

/* ---------- 补记备注候选 ---------- */
.manual-hints {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.manual-hints-label {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  flex: none;
}
.manual-hint-chip {
  max-width: 160px;
  padding: 3px 8px;
  border-radius: var(--r-full);
  font-size: var(--fs-11);
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.manual-hint-chip:hover {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
}
</style>
