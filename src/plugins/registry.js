/**
 * 插件注册表：LifeLog 里所有可选能力的唯一清单。
 *
 * 插件不是页面，是「开关 + 首页状态方块 + 各自参数」三件事。
 * 开关值直接落在已有配置路径上（focus.enabled / ai.enabled /
 * bridge.enabled / dida.enabled），不另建一份 plugins 配置，
 * 避免出现两个真相来源。
 */
export const PLUGINS = [
  {
    id: 'pomodoro',
    name: '番茄钟',
    icon: 'target',
    path: 'focus.enabled',
    section: 'pomodoro',
    desc: '本地专注计时',
    defaultOn: true
  },
  {
    id: 'ai',
    name: 'AI 能力',
    icon: 'cpu',
    path: 'ai.enabled',
    section: 'ai',
    desc: '归类、提醒与日报周报',
    defaultOn: false
  },
  {
    id: 'mcp',
    name: 'MCP 接口',
    icon: 'plug',
    path: 'bridge.enabled',
    section: 'bridge',
    desc: '本地只读数据服务',
    defaultOn: true
  },
  {
    id: 'dida',
    name: '滴答同步',
    icon: 'refresh',
    path: 'dida.enabled',
    section: 'dida',
    desc: '专注拉取与展示层推送',
    defaultOn: false
  }
];

/** 首页统计卡片的可开关项 */
export const DASHBOARD_CARDS = [
  { key: 'aiInsights', label: '记录提示' },
  { key: 'heatmap', label: '活跃度热力图' },
  { key: 'session', label: '当前会话' },
  { key: 'plan', label: '今日计划' },
  { key: 'threads', label: '活动线程' },
  { key: 'weeklyReview', label: '周回顾草稿' },
  { key: 'composition', label: '时间构成' },
  { key: 'apps', label: '应用排行' },
  { key: 'focusNotes', label: '专注与随手记' }
];

/** 当前有效的 DeepSeek API 模型名（deepseek-chat 已于 2026-07-24 停用） */
export const AI_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash · 推荐', note: 'V4.1 Flash，快且便宜' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: '深度推理，价格更高' },
  { id: 'deepseek-v4-flash', label: 'V4 Flash 旧别名', note: '仍兼容，建议改用 Flash' }
];

export function readPath(obj, path) {
  return String(path).split('.').reduce(
    (o, k) => (o && o[k] !== undefined ? o[k] : undefined),
    obj
  );
}

export function writePath(obj, path, value) {
  const keys = String(path).split('.');
  let target = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!target[keys[i]] || typeof target[keys[i]] !== 'object') target[keys[i]] = {};
    target = target[keys[i]];
  }
  target[keys[keys.length - 1]] = value;
  return obj;
}

/** 配置缺字段时回退到默认值，旧配置不用迁移 */
export function pluginOn(config, plugin) {
  const v = readPath(config || {}, plugin.path);
  return v === undefined ? !!plugin.defaultOn : !!v;
}

export function pluginById(id) {
  return PLUGINS.find(p => p.id === id) || null;
}
