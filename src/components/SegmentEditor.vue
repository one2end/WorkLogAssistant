<template>
  <transition name="seg-pop">
      <div
        v-if="open"
        ref="panel"
        class="seg-pop"
        :style="pos"
        @click.stop
        @pointerdown.stop
      >
        <div class="seg-head">
          <TimeRangePicker :start-time="form.startTime" :duration="Number(form.durationMin) || 15" :max-duration="maxDuration"
            @update:start-time="form.startTime = $event" @update:duration="form.durationMin = $event" />
          <button class="seg-x" title="关闭" @click="$emit('close')">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 吸附预览：保存前把「会存成什么」说清楚，而不是保存后再解释 -->
        <div v-if="snapPreview" class="seg-snap" :class="{ warn: snapPreview.rejected || snapPreview.distorted }">
          <template v-if="snapPreview.rejected">
            <span class="seg-snap-icon" aria-hidden="true">!</span>
            <span>{{ snapPreview.message }}</span>
          </template>
          <template v-else>
            <span class="seg-snap-range">
              <template v-if="snapPreview.distorted && snapPreview.rawEnd">
                {{ form.startTime }}—{{ snapPreview.rawEnd }} →
              </template>
              将保存为 {{ snapPreview.start }}—{{ snapPreview.end }}，共 {{ snapPreview.durationMin }} 分钟
            </span>
            <span v-if="snapPreview.distorted" class="seg-snap-note">
              输入 {{ snapPreview.rawDurationMin }} 分钟，吸附后为 {{ snapPreview.durationMin }} 分钟
            </span>
          </template>
        </div>

        <div class="seg-body">
          <div class="seg-field">
            <span>分类</span>
            <div class="seg-cats">
              <button
                v-for="c in categories"
                :key="c"
                type="button"
                class="seg-cat"
                :class="{ active: form.category === c }"
                @click="form.category = c"
              >{{ categoryLabels[c] || c }}</button>
              <button type="button" class="seg-cat" title="新增分类" @click="addingCategory = !addingCategory">＋</button>
            </div>
            <div v-if="addingCategory" class="seg-new-cat">
              <input v-model="newCategoryName" type="text" maxlength="16" placeholder="分类名称" aria-label="新分类名称">
              <input v-model="newCategoryColor" type="color" aria-label="新分类颜色">
              <button class="seg-btn" :disabled="!newCategoryName.trim()" @click="createCategory">添加</button>
            </div>
          </div>

          <label class="seg-field">
            <span>备注</span>
            <textarea ref="titleInput" v-model="form.note" rows="2" placeholder="这段时间做了什么，可留空" @input="onNoteInput" />
            <div v-if="form.note.trim() && matchingNotes.length" class="seg-hints">
              <span class="seg-hints-label">用过：</span>
              <button
                v-for="(h, i) in matchingNotes"
                :key="i"
                type="button"
                class="seg-hint-chip"
                :title="`${h.text}（用过 ${h.count} 次）`"
                @click="form.note = h.text"
              >{{ h.text }}</button>
            </div>
          </label>
          <div class="seg-field">
            <span>项目 <small>可选 · 用于跨日期关联</small></span>
            <input v-model="form.project" type="text" maxlength="60" placeholder="输入项目名称">
            <div v-if="matchingProjects.length" class="seg-hints"><button v-for="p in matchingProjects" :key="p" type="button" class="seg-hint-chip" @click="form.project = p">{{ p }}</button></div>
          </div>
        </div>

        <div v-if="showApplyAll" class="seg-applyall">
          <label class="switch">
            <input type="checkbox" v-model="applyToAllDay">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
          <span>当天「{{ form.app }}」全部改成「{{ form.category }}」</span>
        </div>

        <div class="seg-foot">
          <button v-if="deletable" class="seg-del" @click="$emit('delete')">删除这一段</button>
          <span class="seg-hint">保存后覆盖展示</span>
          <button class="seg-btn" @click="$emit('close')">取消</button>
          <button class="seg-btn primary"
            :disabled="saving || (snapPreview && snapPreview.rejected)"
            :title="snapPreview && snapPreview.rejected ? snapPreview.message : ''"
            @click="submit">
            {{ saving ? '保存中' : '保存' }}
          </button>
        </div>
    </div>
  </transition>
