/* 外观 = 主题风格 × 明暗模式；每套主题有固定强调色。分类色保持独立。 */

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

export const SURFACES = [
  { id: 'nocturne', label: '夜航', hint: '蓝灰层次，沉静通透', accent: 'blue' },
  { id: 'linen', label: '纸本', hint: '温暖纸感，适合回顾', accent: 'amber' },
  { id: 'mist', label: '晨雾', hint: '柔和青绿，轻盈舒展', accent: 'green' },
  { id: 'aurora', label: '极光', hint: '紫蓝微光，适合深度专注', accent: 'violet' },
  { id: 'ember', label: '晚霞', hint: '温柔珊瑚，轻快有序', accent: 'rose' }
];
