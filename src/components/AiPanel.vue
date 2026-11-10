<template>
  <div class="ai-wrap">
    <!-- 状态一：AI 关闭。这里只是一条提示，不占页面、不进导航 -->
    <section v-if="!enabled" class="ai-off">
      <span class="ai-off-icon"><Icon name="zap" :size="13" /></span>
      <div class="ai-off-text">
        <strong>AI 活动助理未启用</strong>
        <span>开启后会核对活动识别、提取未完成事项，并把需要确认的分类集中列出。</span>
      </div>
      <button class="btn btn-ghost btn-sm" @click="$emit('open-settings')">了解并开启</button>
    </section>

    <!-- 状态二：开了但模型没配好 -->
    <section v-else-if="!ready" class="ai-off is-warn">
      <span class="ai-off-icon"><Icon name="alert" :size="13" /></span>
      <div class="ai-off-text">
        <strong>AI 已开启，但还不能用</strong>
        <span>缺少模型 API Key，填好之后这张卡片才会开始工作。</span>
      </div>
      <button class="btn btn-primary btn-sm" @click="$emit('open-settings')">去配置模型</button>
    </section>

    <!-- 状态三：AI 可用 -->
    <section v-else class="card ai-card">
      <header class="ai-head">
        <span class="ai-title">
          <Icon name="zap" :size="13" />
          AI 活动助理
          <span class="ai-chip">{{ providerLabel }}</span>
        </span>
        <span v-if="autoReview" class="ai-meta">{{ scheduledReview ? '定时段自动回顾' : `自动回顾 · 每 ${reviewInterval} 分钟` }}</span>
        <button v-else
          class="btn btn-ghost btn-sm"
          :disabled="generating || !hasData"
          :title="hasData ? '核对识别结果并整理下一步' : '这一天还没有可分析的记录'"
          @click="$emit('generate')"
        >
          <Icon :name="generating ? 'refresh' : 'zap'" :size="12" :class="{ spin: generating }" />
          {{ generating ? '分析中' : (latest ? '重新分析' : '分析今日活动') }}
        </button>
      </header>

      <template v-if="latest">
        <div v-if="actionHints.length" class="ai-actions">
          <div v-for="hint in actionHints" :key="hint.title" class="ai-action">
            <strong>{{ hint.title }}</strong><span>{{ hint.text }}</span>
          </div>
        </div>
        <div class="ai-body" :class="{ 'is-clamped': clamped && !expanded }">
          <div class="md" v-html="html"></div>
        </div>
        <div class="ai-foot">
          <span class="ai-meta">
            <Icon name="clock" :size="10" />
            {{ timeRange(latest) }}
            <template v-if="latest.kind === 'auto'"> · 自动评估</template>
            <template v-if="latest.activityCount"> · {{ latest.activityCount }} 个片段</template>
          </span>
          <button v-if="clamped" class="ai-more" @click="expanded = !expanded">
            {{ expanded ? '收起' : '展开全文' }}
          </button>
          <button v-if="others.length" class="ai-more" @click="showAll = !showAll">
            {{ showAll ? '只看最新' : `更早 ${others.length} 条` }}
          </button>
        </div>

        <div v-if="showAll" class="ai-history">
          <article v-for="s in others" :key="s.id" class="ai-history-item">
            <div class="ai-meta">
              <Icon name="clock" :size="10" />
              {{ timeRange(s) }}
            </div>
            <div class="md" v-html="render(s.summary)"></div>
          </article>
        </div>
      </template>

      <p v-else class="ai-empty">
        {{ hasData
          ? (autoReview ? '自动回顾已开启；完成一个记录周期后会在这里显示。' : '这一天还没有回顾，可按需生成。')
          : '这一天没有记录，暂时没有可回顾的内容。' }}
      </p>
    </section>
  </div>
</template>

<script>
import { marked } from 'marked';
import Icon from './Icon.vue';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