</template>

<script>
import TimeRangePicker from './TimeRangePicker.vue';
// 与主进程共用同一份吸附规则：预览结果就是落盘结果，不会各算各的
import slotRule from '@slot-rule';
const PANEL_WIDTH = 332;
const MARGIN = 12;
const GAP = 8;

export default {
  name: 'SegmentEditor',
  components: { TimeRangePicker },
  props: {
    open: { type: Boolean, default: false },
    /** 触发元素的位置（getBoundingClientRect 的拷贝），用来把浮层贴在它旁边 */
    anchor: { type: Object, default: null },
    initial: { type: Object, default: () => ({}) },
    categories: { type: Array, default: () => [] },
    categoryLabels: { type: Object, default: () => ({}) },
    deletable: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    maxDuration: { type: Number, default: 1440 },
    /** 历史备注候选：搜索应用名或关键词即可复用以前的说法 */
    noteHints: { type: Array, default: () => [] },
    projectHints: { type: Array, default: () => [] },
    /** 是否提供「当天同应用全部同步」开关（自动录制的应用才有意义） */
    showApplyAll: { type: Boolean, default: false },
    /** 触发编辑的元素：点它不算「点外部」，用于「再点一次关闭」 */
    anchorEl: { type: Object, default: null }
  },
  emits: ['save', 'delete', 'close', 'add-category', 'note-input'],
  data() {
    return {
      form: { range: '', durationMin: 15, app: '', category: '其他', project: '', note: '' },
      pos: { top: '0px', left: '0px' },
      origin: 'top left',
      addingCategory: false,
      newCategoryName: '',
      newCategoryColor: '#6f9fe8',
      applyToAllDay: false
    };
  },
  computed: {
    /**
     * 吸附预览（方案 §5.3 第 1、2、3 条）。
     *
     * 三件事必须在用户点保存之前说清楚：
     *   1. 会存成什么时间（"09:07—10:42 → 将保存为 09:00—10:45，共 105 分钟"）
     *   2. 如果吸附改变了时长，差了多少（"输入 22 分钟 → 将保存为 15 分钟"）
     *   3. 如果不足 15 分钟，直接告诉他不行（而不是偷偷放大成 15 分钟）
     *
     * 之所以放在 computed 而不是让用户点一下「预览」：这三条信息在
     * "点了保存才发现被改了" 时已经太晚——那时记录已经写进去了。
     */
    snapPreview() {
      if (!this.open) return null;
      const dateStr = this.initial && this.initial.date
        ? String(this.initial.date)
        : new Date().toISOString().slice(0, 10);
      const raw = Math.max(1, Math.round(Number(this.form.durationMin) || 15));
      const r = slotRule.snapRange(dateStr, this.form.startTime, raw);
      if (r.rejected) {
        return { rejected: true, reason: r.reason, message: r.message, rawDurationMin: raw };
      }
      // 原始终点：让用户看见 "10:42" 是怎么变成 "10:45" 的
      const startRaw = slotRule.parseHHMM(this.form.startTime);
      return {
        rejected: false,
        start: r.start,
        end: r.end,
        durationMin: r.durationMin,
        rawDurationMin: raw,
        distorted: r.distorted,
        rawEnd: startRaw === null ? null : slotRule.formatHHMM(startRaw + raw)
      };
    },
    matchingNotes() {
      const query = String(this.form.note || '').trim().toLowerCase();
      return query ? this.noteHints.filter(h => String(h.text || '').toLowerCase().includes(query) && h.text !== this.form.note) : [];
    },
    matchingProjects() {
      const query = String(this.form.project || '').trim().toLowerCase();
      return query ? this.projectHints.filter(p => String(p).toLowerCase().includes(query) && p !== this.form.project).slice(0, 6) : [];
    }
  },
  watch: {
    // 已经打开时再点另一个块：必须刷新表单，否则改的是上一段的字段。
    // 注意：initial.key 在 openSegment 里可能不存在，这里同时监听整个 initial。
    'initial.key'(val) {
      if (!this.open || val === undefined) return;
      this.resetToInitial();
    },
    initial() {
      if (!this.open) return;
      this.resetToInitial();
    },
    open(val) {
      if (val) {
        this.resetToInitial();
        this.$nextTick(() => {
          this.place();
          if (this.$refs.titleInput) this.$refs.titleInput.focus();
        });
        this.bindGlobal();
      } else {
        this.unbindGlobal();
      }
    }
  },
  beforeUnmount() {
    this.unbindGlobal();
  },
  methods: {
    resetToInitial() {
      this.form = { ...this.form, ...this.initial };
      // 这里不再把时长夹到 15：夹了就等于在用户看到之前先把「3 分钟」
      // 改写成「15 分钟」，后面的最短时长校验永远收不到原始值。
      // 下限只保留 1，真正的 15 分钟判定交给主进程的 slotRule。
      this.form.durationMin = Math.min(this.maxDuration, Math.max(1, Number(this.form.durationMin) || 15));
      this.applyToAllDay = false;
      this.$nextTick(() => this.place());
    },
    /** 备注输入时给出历史候选：优先匹配当前应用，其次全局 */
    onNoteInput() {
      this.$emit('note-input', this.form.note || '');
    },
    place() {
      const el = this.$refs.panel;
      const h = el ? el.offsetHeight : 250;
      const a = this.anchor || { top: 120, left: MARGIN, width: 0, height: 0, bottom: 120 };

      let top = a.bottom + GAP;
      let origin = 'top';
      if (top + h > window.innerHeight - MARGIN) {
        const above = a.top - h - GAP;
        if (above >= MARGIN) {
          top = above;
          origin = 'bottom';
        } else {
          top = Math.max(MARGIN, window.innerHeight - h - MARGIN);
        }
      }

      let left = a.left;
      if (left + PANEL_WIDTH > window.innerWidth - MARGIN) {
        left = window.innerWidth - PANEL_WIDTH - MARGIN;
      }
      if (left < MARGIN) left = MARGIN;

      // 让动画从靠近触发块的那一侧展开，而不是永远从中心放大
      this.pos = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
    },
    submit() {
      if (this.saving) return;
      // 传原始时长，不在这里夹到 15：吸附与最短时长校验都由主进程的
      // slotRule 统一完成，前端夹一次会让「不足 15 分钟」这条永远触发不到，
      // 也会让预览与落盘算的不是同一个数。
      const rawDurationMin = Math.max(1, Math.round(Number(this.form.durationMin) || 15));
      this.$emit('save', {
        // 保留原应用名：写死「手工标注」会让这段时间在应用统计里凭空多出一个应用
        app: (this.form.app || '').trim() || '手工标注',
        category: this.form.category,
        project: (this.form.project || '').trim(),
        note: (this.form.note || '').trim(),
        startTime: this.form.startTime,
        durationMin: Math.min(this.maxDuration, rawDurationMin),
        applyToAllDay: this.applyToAllDay
      });
    },
    createCategory() {
      const name = this.newCategoryName.trim();
      if (!name || this.categories.includes(name) || Object.values(this.categoryLabels).includes(name)) return;
      this.$emit('add-category', { name, color: this.newCategoryColor });
      this.form.category = name;
      this.addingCategory = false;
      this.newCategoryName = '';
    },
    bindGlobal() {
      this.unbindGlobal();
      this._onDown = (ev) => {
        if (this.$refs.panel && this.$refs.panel.contains(ev.target)) return;
        // 日历空白与时间轴空档由各自点击处理器关闭菜单；这里先关闭会导致同次点击再打开。
        if (ev.target?.closest?.('.cal-track, .tl-card.is-gap')) return;
        // 触发编辑的那个元素（卡片/色块）不算「外部」：
        // 否则再点同一张卡时，pointerdown 先把面板关了，
        // 随后的 click 又把它打开，看起来像「点不掉」。
        if (this.anchorEl && this.anchorEl.contains(ev.target)) return;
        this.$emit('close');
      };
      this._onKey = (ev) => {
        if (ev.key === 'Escape') this.$emit('close');
      };
      this._onResize = () => this.place();
      // 延后一拍，避免触发本次打开的那一下 pointerdown 立刻把面板关掉
      setTimeout(() => document.addEventListener('pointerdown', this._onDown, true), 0);
      document.addEventListener('keydown', this._onKey);
      window.addEventListener('resize', this._onResize);
      window.addEventListener('scroll', this._onResize, true);
    },
    unbindGlobal() {
      if (this._onDown) document.removeEventListener('pointerdown', this._onDown, true);
      if (this._onKey) document.removeEventListener('keydown', this._onKey);
      if (this._onResize) {
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('scroll', this._onResize, true);
      }
      this._onDown = null;
      this._onKey = null;
      this._onResize = null;
    }
  }
};
</script>

