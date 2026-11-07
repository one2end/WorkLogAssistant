<template>
  <section v-if="visible" class="plugin-dock">
    <div class="dock-head">
      <span class="dock-title">插件</span>
      <span class="dock-note">点击方块切换开关 · 齿轮进入设置</span>
    </div>

    <div class="dock-grid">
      <div
        v-for="p in plugins"
        :key="p.id"
        class="dock-card"
        :class="{ 'is-on': on(p) }"
        role="button"
        :title="`点击${on(p) ? '关闭' : '开启'}${p.name}`"
        @click="$emit('toggle', p.id)"
      >
        <div class="dock-top">
          <span class="dock-icon"><Icon :name="p.icon" :size="15" /></span>
          <span class="dock-badge" :class="{ on: on(p) }">{{ on(p) ? '已开启' : '已关闭' }}</span>
        </div>

        <span class="dock-name">{{ p.name }}</span>
        <span class="dock-info" :title="info(p)">{{ info(p) }}</span>

        <!-- 滴答同步：两条通道各自的数据与状态 -->
        <template v-if="p.id === 'dida' && on(p)">
          <div class="dock-metrics">
            <span><b>{{ num(didaStatus.pulledTotal) }}</b>拉取</span>
            <i />
            <span><b>{{ num(didaStatus.pushedTotal) }}</b>推送</span>
            <i />
            <span><b>{{ num(didaStatus.todayFocusCount) }}</b>今日</span>
          </div>
          <div class="dock-channels">
            <span :class="{ on: pullOn }">↓ 拉取 {{ pullOn ? '开' : '关' }}</span>
            <span :class="{ on: pushOn }">↑ 推送 {{ pushOn ? '开' : '关' }}</span>
          </div>
        </template>

        <!-- AI：模型 + 首页洞察条数 -->
        <div v-else-if="p.id === 'ai' && on(p)" class="dock-ai">
          <span>{{ insightCount ? `${insightCount} 条待确认的提示` : '暂无待确认提示' }}</span>
        </div>

        <div class="dock-foot">
          <span
            class="dock-switch"
            :class="{ on: on(p) }"
            :title="on(p) ? '点击关闭' : '点击开启'"
            @click.stop="$emit('toggle', p.id)"
          ><i /></span>
          <button class="dock-gear" title="打开插件设置" @click.stop="$emit('settings', p.id)">
            <Icon name="settings" :size="13" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script>
import Icon from './Icon.vue';
import { PLUGINS, pluginOn } from '../plugins/registry.js';

export default {
  name: 'PluginDock',
  components: { Icon },
  props: {
    config: { type: Object, default: () => ({}) },
    didaStatus: { type: Object, default: () => ({}) },
    insightCount: { type: Number, default: 0 }
  },
  emits: ['toggle', 'settings'],
  computed: {
    plugins() { return PLUGINS; },
    visible() {
      const d = this.config && this.config.dashboard;
      return !d || d.showPluginDock !== false;
    },
    pullOn() {
      return this.onById('dida') && this.config.dida?.pullFocus !== false;
    },
    pushOn() {
      return this.onById('dida') && this.config.dida?.pushEnabled === true;
    }
  },
  methods: {
    on(p) { return pluginOn(this.config, p); },
    onById(id) {
      const p = PLUGINS.find(x => x.id === id);
      return p ? this.on(p) : false;
    },
    num(v) { return Number(v) || 0; },
    info(p) {
      const c = this.config || {};
      if (p.id === 'pomodoro') {
        if (!this.on(p)) return '本地计时已关闭';
        const f = (c.focus && c.focus.pomodoro) || {};
        return `${f.workMin || 25} 分钟 · ${f.rounds || 0} 轮`;
      }
      if (p.id === 'ai') {
        if (!this.on(p)) return '未启用 · 数据不出本机';
        if (!(c.api && c.api.apiKey)) return '待填写 API Key';
        return (c.api && c.api.modelName) || '模型待配置';
      }
      if (p.id === 'mcp') {
        return this.on(p) ? `端口 ${(c.bridge && c.bridge.port) || 47821}` : '本地服务已停止';
      }
      if (p.id === 'dida') {
        if (!this.on(p)) return '拉取与推送均已停用';
        const s = this.didaStatus || {};
        const today = this.num(s.todayFocusCount);
        const mins = this.num(s.todayFocusMinutes);
        return today ? `今日 ${today} 条专注 · ${mins} 分钟` : (s.lastPullAt ? `镜像 ${this.num(s.mirrorRecords)} 条` : '尚未同步');
      }
      return p.desc;
    }
  }
};
</script>

<style scoped>
.plugin-dock {
  grid-column: 1 / -1;
  width: 100%;
  margin-top: var(--sp-2);
}

.dock-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.dock-title {
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.dock-note {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.dock-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3);
}

.dock-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease),
    transform var(--dur-1) var(--ease);
}

.dock-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.dock-card.is-on {
  border-color: color-mix(in srgb, var(--accent) 22%, transparent);
}

.dock-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.dock-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  color: var(--text-tertiary);
  background: var(--bg-inset);
}

.dock-card.is-on .dock-icon {
  color: var(--accent);
  background: var(--accent-soft);
}

.dock-badge {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  padding: 2px 7px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  white-space: nowrap;
}

.dock-badge.on {
  color: var(--accent);
  background: var(--accent-soft);
}

.dock-name {
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.dock-info {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-metrics {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-top: 2px;
  padding: 6px 2px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.dock-metrics span {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.dock-metrics b {
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.dock-metrics i {
  width: 1px;
  height: 18px;
  background: var(--border-subtle);
}

.dock-channels {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.dock-channels span {
  padding: 2px 7px;
  border-radius: var(--r-full);
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  background: var(--bg-inset);
  white-space: nowrap;
}

.dock-channels span.on {
  color: var(--accent);
  background: var(--accent-soft);
}

.dock-ai {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  padding: 5px 8px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
}

.dock-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--sp-2);
}

.dock-switch {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: var(--r-full);
  background: var(--bg-active);
  border: 1px solid var(--border-default);
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}

.dock-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--dur-1) var(--ease);
}

.dock-switch.on {
  background: var(--accent);
  border-color: var(--accent);
}

.dock-switch.on i { transform: translateX(14px); }

.dock-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-xs);
  color: var(--text-tertiary);
}

.dock-gear:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

@media (max-width: 900px) {
  .dock-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 520px) {
  .dock-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
