<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="markup"
  />
</template>

<script>
/**
 * 统一图标集：24×24 viewBox / 1.75 描边 / currentColor。
 * 全部内联 SVG，不依赖图标字体，颜色与尺寸随 CSS 走。
 */
const ICONS = {
  // 导航
  home: '<path d="m3 9.5 9-7 9 7V20a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 20z"/><path d="M9.5 21.5v-8h5v8"/>',
  timeline: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  summary: '<path d="M14 2.5H6.5A1.5 1.5 0 0 0 5 4v16a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 20V7.5z"/><path d="M14 2.5V8h5"/><path d="M8.5 13.5h7M8.5 17h4.5"/>',
  settings: '<path d="M4 21v-6.5M4 10.5V3M12 21v-9M12 8V3M20 21v-4.5M20 12.5V3"/><path d="M1.5 14.5h5M9.5 8h5M17.5 16.5h5"/>',

  // 操作
  play: '<path d="M8 5.2a1 1 0 0 1 1.5-.87l9 6.8a1 1 0 0 1 0 1.74l-9 6.8A1 1 0 0 1 8 18.8z"/>',
  pause: '<path d="M9.5 4.5v15M14.5 4.5v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="m4.5 12.5 5 5L20 6.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.2 7l.9 12.6a1.3 1.3 0 0 0 1.3 1.2h6.8a1.3 1.3 0 0 0 1.3-1.2L18.4 7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 5 3h9A1.5 1.5 0 0 1 15.5 4.5V5"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v5.5H15"/>',
  download: '<path d="M20.5 15.5v3A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-3"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M12 15V3.5"/>',
  upload: '<path d="M20.5 15.5v3A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-3"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M12 3.5V15"/>',
  folder: '<path d="M3.5 19.5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h4.7l2 2.8h9.3a1 1 0 0 1 1 1v10.4a1 1 0 0 1-1 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.3 16.3 4.2 4.2"/>',
  external: '<path d="M15 3.5h5.5V9"/><path d="M20.5 3.5 11.5 12.5"/><path d="M18.5 14v5.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1H10"/>',
  filter: '<path d="M3.5 5.5h17l-6.8 8v6.3l-3.4 1.7V13.5z"/>',

  // 时间
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  timer: '<circle cx="12" cy="13.2" r="7.3"/><path d="M12 9.6v3.9l2.4 1.4"/><path d="M9.5 2.5h5"/><path d="M12 2.5v3"/><path d="M4.6 6.2 3.2 7.8M19.4 6.2l1.4 1.6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  arrowLeft: '<path d="M20 12H4.5"/><path d="m10.5 6-6 6 6 6"/>',

  // 状态 / 语义
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2"/>',
  activity: '<path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21"/>',
  chart: '<path d="M3.5 3.5v17h17"/><path d="M8 16.5v-5M13 16.5v-9M18 16.5v-3"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>',
  zap: '<path d="M13.5 2.5 4.5 14h6l-1 7.5L19.5 10h-6z"/>',
  alert: '<path d="M12 3.2 2.5 20h19z"/><path d="M12 9.5v4.5M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  shield: '<path d="M12 2.8 4.5 6v6c0 4.3 3.1 8 7.5 9.2 4.4-1.2 7.5-4.9 7.5-9.2V6z"/>',

  // 功能
  database: '<ellipse cx="12" cy="5.8" rx="8" ry="3.1"/><path d="M4 5.8v6.2c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1V5.8"/><path d="M4 12v6.2c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1V12"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9.5 3 2.8-3 2.8"/><path d="M13 15.5h4"/>',
  plug: '<path d="M9 2.8v6M15 2.8v6"/><path d="M6 8.8h12v3.4a6 6 0 0 1-12 0z"/><path d="M12 18.2v3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="m10.4 12.6 8.4-8.4 2 2-2 2 2 2-2 2-2-2-2.4 2.4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  zen: '<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="2.6"/>',
  bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 0-4 1.5 1.5 0 0 1 0-3h2.5A4.5 4.5 0 0 0 19 9.5C19 6 16 3 12 3z"/><circle cx="8" cy="9.5" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="15.8" cy="9.8" r="1.1"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>'
};

export default {
  name: 'Icon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 },
    strokeWidth: { type: [Number, String], default: 1.75 }
  },
  computed: {
    markup() {
      return ICONS[this.name] || ICONS['info'];
    }
  }
};
</script>

<style scoped>
.icon {
  display: block;
  flex: 0 0 auto;
}
</style>
