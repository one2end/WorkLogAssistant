<template>
  <div class="settings">
    <div class="set-intro">
      <h2>设置</h2>
      <p>记录方式、AI 模型与数据接口</p>
    </div>

    <section class="sec">
      <div class="sec-head">
        <Icon name="activity" :size="13" />
        <span>记录</span>
      </div>
      <div class="sec-body">
        <div class="row">
          <span class="row-label">
            空闲判定阈值
            <span class="row-desc">连续无键鼠操作超过此时长记为离座，不计入有效工时</span>
          </span>
          <div class="row-control sm">
            <input
              :value="monitoring.idleThresholdSec"
              type="number" min="30" max="3600" step="30"
              @change="num('monitoring.idleThresholdSec', $event.target.value, 30, 3600)"
            >
            <span class="unit">秒</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">
            最短片段
            <span class="row-desc">短于此时间的切换会并入上一段，避免时间线碎片化</span>
          </span>
          <div class="row-control sm">
            <input
              :value="monitoring.minSegmentSec"
              type="number" min="0" max="60" step="1"
              @change="num('monitoring.minSegmentSec', $event.target.value, 0, 60)"
            >
            <span class="unit">秒</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">
            轮询间隔
            <span class="row-desc">仅在无法常驻采样的平台生效</span>
          </span>
          <div class="row-control sm">
            <input
              :value="monitoring.interval"
              type="number" min="5" max="300" step="5"
              @change="num('monitoring.interval', $event.target.value, 5, 300)"
            >
            <span class="unit">秒</span>
          </div>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="zen" :size="13" />
        <span>专注模式</span>
      </div>
      <div class="sec-body">
        <p class="sec-desc">番茄钟与沉浸模式的时长可自定义；罗汉模式不计时，只做当下这一件事。</p>

        <div class="row">
          <span class="row-label">番茄钟 · 专注</span>
          <div class="row-control sm">
            <input
              :value="focus.pomodoro && focus.pomodoro.workMin"
              type="number" min="5" max="120" step="5"
              @change="num('focus.pomodoro.workMin', $event.target.value, 5, 120)"
            >
            <span class="unit">分钟</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">番茄钟 · 休息</span>
          <div class="row-control sm">
            <input
              :value="focus.pomodoro && focus.pomodoro.breakMin"
              type="number" min="0" max="60" step="1"
              @change="num('focus.pomodoro.breakMin', $event.target.value, 0, 60)"
            >
            <span class="unit">分钟</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">番茄钟 · 每组轮数</span>
          <div class="row-control sm">
            <input
              :value="focus.pomodoro && focus.pomodoro.rounds"
              type="number" min="0" max="12" step="1"
              @change="num('focus.pomodoro.rounds', $event.target.value, 0, 12)"
            >
            <span class="unit">轮</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">沉浸 · 专注</span>
          <div class="row-control sm">
            <input
              :value="focus.immersive && focus.immersive.workMin"
              type="number" min="5" max="120" step="5"
              @change="num('focus.immersive.workMin', $event.target.value, 5, 120)"
            >
            <span class="unit">分钟</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">沉浸 · 休息</span>
          <div class="row-control sm">
            <input
              :value="focus.immersive && focus.immersive.breakMin"
              type="number" min="0" max="60" step="1"
              @change="num('focus.immersive.breakMin', $event.target.value, 0, 60)"
            >
            <span class="unit">分钟</span>
          </div>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="zap" :size="13" />
        <span>AI 模型</span>
      </div>
      <div class="sec-body">
        <div class="row">
          <span class="row-label">服务商</span>
          <div class="row-control">
            <select
              :value="api.provider"
              @change="$emit('provider-change', $event.target.value)"
            >
              <option v-for="(preset, key) in providerPresets" :key="key" :value="key">
                {{ preset.name }}
              </option>
            </select>
          </div>
        </div>

        <div class="row">
          <span class="row-label">API Key</span>
          <div class="row-control">
            <input
              :value="api.apiKey"
              type="password"
              placeholder="sk-..."
              autocomplete="off"
              @change="set('api.apiKey', $event.target.value)"
            >
          </div>
        </div>

        <div class="row">
          <span class="row-label">Base URL</span>
          <div class="row-control wide">
            <input
              :value="api.baseUrl"
              type="text"
              spellcheck="false"
              @change="set('api.baseUrl', $event.target.value)"
            >
          </div>
        </div>

        <div class="row">
          <span class="row-label">模型名称</span>
          <div class="row-control wide">
            <input
              :value="api.modelName"
              type="text"
              spellcheck="false"
              @change="set('api.modelName', $event.target.value)"
            >
          </div>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="summary" :size="13" />
        <span>摘要</span>
      </div>
      <div class="sec-body">
        <div class="row">
          <span class="row-label">回溯时长</span>
          <div class="row-control sm">
            <input
              :value="summary.lookbackMinutes"
              type="number" min="5" max="1440" step="5"
              @change="num('summary.lookbackMinutes', $event.target.value, 5, 1440)"
            >
            <span class="unit">分钟</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">最大输出</span>
          <div class="row-control sm">
            <input
              :value="summary.maxTokens"
              type="number" min="100" max="8000" step="100"
              @change="num('summary.maxTokens', $event.target.value, 100, 8000)"
            >
            <span class="unit">token</span>
          </div>
        </div>

        <div class="row">
          <span class="row-label">
            压缩活动
            <span class="row-desc">把同类窗口合并后再送给模型，省 token</span>
          </span>
          <div class="row-control">
            <input
              type="checkbox"
              :checked="summary.compressActivities !== false"
              @change="set('summary.compressActivities', $event.target.checked)"
            >
          </div>
        </div>

        <div class="row-block">
          <span class="row-label">自定义提示词</span>
          <textarea
            :value="summary.prompt"
            rows="3"
            placeholder="留空使用内置提示词"
            @change="set('summary.prompt', $event.target.value)"
          ></textarea>
        </div>

        <div class="row-block">
          <span class="row-label">自动总结时段</span>
          <div
            v-for="(s, i) in scheduleList"
            :key="i"
            class="sched-row"
          >
            <input
              :value="s.startTime"
              type="time"
              @change="set('summary.schedules.' + i + '.startTime', $event.target.value)"
            >
            <span class="sched-sep">→</span>
            <input
              :value="s.endTime"
              type="time"
              @change="set('summary.schedules.' + i + '.endTime', $event.target.value)"
            >
            <button class="btn-icon" title="删除" @click="$emit('remove-schedule', i)">
              <Icon name="x" :size="13" />
            </button>
          </div>
          <button class="btn btn-ghost btn-sm add-sched" @click="$emit('add-schedule')">
            <Icon name="plus" :size="12" /> 添加时段
          </button>
          <p class="hint">到达结束时间时，自动生成该时段的摘要。</p>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="palette" :size="13" />
        <span>外观</span>
      </div>
      <div class="sec-body">
        <div class="row-block">
          <span class="row-label">主题</span>
          <div class="theme-grid">
            <button
              v-for="t in themeOptions"
              :key="t.id"
              class="theme-cell"
              :class="{ active: theme === t.id }"
              :title="t.label"
              @click="$emit('theme-change', t.id)"
            >
              <span class="theme-swatch" :style="{ background: t.preview }">
                <span class="theme-swatch-inner" :style="{ background: t.surface }"></span>
              </span>
              <span class="theme-name">{{ t.label }}</span>
              <Icon v-if="theme === t.id" name="check" :size="12" class="theme-check" />
            </button>
          </div>
        </div>

        <div class="row">
          <span class="row-label">
            最小化时显示浮窗
            <span class="row-desc">收起主窗口后，在桌面角落保留当前应用与计时</span>
          </span>
          <div class="row-control">
            <input
              type="checkbox"
              :checked="ui.floatWindow !== false"
              @change="set('ui.floatWindow', $event.target.checked)"
            >
          </div>
        </div>

        <div class="row">
          <span class="row-label">开机自启动</span>
          <div class="row-control">
            <input
              type="checkbox"
              :checked="autoLaunch"
              @change="$emit('toggle-auto-launch', $event.target.checked)"
            >
          </div>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="plug" :size="13" />
        <span>AI 数据接口</span>
        <span class="sec-badge" :class="{ on: isBridgeOn }">
          {{ isBridgeOn ? '运行中' : (bridgeEnabled ? '未启动' : '已关闭') }}
        </span>
      </div>
      <div class="sec-body">
        <p class="sec-desc">
          把聚合后的工时数据开放给 WorkBuddy、Claude 等支持 MCP 的客户端。配一次即可用自然语言查询。
        </p>

        <div class="row">
          <span class="row-label">启用本地 HTTP</span>
          <div class="row-control">
            <input
              type="checkbox"
              :checked="bridgeEnabled"
              :disabled="bridgeLoading"
              @change="$emit('bridge-toggle', $event.target.checked)"
            >
          </div>
        </div>

        <div class="row">
          <span class="row-label">
            端口
            <span class="row-desc" v-if="isBridgeOn">{{ bridge.url }}</span>
            <span class="row-desc" v-else>端口被占用时会自动顺延</span>
          </span>
          <div class="row-control">
            <input
              :value="bridgePortInput"
              type="number" min="1024" max="65535"
              class="port-input"
              @input="$emit('update:bridgePortInput', $event.target.value)"
            >
            <button class="btn btn-secondary btn-sm" :disabled="bridgeLoading" @click="$emit('bridge-apply-port')">
              应用
            </button>
          </div>
        </div>

        <div class="row">
          <span class="row-label">访问 Token</span>
          <div class="row-control">
            <code class="token-box">{{ bridge ? bridge.token : '' }}</code>
            <button class="btn-icon" title="复制" @click="copy(bridge ? bridge.token : '', 'token')">
              <Icon :name="bridgeCopied === 'token' ? 'check' : 'copy'" :size="13" />
            </button>
            <button class="btn-icon" title="重新生成" :disabled="bridgeLoading" @click="$emit('bridge-regen')">
              <Icon name="refresh" :size="13" />
            </button>
          </div>
        </div>

        <div class="row">
          <span class="row-label">连通性</span>
          <div class="row-control">
            <button class="btn btn-secondary btn-sm" :disabled="bridgeTesting" @click="$emit('bridge-test')">
              {{ bridgeTesting ? '测试中' : '测试' }}
            </button>
            <button v-if="isBridgeOn" class="btn btn-ghost btn-sm" @click="$emit('bridge-open')">
              打开 <Icon name="external" :size="11" />
            </button>
            <span
              v-if="bridgeTestResult"
              class="test-result"
              :class="{ ok: bridgeTestResult.ok }"
            >
              {{ bridgeTestResult.ok ? 'HTTP ' + bridgeTestResult.statusCode : (bridgeTestResult.error || '失败') }}
            </span>
          </div>
        </div>

        <div class="mcp-box">
          <div class="mcp-head">
            <span>MCP 配置</span>
            <button class="btn btn-ghost btn-sm" @click="copy(bridge ? bridge.mcpConfig : '', 'mcp')">
              <Icon :name="bridgeCopied === 'mcp' ? 'check' : 'copy'" :size="11" />
              {{ bridgeCopied === 'mcp' ? '已复制' : '复制' }}
            </button>
          </div>
          <pre class="mcp-pre">{{ bridge ? bridge.mcpConfig : '加载中…' }}</pre>
          <p class="hint">
            粘贴到客户端的 <code>mcp.json</code> 后重启。可用工具：日报告、区间报告、应用排行、关键词检索、时间线。
          </p>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="database" :size="13" />
        <span>数据</span>
      </div>
      <div class="sec-body">
        <div class="row-block">
          <span class="row-label">存储路径</span>
          <code class="path-box" :title="storagePath">{{ storagePath || '默认路径' }}</code>
          <div class="path-actions">
            <button class="btn btn-secondary btn-sm" @click="$emit('select-storage')">更改</button>
            <button
              v-if="config.storage && config.storage.customPath"
              class="btn btn-danger btn-sm"
              @click="$emit('reset-storage')"
            >恢复默认</button>
          </div>
          <p class="hint">指向 iCloud / OneDrive / 坚果云 目录可实现跨设备同步。</p>
        </div>

        <div class="row-block">
          <span class="row-label">导出</span>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" @click="$emit('export-day')">
              <Icon name="download" :size="12" /> 当日 JSON
            </button>
            <button class="btn btn-secondary btn-sm" @click="$emit('export-full-json')">
              <Icon name="download" :size="12" /> 全部 JSON
            </button>
            <button class="btn btn-secondary btn-sm" @click="$emit('export-csv')">
              <Icon name="download" :size="12" /> CSV
            </button>
          </div>
        </div>

        <div class="row-block">
          <span class="row-label">导入</span>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" @click="$emit('import-merge')">
              <Icon name="upload" :size="12" /> 合并
            </button>
            <button class="btn btn-danger btn-sm" @click="$emit('import-overwrite')">
              <Icon name="upload" :size="12" /> 覆盖
            </button>
          </div>
          <p class="hint">「覆盖」会先清空现有活动记录，操作不可撤销。</p>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="terminal" :size="13" />
        <span>诊断</span>
        <span class="sec-badge">{{ logs.length }} 条</span>
      </div>
      <div class="sec-body">
        <div class="log-toolbar">
          <button class="btn btn-ghost btn-sm" @click="$emit('open-logs')">
            <Icon name="folder" :size="12" /> 打开日志目录
          </button>
          <button class="btn btn-ghost btn-sm" @click="$emit('clear-logs')">
            <Icon name="trash" :size="12" /> 清空
          </button>
        </div>
        <div class="log-box">
          <div v-for="(l, i) in logs.slice(0, 200)" :key="i" class="log-line" :class="l.type">
            <span class="log-t">{{ l.time }}</span>
            <span class="log-m">{{ l.message }}</span>
          </div>
          <div v-if="!logs.length" class="log-empty">暂无日志</div>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head">
        <Icon name="info" :size="13" />
        <span>关于</span>
      </div>
      <div class="sec-body">
        <div class="row">
          <span class="row-label">
            WorkLog Assistant
            <span class="row-desc">自动追踪工作活动，AI 生成工作日志</span>
          </span>
          <div class="row-control">
            <span class="tag">v{{ appVersion }}</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">版本更新</span>
          <div class="row-control">
            <button class="btn btn-secondary btn-sm" :disabled="checkingUpdate" @click="$emit('check-update')">
              {{ checkingUpdate ? '检查中' : '检查更新' }}
            </button>
            <button
              v-if="updateInfo && updateInfo.hasUpdate"
              class="btn btn-primary btn-sm"
              @click="$emit('open-download')"
            >
              v{{ updateInfo.latestVersion }}
            </button>
            <span v-if="updateInfo && !updateInfo.hasUpdate && !updateInfo.error" class="test-result ok">已是最新</span>
            <span v-if="updateInfo && updateInfo.error" class="test-result">检查失败</span>
          </div>
        </div>
      </div>
    </section>


    <div class="set-foot">
      WorkLog Assistant v{{ appVersion }}
    </div>
  </div>
