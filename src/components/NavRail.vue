<template>
  <nav class="rail">
    <div class="rail-top">
      <button
        v-for="item in items"
        :key="item.id"
        class="rail-btn"
        :class="{ active: modelValue === item.id }"
        :aria-label="item.label"
        @click="$emit('update:modelValue', item.id)"
      >
        <Icon :name="item.icon" :size="18" />
        <span class="rail-tip">{{ item.label }}</span>
      </button>
    </div>

    <div class="rail-bottom">
      <button class="rail-btn rail-btn-focus" aria-label="专注模式" @click="$emit('focus')">
        <Icon name="zen" :size="18" />
        <span class="rail-tip">专注模式</span>
      </button>
    </div>
  </nav>
</template>

<script>
import Icon from './Icon.vue';

export default {
  name: 'NavRail',
  components: { Icon },
  props: {
    modelValue: { type: String, default: 'today' }
  },
  emits: ['update:modelValue', 'focus'],
  data() {
    return {
      items: [
        { id: 'today', label: '今日概览', icon: 'home' },
        { id: 'timeline', label: '时间线', icon: 'timeline' },
        { id: 'summary', label: 'AI 摘要', icon: 'summary' },
        { id: 'settings', label: '设置', icon: 'settings' }
      ]
    };
  }
};
</script>

<style scoped>
.rail {
  width: var(--rail-w);
  flex: 0 0 var(--rail-w);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: var(--sp-2) 0;
  background: var(--bg-canvas);
  border-right: 1px solid var(--border-subtle);
}

.rail-top,
.rail-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
}

.rail-btn {
  position: relative;
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.rail-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.rail-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.rail-btn.active::before {
  content: "";
  position: absolute;
  left: -7px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: var(--r-full);
  background: var(--accent);
}

.rail-btn-focus:hover {
  color: var(--accent);
}

/* 悬浮提示 */
.rail-tip {
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  padding: 3px 8px;
  border-radius: var(--r-xs);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-11);
  color: var(--text-primary);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
  z-index: 40;
}

.rail-btn:hover .rail-tip {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
</style>
