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
          <span class="seg-range">{{ form.range }}</span>
          <span class="seg-dur">{{ durLabel }}</span>
          <button class="seg-x" title="关闭" @click="$emit('close')">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
            </svg>
          </button>
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
            <div v-if="noteHints.length" class="seg-hints">
              <span class="seg-hints-label">用过：</span>
              <button
                v-for="(h, i) in noteHints"
                :key="i"
                type="button"
                class="seg-hint-chip"
                :title="`${h.text}（用过 ${h.count} 次）`"
                @click="form.note = h.text"
              >{{ h.text }}</button>
            </div>
          </label>
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
          <button class="seg-btn primary" :disabled="saving" @click="submit">
            {{ saving ? '保存中' : '保存' }}
          </button>
        </div>
    </div>
  </transition>
</template>

<script>
const PANEL_WIDTH = 332;
const MARGIN = 12;
const GAP = 8;

export default {
  name: 'SegmentEditor',
  props: {
    open: { type: Boolean, default: false },
    /** 触发元素的位置（getBoundingClientRect 的拷贝），用来把浮层贴在它旁边 */
    anchor: { type: Object, default: null },
    initial: { type: Object, default: () => ({}) },
    categories: { type: Array, default: () => [] },
    categoryLabels: { type: Object, default: () => ({}) },
    deletable: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    /** 历史备注候选：搜索应用名或关键词即可复用以前的说法 */
    noteHints: { type: Array, default: () => [] },
    /** 是否提供「当天同应用全部同步」开关（自动录制的应用才有意义） */
    showApplyAll: { type: Boolean, default: false },
    /** 触发编辑的元素：点它不算「点外部」，用于「再点一次关闭」 */
    anchorEl: { type: Object, default: null }
  },
  emits: ['save', 'delete', 'close', 'add-category'],
  data() {
    return {
      form: { range: '', durationMin: 15, app: '', category: '其他', note: '' },
      pos: { top: '0px', left: '0px' },
      origin: 'top left',
      addingCategory: false,
      newCategoryName: '',
      newCategoryColor: '#6f9fe8',
      applyToAllDay: false
    };
  },
  computed: {
    /** 390 分钟这种数字不好读，超过一小时换成 6 小时 30 分 */
    durLabel() {
      const m = Number(this.form.durationMin) || 0;
      if (m < 60) return `${m} 分钟`;
      const h = Math.floor(m / 60);
      const rest = m % 60;
      return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
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
      this.$emit('save', {
        // 保留原应用名：写死「手工标注」会让这段时间在应用统计里凭空多出一个应用
        app: (this.form.app || '').trim() || '手工标注',
        category: this.form.category,
        note: (this.form.note || '').trim(),
        startTime: this.form.startTime,
        durationMin: this.form.durationMin,
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