</template>

<script>
import Icon from '../components/Icon.vue';

export default {
  name: 'SettingsView',
  components: { Icon },
  props: {
    config: { type: Object, required: true },
    theme: { type: String, default: 'dark' },
    themeOptions: { type: Array, default: () => [] },
    providerPresets: { type: Object, default: () => ({}) },
    bridge: { type: Object, default: null },
    bridgeLoading: { type: Boolean, default: false },
    bridgeTesting: { type: Boolean, default: false },
    bridgeTestResult: { type: Object, default: null },
    bridgeCopied: { type: String, default: '' },
    bridgePortInput: { type: [Number, String], default: 47821 },
    autoLaunch: { type: Boolean, default: false },
    appVersion: { type: String, default: '' },
    updateInfo: { type: Object, default: null },
    checkingUpdate: { type: Boolean, default: false },
    logs: { type: Array, default: () => [] },
    storagePath: { type: String, default: '' },
    costEstimate: { type: Object, default: () => ({}) }
  },
  emits: [
    'save', 'provider-change', 'toggle-auto-launch', 'theme-change',
    'select-storage', 'reset-storage',
    'export-day', 'export-full-json', 'export-csv', 'import-merge', 'import-overwrite',
    'bridge-toggle', 'bridge-apply-port', 'bridge-regen', 'bridge-test', 'bridge-copy', 'bridge-open',
    'update:bridgePortInput', 'add-schedule', 'remove-schedule',
    'check-update', 'open-download', 'clear-logs', 'open-logs'
  ],
  data() {
    return {
      activeSection: 'record',
      sections: [
        { id: 'record', label: '记录', icon: 'activity' },
        { id: 'ai', label: 'AI', icon: 'zap' },
        { id: 'appearance', label: '外观', icon: 'palette' },
        { id: 'bridge', label: '接口', icon: 'plug' },
        { id: 'data', label: '数据', icon: 'database' },
        { id: 'about', label: '关于', icon: 'info' }
      ],
      schedules: []
    };
  },
  computed: {
    monitoring() {
      return this.config.monitoring || {};
    },
    api() {
      return this.config.api || {};
    },
    summary() {
      return this.config.summary || {};
    },
    ui() {
      return this.config.ui || {};
    },
    focus() {
      return this.config.focus || {};
    },
    scheduleList() {
      return (this.config.summary && this.config.summary.schedules) || [];
    },
    isBridgeOn() {
      return !!this.bridge && this.bridge.running;
    },
    bridgeEnabled() {
      return !this.bridge || this.bridge.enabled !== false;
    }
  },
  methods: {
    /** 写入配置并持久化。path 支持 "monitoring.interval" */
    set(path, value) {
      const keys = path.split('.');
      let target = this.config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]]) target[keys[i]] = {};
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;
      this.$emit('save');
    },
    num(path, value, min, max) {
      let n = parseInt(value, 10);
      if (Number.isNaN(n)) return;
      if (typeof min === 'number') n = Math.max(min, n);
      if (typeof max === 'number') n = Math.min(max, n);
      this.set(path, n);
    },
    copy(text, tag) {
      this.$emit('bridge-copy', text, tag);
    }
  }
};
</script>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
}

