<template>
  <header class="titlebar">
    <div class="tb-drag">
      <span class="brand">
        <svg class="brand-mark" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.34" fill="url(#wl-grad)" />
          <path
            d="M4.4 12.1H6.3L7.3 11l1.1 2 1.8-4.75L14 15.84l1.6-3.74h4"
            fill="none"
            stroke="#fff"
            stroke-width="1.875"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <defs>
            <linearGradient id="wl-grad" x1="3.3" y1="1.4" x2="20.7" y2="22.7" gradientUnits="userSpaceOnUse">
              <stop stop-color="#7CA3FF" />
              <stop offset="0.48" stop-color="#6A87FF" />
              <stop offset="1" stop-color="#9C7CFF" />
            </linearGradient>
          </defs>
        </svg>
        <span class="brand-name">WorkLog</span>
      </span>
    </div>

    <div class="tb-actions">
      <div ref="themeWrap" class="tb-theme-wrap">
        <button
          class="tb-theme-btn"
          :class="{ active: themeOpen }"
          title="切换主题"
          aria-label="切换主题"
          @click.stop="themeOpen = !themeOpen"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13c.9 0 1.5-.7 1.5-1.5 0-.4-.15-.75-.4-1.02-.25-.27-.4-.63-.4-1.02 0-.83.67-1.5 1.5-1.5h1.3A3 3 0 0 0 14.5 6.4C13.9 3.6 11.25 1.5 8 1.5Z"
              fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            <circle cx="5.1" cy="7.4" r="0.95" fill="currentColor" />
            <circle cx="7.6" cy="4.9" r="0.95" fill="currentColor" />
            <circle cx="10.5" cy="5.7" r="0.95" fill="currentColor" />
            <circle cx="4.7" cy="10.4" r="0.95" fill="currentColor" />
          </svg>
          <span class="tb-theme-dot" :style="{ background: currentSwatch }"></span>
        </button>

        <transition name="theme-pop">
          <div v-if="themeOpen" class="theme-pop" @click.stop>
            <div class="theme-pop-title">外观主题</div>
            <div class="theme-pop-grid">
              <button
                v-for="t in themeOptions"
                :key="t.id"
                class="theme-pop-item"
                :class="{ active: theme === t.id }"
                @click="pickTheme(t.id)"
              >
                <span class="theme-swatch" :style="{ background: t.preview }">
                  <i :style="{ background: t.surface }"></i>
                </span>
                <span class="theme-swatch-label">{{ t.label }}</span>
              </button>
            </div>
          </div>
        </transition>
      </div>

      <button
        class="status-pill"
        :class="{ on: monitoring }"
        :title="monitoring ? '点击暂停记录' : '点击开始记录'"
        @click="$emit('toggle-monitoring')"
      >
        <span class="status-dot" :class="{ pulse: monitoring }"></span>
        <span class="status-text">{{ monitoring ? '记录中' : '已暂停' }}</span>
      </button>

      <div class="win-controls">
        <button class="win-btn" title="最小化" @click="$emit('minimize')">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
        </button>
        <button class="win-btn win-btn-close" title="关闭到托盘" @click="$emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
        </button>
      </div>
    </div>
  </header>
</template>

<script>
export default {
  name: 'TitleBar',
  props: {
    monitoring: { type: Boolean, default: false },
    theme: { type: String, default: 'dark' },
    themeOptions: { type: Array, default: () => [] }
  },
  emits: ['minimize', 'close', 'toggle-monitoring', 'theme-change'],
  data() {
    return { themeOpen: false };
  },
  computed: {
    currentSwatch() {
      const hit = this.themeOptions.find(t => t.id === this.theme);
      return hit ? hit.preview : 'var(--accent)';
    }
  },
  mounted() {
    this._onDocClick = () => { this.themeOpen = false; };
    document.addEventListener('click', this._onDocClick);
  },
  beforeUnmount() {
    document.removeEventListener('click', this._onDocClick);
  },
  methods: {
    pickTheme(id) {
      this.themeOpen = false;
      if (id !== this.theme) this.$emit('theme-change', id);
    }
  }
};
</script>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: var(--sp-4);
  padding-right: var(--sp-2);
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border-subtle);
  -webkit-app-region: drag;
}

.tb-drag {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  flex: 1;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.brand-mark {
  display: block;
  border-radius: 6px;
}

.brand-name {
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.tb-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  -webkit-app-region: no-drag;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 24px;
  padding: 0 var(--sp-2) 0 7px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
    border-color var(--dur-1) var(--ease);
}

.status-pill:hover {
  border-color: var(--border-default);
  color: var(--text-secondary);
}

.status-pill.on {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}

.status-dot.pulse {
  animation: wl-pulse 2.4s var(--ease) infinite;
}

.win-controls {
  display: flex;
  gap: 2px;
}

.win-btn {
  width: 28px;
  height: 24px;
  border-radius: var(--r-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.win-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.win-btn-close:hover {
  background: var(--danger);
  color: #fff;
}

/* ---------- 顶部换肤 ---------- */
.tb-theme-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.tb-theme-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 7px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
    border-color var(--dur-1) var(--ease);
}

.tb-theme-btn:hover,
.tb-theme-btn.active {
  border-color: var(--border-default);
  color: var(--text-secondary);
}

.tb-theme-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--border-default);
  flex: 0 0 auto;
}

.theme-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 350;
  width: 214px;
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
  transform-origin: top right;
  -webkit-app-region: no-drag;
}

.theme-pop-title {
  font-size: var(--fs-10);
  font-weight: var(--fw-semibold);
  color: var(--text-tertiary);
  margin-bottom: var(--sp-2);
}

.theme-pop-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 5px;
}

.theme-pop-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 5px 2px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  color: var(--text-tertiary);
  transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
    background var(--dur-1) var(--ease);
}

.theme-pop-item:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.theme-pop-item.active {
  border-color: var(--accent);
  color: var(--text-primary);
}

.theme-swatch {
  display: block;
  width: 26px;
  height: 26px;
  border-radius: var(--r-xs);
  border: 1px solid var(--border-default);
  padding: 5px;
}

.theme-swatch i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 2px;
}

.theme-swatch-label {
  font-size: 9px;
  white-space: nowrap;
}

.theme-pop-enter-active {
  transition: opacity 200ms var(--ease), transform 200ms var(--ease);
}

.theme-pop-leave-active {
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
}

.theme-pop-enter-from,
.theme-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}
</style>
