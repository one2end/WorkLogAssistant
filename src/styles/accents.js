/* ==========================================================================
   强调色定义（唯一来源）
   --------------------------------------------------------------------------
   外观 = 明暗模式 × 强调色。这里只定义「色相 + 饱和度」，明度由明暗决定，
   tokens.css 里的 .accent-* 与这里的数值一一对应。
   强调色只影响按钮、选中态、链接、高亮；背景/文字/边框始终是中性灰。
   ========================================================================== */

export const ACCENTS = [
  { id: 'blue', label: '靖蓝', hue: 222, sat: 82 },
  { id: 'teal', label: '青碧', hue: 190, sat: 78 },
  { id: 'green', label: '森绿', hue: 158, sat: 58 },
  { id: 'violet', label: '紫藤', hue: 262, sat: 76 },
  { id: 'rose', label: '绯樱', hue: 344, sat: 72 },
  { id: 'amber', label: '暖珀', hue: 34, sat: 88 }
];

/** 在色板上画一个候选色圆点用；light 模式下要压深一档才看得清 */
export function accentSwatch(id, mode = 'dark') {
  const a = ACCENTS.find(x => x.id === id) || ACCENTS[0];
  const lightness = mode === 'light'
    ? (a.id === 'green' ? 32 : a.id === 'teal' ? 34 : a.id === 'amber' ? 42 : 42)
    : (a.id === 'amber' ? 50 : 52);
  return `hsl(${a.hue} ${a.sat}% ${lightness}%)`;
}

export const MODES = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' }
];