// 回顾来自外部模型或历史导入，不能把其中的 HTML 当作应用代码执行。
const safeRenderer = new marked.Renderer();
safeRenderer.html = html => escapeHtml(html);
safeRenderer.image = (href, title, alt) => escapeHtml(alt || title || '图片');
safeRenderer.link = (href, title, label) => {
  if (!/^https?:\/\//i.test(String(href || ''))) return label;
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${label}</a>`;
};

const PROVIDER_NAMES = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  zhipu: '智谱',
  qwen: '通义千问',
  ollama: '本地 Ollama'
};

export default {
  name: 'AiPanel',
  components: { Icon },
  props: {
    enabled: { type: Boolean, default: false },
    ready: { type: Boolean, default: false },
    summaries: { type: Array, default: () => [] },
    generating: { type: Boolean, default: false },
    selectedDate: { type: String, default: '' },
    hasData: { type: Boolean, default: false },
    provider: { type: String, default: '' },
    autoReview: { type: Boolean, default: false },
    reviewInterval: { type: Number, default: 60 },
    scheduledReview: { type: Boolean, default: false }
  },
  emits: ['generate', 'open-settings'],
  data() {
    return { expanded: false, showAll: false };
  },
  computed: {
    latest() {
      return this.summaries[0] || null;
    },
    others() {
      return this.summaries.slice(1);
    },
    html() {
      return this.render(this.latest && this.latest.summary);
    },
    actionHints() {
      const md = String(this.latest?.summary || '');
      return ['记录提示', '生活建议', '意外发现'].map(title => {
        const match = md.match(new RegExp(`^#{1,3}\\s*${title}\\s*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$)`, 'm'));
        const text = match?.[1]?.replace(/\*\*/g, '').replace(/^[\s>*-]+/, '').trim().split('\n')[0] || '';
        return { title, text: text.slice(0, 160) };
      }).filter(h => h.text && !/^(暂无|无建议|没有足够证据)/.test(h.text));
    },
    /** 超过一定长度才折叠，短回顾不该出现「展开全文」 */
    clamped() {
      const text = (this.latest && this.latest.summary) || '';
      return text.length > 260 || text.split('\n').length > 8;
    },
    providerLabel() {
      return PROVIDER_NAMES[this.provider] || this.provider || 'AI';
    }
  },
  watch: {
    selectedDate() {
      this.expanded = false;
      this.showAll = false;
    }
  },
  methods: {
    render(md) {
      try {
        return marked.parse(md || '', { breaks: true, renderer: safeRenderer });
      } catch (e) {
        return escapeHtml(md);
      }
    },
    timeRange(s) {
      const a = new Date(s.startTime || s.timestamp);
      const b = new Date(s.endTime || s.timestamp);
      const f = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (Number.isNaN(a.getTime())) return '';
      return `${f(a)} – ${f(b)}`;
    }
  }
};
</script>

<style scoped>
.ai-wrap {
  display: block;
}

/* ---------- 关闭态：一条细提示，不伪装成功能卡片 ---------- */
.ai-off {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-lg);
  border: 1px dashed var(--border-default);
  background: transparent;
}

.ai-off.is-warn {
  border-style: solid;
  border-color: var(--warning-soft);
  background: color-mix(in srgb, var(--warning-soft) 55%, transparent);
}

.ai-off-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--r-full);
  background: var(--bg-inset);
  color: var(--text-tertiary);
}

.ai-off.is-warn .ai-off-icon {
  color: var(--warning);
}

.ai-off-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.ai-off-text strong {
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}

.ai-off-text span {
  font-size: var(--fs-11);
  color: var(--text-tertiary);
  line-height: 1.5;
}

/* ---------- 可用态 ---------- */
.ai-card {
  border-color: var(--accent-border);
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--accent-soft) 55%, var(--bg-surface)),
      var(--bg-surface) 46%);
}

.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.ai-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}

.ai-title :deep(svg) {
  color: var(--accent);
}

.ai-chip {
  padding: 1px 6px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  font-size: var(--fs-10);
  font-weight: var(--fw-normal);
  color: var(--text-tertiary);
}

.ai-actions { display: grid; gap: 7px; margin-bottom: var(--sp-3); }
.ai-action { display: flex; gap: 9px; align-items: baseline; padding: 8px 10px; border-radius: var(--r-md); background: var(--bg-inset); font-size: var(--fs-12); line-height: 1.5; }
.ai-action strong { flex: none; color: var(--accent); font-weight: var(--fw-medium); }
.ai-action span { color: var(--text-secondary); }

.ai-body {
  position: relative;
}

.ai-body.is-clamped {
  max-height: 190px;
  overflow: hidden;
  mask-image: linear-gradient(180deg, #000 68%, transparent 100%);
}

.ai-body .md {
  font-size: var(--fs-13);
  line-height: 1.65;
  color: var(--text-secondary);
}

.ai-body .md :deep(h1),
.ai-body .md :deep(h2),
.ai-body .md :deep(h3) {
  margin: var(--sp-3) 0 var(--sp-1);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.ai-body .md :deep(h1:first-child),
.ai-body .md :deep(h2:first-child),
.ai-body .md :deep(h3:first-child) {
  margin-top: 0;
}

.ai-body .md :deep(p) {
  margin: 0 0 var(--sp-2);
}

.ai-body .md :deep(ul),
.ai-body .md :deep(ol) {
  margin: 0 0 var(--sp-2);
  padding-left: 18px;
}

.ai-body .md :deep(li) {
  margin-bottom: 2px;
}

.ai-body .md :deep(strong) {
  color: var(--text-primary);
  font-weight: var(--fw-medium);
}

.ai-body .md :deep(code) {
  padding: 1px 4px;
  border-radius: var(--r-xs);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--fs-11);
}

.ai-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

.ai-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.ai-more {
  margin-left: auto;
  font-size: var(--fs-11);
  color: var(--accent);
}

.ai-more + .ai-more {
  margin-left: 0;
}

.ai-more:hover {
  color: var(--accent-hover);
}

.ai-history {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--border-subtle);
  max-height: 420px;
  overflow-y: auto;
}

.ai-history-item .md {
  margin-top: 4px;
  font-size: var(--fs-12);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.ai-empty {
  margin: 0;
  font-size: var(--fs-12);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.spin {
  animation: ai-spin 900ms linear infinite;
}

@keyframes ai-spin {
  to { transform: rotate(360deg); }
}
</style>
