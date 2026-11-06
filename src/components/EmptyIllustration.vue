<template>
  <svg
    class="illu"
    :width="size"
    :height="size"
    viewBox="0 0 120 120"
    fill="none"
    aria-hidden="true"
  >
    <!-- 共享母题：柔光背景 + 记录卡片 + 顶栏 -->
    <circle class="focal" cx="60" cy="60" r="48" fill="var(--accent-soft)" opacity="0.55" />
    <rect
      x="21" y="22" width="78" height="78" rx="12"
      stroke="currentColor" stroke-width="2" opacity="0.45"
    />
    <path d="M21 40 H99" stroke="currentColor" stroke-width="1.5" opacity="0.3" />
    <circle cx="32" cy="31" r="2.2" fill="currentColor" opacity="0.5" />
    <circle cx="40" cy="31" r="2.2" fill="currentColor" opacity="0.5" />
    <circle cx="48" cy="31" r="2.2" fill="currentColor" opacity="0.5" />

    <!-- 主体：按场景切换 -->
    <g stroke-linecap="round" stroke-linejoin="round">
      <g v-if="variant === 'chart'">
        <path d="M36 84 H84" stroke="currentColor" stroke-width="1.6" opacity="0.45" />
        <rect x="40" y="66" width="9" height="18" rx="2" fill="var(--accent)" opacity="0.5" />
        <rect x="55" y="56" width="9" height="28" rx="2" fill="var(--accent)" opacity="0.78" />
        <rect x="70" y="48" width="9" height="36" rx="2" fill="var(--accent)" />
      </g>

      <g v-else-if="variant === 'grid'">
        <rect x="38" y="52" width="18" height="13" rx="3" fill="var(--accent)" opacity="0.5" />
        <rect x="64" y="52" width="18" height="13" rx="3" fill="var(--accent)" opacity="0.75" />
        <rect x="38" y="71" width="18" height="13" rx="3" fill="var(--accent)" opacity="0.75" />
        <rect x="64" y="71" width="18" height="13" rx="3" fill="var(--accent)" />
      </g>

      <g v-else-if="variant === 'timeline'">
        <path d="M46 52 V84" stroke="currentColor" stroke-width="2" opacity="0.45" />
        <circle cx="46" cy="57" r="3.5" fill="var(--accent)" />
        <circle cx="46" cy="68" r="3.5" fill="var(--accent)" opacity="0.75" />
        <circle cx="46" cy="79" r="3.5" fill="var(--accent)" opacity="0.5" />
        <path d="M57 57 H82 M57 68 H76 M57 79 H70" stroke="currentColor" stroke-width="2" opacity="0.45" />
      </g>

      <g v-else-if="variant === 'search'">
        <circle cx="57" cy="66" r="14" stroke="var(--accent)" stroke-width="2.4" />
        <path d="M67 76 L79 87" stroke="var(--accent)" stroke-width="2.8" />
      </g>

      <g v-else-if="variant === 'summary'">
        <path d="M38 57 H80 M38 68 H80 M38 79 H66" stroke="currentColor" stroke-width="2.2" opacity="0.5" />
        <circle cx="34" cy="57" r="2.2" fill="var(--accent)" />
        <circle cx="34" cy="68" r="2.2" fill="var(--accent)" opacity="0.75" />
        <circle cx="34" cy="79" r="2.2" fill="var(--accent)" opacity="0.5" />
      </g>

      <!-- clock / default：表盘 + 指针 -->
      <g v-else>
        <circle cx="60" cy="68" r="20" stroke="var(--accent)" stroke-width="2.4" />
        <g v-if="variant === 'clock'" stroke="currentColor" stroke-width="1.6" opacity="0.55">
          <path d="M60 50 v3 M60 83 v3 M42 68 h3 M75 68 h3" />
          <path d="M47 55 l2 2 M73 81 l-2 -2 M73 55 l-2 2 M47 81 l2 -2" />
        </g>
        <path d="M60 68 V57" stroke="var(--accent)" stroke-width="2.4" />
        <path d="M60 68 L71 73" stroke="currentColor" stroke-width="2.2" />
        <circle cx="60" cy="68" r="2.8" fill="var(--accent)" />
      </g>
    </g>

    <!-- 底部时间进度条 -->
    <rect x="30" y="104" width="60" height="5" rx="2.5" fill="currentColor" opacity="0.14" />
    <rect x="30" y="104" width="38" height="5" rx="2.5" fill="var(--accent)" opacity="0.85" />
    <circle cx="88" cy="106.5" r="3" fill="var(--accent)" />
  </svg>
</template>

<script>
export default {
  name: 'EmptyIllustration',
  props: {
    variant: { type: String, default: 'default' },
    size: { type: Number, default: 88 }
  }
};
</script>

<style scoped>
.illu {
  display: block;
  flex: 0 0 auto;
  animation: illu-in var(--dur-3) var(--ease) both;
}

.illu .focal {
  transform-origin: 60px 60px;
  animation: illu-breathe 4s var(--ease) infinite;
}

@keyframes illu-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}

@keyframes illu-breathe {
  0%, 100% { opacity: 0.42; }
  50% { opacity: 0.72; }
}

@media (prefers-reduced-motion: reduce) {
  .illu,
  .illu .focal { animation: none; }
}
</style>