.set-intro h2 {
  margin: 0;
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
}

.set-intro p {
  margin: 2px 0 0;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

.sec {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  overflow: hidden;
}

.sec-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  color: var(--text-secondary);
}

.sec-head .icon {
  color: var(--text-tertiary);
}

.sec-body {
  padding: var(--sp-1) var(--sp-4) var(--sp-3);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 42px;
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.row:last-child {
  border-bottom: none;
}

.row-label {
  font-size: var(--fs-12);
  color: var(--text-primary);
  flex: 1 1 auto;
  min-width: 0;
}

.row-desc {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

.row-control {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.row-control.wide {
  flex: 1 1 55%;
  min-width: 0;
}

.row-control.wide input[type="text"] {
  width: 100%;
}

.row-control input[type="text"],
.row-control input[type="password"],
.row-control input[type="number"],
.row-control input[type="time"],
.row-control select {
  width: 150px;
  padding: 5px 9px;
  font-size: var(--fs-11);
}

.row-control.sm input[type="number"] {
  width: 76px;
}

.row-block {
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.row-block:last-child {
  border-bottom: none;
}

.row-block > .row-label {
  display: block;
  margin-bottom: var(--sp-2);
}

.hint {
  margin: 4px 0 0;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

.hint code {
  font-family: var(--font-mono);
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-inset);
  color: var(--text-secondary);
}

.unit {
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  flex: 0 0 auto;
}

.row-label {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.sec-desc {
  margin: var(--sp-2) 0 var(--sp-1);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  line-height: var(--lh-snug);
}

.sec-badge {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  font-size: var(--fs-10);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
}

.sec-badge.on {
  background: var(--success-soft);
  color: var(--success);
}

/* 主题选择 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-2);
}

.theme-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 7px 4px 6px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}

.theme-cell:hover {
  border-color: var(--border-strong);
}

.theme-cell.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.theme-swatch {
  width: 26px;
  height: 18px;
  border-radius: var(--r-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.theme-swatch-inner {
  width: 14px;
  height: 8px;
  border-radius: 2px;
}

.theme-name {
  font-size: var(--fs-10);
  color: var(--text-secondary);
}

.theme-cell.active .theme-name {
  color: var(--text-primary);
}

.theme-check {
  position: absolute;
  top: 3px;
  right: 3px;
  color: var(--accent);
}

/* 时段 */
.sched-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}

.sched-row input[type="time"] {
  width: 96px;
  padding: 4px 8px;
  font-size: var(--fs-11);
}

.sched-sep {
  color: var(--text-tertiary);
  font-size: var(--fs-11);
}

.add-sched {
  margin-top: 2px;
}

/* 接口 */
.token-box {
  display: inline-block;
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 7px;
  border-radius: var(--r-xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-10);
  color: var(--text-secondary);
}

.port-input {
  width: 84px !important;
  padding: 5px 9px !important;
  font-size: var(--fs-11) !important;
}

.test-result {
  font-size: var(--fs-10);
  color: var(--danger);
  white-space: nowrap;
}

.test-result.ok {
  color: var(--success);
}

.mcp-box {
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
}

.mcp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.mcp-pre {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-xs);
  background: var(--bg-canvas);
  font-family: var(--font-mono);
  font-size: var(--fs-10);
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 150px;
  overflow-y: auto;
  user-select: text;
}

/* 数据 */
.path-box {
  display: block;
  padding: 6px 9px;
  border-radius: var(--r-xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-10);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
}

.path-actions,
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

/* 诊断 */
.log-toolbar {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}

.log-box {
  max-height: 220px;
  overflow-y: auto;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-10);
  line-height: 1.7;
  user-select: text;
}

.log-line {
  display: flex;
  gap: var(--sp-2);
  color: var(--text-secondary);
}

.log-t {
  color: var(--text-tertiary);
  flex: 0 0 auto;
}

.log-line.error .log-m {
  color: var(--danger);
}

.log-empty {
  color: var(--text-tertiary);
  text-align: center;
  padding: var(--sp-3);
}

.set-foot {
  padding: var(--sp-2) 0 var(--sp-4);
  text-align: center;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}
</style>
