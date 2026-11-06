<template>
  <transition name="focus-fade">
    <div v-if="state && state.active" class="focus" :style="{ '--tint': state.tint }">
      <div class="focus-bg" :class="{ break: isBreak }">
        <span class="glow" :class="{ paused: state.paused, open: isOpen }"></span>
      </div>

      <div class="focus-top">
        <span class="mode-chip">
          <span class="dot"></span>
          {{ state.modeName }}
        </span>
        <span v-if="state.totalRounds > 0" class="round-dots">
          <span
            v-for="n in state.totalRounds"
            :key="n"
            class="round-dot"
            :class="{ done: n < state.round, current: n === state.round }"
          ></span>
        </span>
      </div>

      <button class="focus-exit" title="结束（Esc）" @click="$emit('end')">
        <Icon name="x" :size="15" />
      </button>

      <div class="focus-inner">
        <p class="focus-phase" :class="{ break: isBreak }">{{ state.phaseLabel }}</p>

        <div class="focus-clock" :class="{ paused: state.paused }">
          {{ state.paused ? '已暂停' : state.clock }}
        </div>

        <p v-if="isBreak" class="focus-hint">该休息了，站起来走走，别碰屏幕</p>
        <h1 v-else class="focus-task">{{ state.focusText || '当下这一件事' }}</h1>

        <div v-if="!isOpen" class="focus-progress">
          <span class="progress-fill" :style="{ width: (state.progress * 100).toFixed(1) + '%' }"></span>
        </div>

        <div class="focus-note">
          <input
            v-show="noteVisible"
            ref="noteInput"
            v-model="noteText"
            class="note-input"
            placeholder="冒出的杂念，按 Enter 记下"
            @focus="noteFocused = true"
            @blur="noteFocused = false"
            @keydown.enter="submitNote"
            @keydown.escape="closeNote"
          >
          <button v-if="!noteVisible" class="note-trigger" @click="openNote">
            <Icon name="plus" :size="13" />
            记一笔杂念
          </button>
        </div>

        <p v-if="state.notesCount > 0" class="note-count">已记录 {{ state.notesCount }} 条</p>

        <div class="focus-actions">
          <button class="act-btn" @click="$emit('toggle-pause')">
            <Icon :name="state.paused ? 'play' : 'pause'" :size="14" />
            {{ state.paused ? '继续' : '暂停' }}
          </button>
          <button v-if="!isOpen" class="act-btn" @click="$emit('skip')">
            <Icon name="chevronRight" :size="14" />
            {{ isBreak ? '提前结束休息' : '跳过本轮' }}
          </button>
          <button class="act-btn danger" @click="$emit('end')">结束</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import Icon from './Icon.vue';

export default {
  name: 'FocusOverlay',
  components: { Icon },
  props: {
    state: { type: Object, default: () => ({ active: false }) }
  },
  emits: ['end', 'toggle-pause', 'skip', 'add-note'],
  data() {
    return { noteVisible: false, noteText: '', noteFocused: false };
  },
  computed: {
    isBreak() {
      return this.state && this.state.phase === 'break';
    },
    isOpen() {
      return this.state && this.state.phase === 'open';
    }
  },
  watch: {
    'state.active'(val) {
      if (!val) {
        this.noteVisible = false;
        this.noteText = '';
      }
    }
  },
  mounted() {
    document.addEventListener('keydown', this.onKey);
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
  },
  methods: {
    onKey(e) {
      if (!this.state || !this.state.active) return;
      if (e.key === 'Escape' && !this.noteVisible) {
        this.$emit('end');
      } else if (e.code === 'Space' && !this.noteVisible) {
        e.preventDefault();
        this.$emit('toggle-pause');
      }
    },
    openNote() {
      this.noteVisible = true;
      this.$nextTick(() => {
        if (this.$refs.noteInput) this.$refs.noteInput.focus();
      });
    },
    closeNote() {
      this.noteVisible = false;
      this.noteText = '';
    },
    submitNote() {
      const text = (this.noteText || '').trim();
      if (!text) {
        this.closeNote();
        return;
      }
      this.$emit('add-note', text);
      this.noteText = '';
      this.noteVisible = false;
    }
  }
};
</script>

<style scoped>
.focus {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  -webkit-app-region: no-drag;
}

.focus-bg {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.glow {
  width: 380px;
  height: 380px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--tint) 22%, transparent) 0%, transparent 68%);
  animation: breathe 9s var(--ease) infinite;
}

.glow.open {
  animation-duration: 13s;
}

.glow.paused {
  animation-play-state: paused;
  opacity: 0.4;
}

.focus-bg.break .glow {
  background: radial-gradient(circle, rgba(52, 211, 153, 0.2) 0%, transparent 68%);
}

@keyframes breathe {
  0%, 100% { transform: scale(0.86); opacity: 0.45; }
  50% { transform: scale(1.14); opacity: 1; }
}

.focus-top {
  position: absolute;
  top: var(--sp-4);
  left: var(--sp-5);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px 0 8px;
  border-radius: var(--r-full);
  background: color-mix(in srgb, var(--tint) 16%, transparent);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--tint);
}

.mode-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.round-dots {
  display: inline-flex;
  gap: 5px;
}

.round-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-default);
}

.round-dot.done {
  background: color-mix(in srgb, var(--tint) 60%, transparent);
}

.round-dot.current {
  background: var(--tint);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tint) 20%, transparent);
}

.focus-exit {
  position: absolute;
  top: var(--sp-4);
  right: var(--sp-4);
  width: 32px;
  height: 32px;
  border-radius: var(--r-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.focus-exit:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.focus-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  max-width: 360px;
  text-align: center;
}

.focus-phase {
  margin: 0;
  font-size: var(--fs-10);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--tint);
  font-weight: var(--fw-semibold);
}

.focus-phase.break {
  color: #34d399;
}

.focus-clock {
  font-family: var(--font-mono);
  font-size: 54px;
  font-weight: var(--fw-normal);
  letter-spacing: -0.03em;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.05;
}

.focus-clock.paused {
  font-size: 34px;
  color: var(--text-tertiary);
}

.focus-task {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-14);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
  line-height: var(--lh-snug);
}

.focus-hint {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-12);
  color: var(--success);
}

.focus-progress {
  width: 220px;
  height: 3px;
  margin-top: var(--sp-3);
  border-radius: var(--r-full);
  background: var(--bg-active);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  background: var(--tint);
  transition: width 900ms linear;
}

.focus-note {
  margin-top: var(--sp-4);
  display: flex;
  justify-content: center;
}

.note-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  border: 1px dashed var(--border-default);
  color: var(--text-tertiary);
  font-size: var(--fs-11);
  transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.note-trigger:hover {
  border-color: var(--tint);
  color: var(--tint);
}

.note-input {
  height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  text-align: center;
  font-size: var(--fs-12);
  background: var(--bg-surface);
  border-color: var(--tint);
}

.note-count {
  margin: 2px 0 0;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.focus-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
    border-color var(--dur-1) var(--ease);
}

.act-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.act-btn.danger {
  color: var(--danger);
  border-color: transparent;
  background: var(--danger-soft);
}

.act-btn.danger:hover {
  border-color: var(--danger);
}

.focus-fade-enter-active,
.focus-fade-leave-active {
  transition: opacity var(--dur-3) var(--ease);
}

.focus-fade-enter-from,
.focus-fade-leave-to {
  opacity: 0;
}
</style>
