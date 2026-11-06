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
    monitoring: { type: Boolean, default: false }
  },
  emits: ['minimize', 'close', 'toggle-monitoring']
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
</style>