<style scoped>
.seg-pop {
  position: fixed;
  z-index: 2000;
  width: 332px;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.14);
  overflow: hidden;
}

.seg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-inset);
}
.seg-head .time-range { flex: 1; min-width: 0; }

/* 吸附预览：默认低调（多数输入本来就对齐），有偏差时才醒目 */
.seg-snap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 14px 7px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-secondary, #6b7280);
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border-subtle);
}
.seg-snap.warn {
  color: #b45309;
  background: rgba(180, 83, 9, 0.08);
}
.seg-snap-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  margin-right: 5px;
  border-radius: 50%;
  background: currentColor;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  vertical-align: 1px;
}
.seg-snap-range { font-variant-numeric: tabular-nums; }
.seg-snap-note { opacity: 0.85; }

.seg-range {
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.seg-dur {
  padding: 1px 6px;
  border-radius: 20px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.seg-x {
  margin-left: auto;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-tertiary);
  background: none;
}

.seg-x:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.seg-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  max-height: min(66vh, 560px);
  overflow-y: auto;
}

.seg-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.seg-field > span {
  font-size: var(--fs-10);
  letter-spacing: 0.02em;
  color: var(--text-tertiary);
}

.seg-field input,
.seg-field textarea {
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--border-default);
  background: var(--bg-inset);
  font-size: var(--fs-12);
  color: var(--text-primary);
  font-family: inherit;
  transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
}

.seg-field input:focus,
.seg-field textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.seg-field textarea {
  resize: vertical;
  min-height: 48px;
  line-height: 1.5;
}

.seg-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.seg-cat {
  padding: 3px 8px;
  border-radius: 20px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  font-size: var(--fs-11);
  color: var(--text-secondary);
  transition: all 120ms var(--ease);
}

.seg-cat:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.seg-cat.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.seg-new-cat { display: flex; align-items: center; gap: 5px; margin-top: 6px; }
.seg-new-cat input[type="text"] { flex: 1; min-width: 80px; }
.seg-new-cat input[type="color"] { width: 34px; padding: 2px; }

.seg-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-inset);
}

.seg-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-10);
  line-height: 1.35;
  color: var(--text-tertiary);
}

.seg-del {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  background: var(--danger-soft);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--danger);
}

.seg-del:hover {
  color: var(--text-inverse);
  background: var(--danger);
  border-color: var(--danger);
}

.seg-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-elevated);
  font-size: var(--fs-11);
  color: var(--text-secondary);
}

.seg-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.seg-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.seg-btn.primary:hover {
  background: var(--accent-hover);
}

.seg-btn.primary:disabled {
  opacity: 0.6;
}

.seg-pop-enter-active,
.seg-pop-leave-active {
  transition: opacity 140ms var(--ease), transform 180ms var(--ease);
}

.seg-pop-enter-from,
.seg-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

/* ---------- 备注候选 ---------- */
.seg-hints {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.seg-hints-label {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  flex: none;
}
.seg-hint-chip {
  max-width: 150px;
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
.seg-hint-chip:hover {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
}

/* ---------- 当天全部同步 ---------- */
.seg-applyall {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
  font-size: var(--fs-12);
  color: var(--text-secondary);
}
.seg-applyall .switch { flex: none; }
</style>
