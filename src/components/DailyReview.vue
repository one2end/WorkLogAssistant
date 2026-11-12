<template>
  <section class="card review-card">
    <div class="card-head review-head">
      <div class="review-title">
        <span class="card-title">每日复盘</span>
        <span class="head-note">{{ isToday ? '今天' : selectedDate }} · 本地统计生成</span>
      </div>
      <div class="review-actions">
        <button class="btn btn-ghost btn-sm" @click="toggle">
          {{ open ? '收起' : '展开' }}
        </button>
      </div>
    </div>

    <!-- 收起状态：只给一句话摘要，不占地方 -->
    <p v-if="!open" class="review-peek" @click="toggle">
      {{ peekText }}
    </p>

    <template v-else>
      <div v-if="loading" class="review-empty">正在整理这一天…</div>

      <div v-else-if="error" class="review-error">
        <span>{{ error }}</span>
        <button class="btn btn-secondary btn-sm" @click="load">重试</button>
      </div>

      <template v-else>
        <ul v-if="warnings.length" class="review-warnings">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>

        <!-- 可编辑：草稿是起点，不是结论。用户改过的内容优先于重新生成。 -->
        <textarea
          v-model="draft"
          class="review-editor"
          spellcheck="false"
          :readonly="!editable"
          @input="dirty = true"
        ></textarea>

        <div class="review-footer">
          <div class="review-footer-left">
            <button class="btn btn-secondary btn-sm" :disabled="!draft" @click="copy">
              {{ copied ? '已复制' : '复制 Markdown' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="!dirty" @click="reset">
              还原为生成结果
            </button>
          </div>
          <div class="review-footer-right">
            <span v-if="dirty" class="dirty-hint">已修改（未保存到记录）</span>
            <button class="btn btn-ghost btn-sm" :disabled="loading" @click="load">
              重新生成
            </button>
          </div>
        </div>

        <!-- 有 AI 且开启了，才提供「明天建议」；关掉 AI 时这里不出现 -->
        <div v-if="canSuggest" class="review-suggest">
          <button class="btn btn-ghost btn-sm" :disabled="suggesting" @click="requestSuggestion">
            {{ suggesting ? '正在生成…' : '让 AI 补充「明天最重要的一件事」' }}
          </button>
          <p v-if="suggestionError" class="review-error-text">{{ suggestionError }}</p>
          <div v-if="suggestion" class="suggest-body">
            <p>{{ suggestion }}</p>
            <button class="btn btn-ghost btn-sm" @click="appendSuggestion">追加到草稿</button>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>

<script>
import { ipc } from '../utils/ipc.mjs';

export default {
  name: 'DailyReview',
  props: {
    selectedDate: { type: String, required: true },
    /** AI 是否可用：不可用时连入口都不显示，避免点了报错 */
    aiEnabled: { type: Boolean, default: false },
    aiReady: { type: Boolean, default: false },
    /** 是否默认展开。首页默认收起——复盘是收尾动作，不是打开就看的东西 */
    defaultOpen: { type: Boolean, default: false }
  },
  data() {
    return {
      open: this.defaultOpen,
      loading: false,
      error: '',
      generated: '',
      draft: '',
      dirty: false,
      warnings: [],
      copied: false,
      requestId: 0,
      suggesting: false,
      suggestion: '',
      suggestionError: ''
    };
  },
  computed: {
    isToday() {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return today === this.selectedDate;
    },
    editable() { return true; },
    canSuggest() { return this.aiEnabled && this.aiReady; },
    peekText() {
      if (this.loading) return '正在整理这一天…';
      if (this.error) return '生成失败，点击展开查看原因';
      if (!this.generated) return '点击展开，生成今天的复盘草稿';
      // 摘要取第一段「今天做了什么」的首条，足够让人判断值不值得展开
      const lines = this.generated.split('\n');
      const i = lines.findIndex(l => l.startsWith('### 今天做了什么'));
      const first = i >= 0 ? lines.slice(i + 1).find(l => l.trim().startsWith('-')) : null;
      return first ? first.replace(/^-\s*/, '今天：') : '点击展开查看完整复盘';
    }
  },
  watch: {
    // 换日期就重新生成，但不要自动展开——用户可能只是在浏览历史
    selectedDate: { immediate: true, handler() { if (this.open) this.load(); else this.loadedFor = ''; } }
  },
  methods: {
    toggle() {
      this.open = !this.open;
      // 首次展开时才生成：默认收起的情况下不该为每一天都跑一次统计
      if (this.open && this.loadedFor !== this.selectedDate) this.load();
    },
    async load() {
      const id = ++this.requestId;
      this.loading = true;
      this.error = '';
      this.copied = false;
      try {
        const res = await ipc.invoke('get-daily-review', { date: this.selectedDate });
        if (id !== this.requestId) return;
        if (!res || !res.ok) {
          this.error = (res && res.error) || '生成失败';
          return;
        }
        this.generated = res.markdown || '';
        // 只有没被用户改过时才覆盖，否则重新生成会把编辑内容抹掉
        if (!this.dirty) this.draft = this.generated;
        this.warnings = res.warnings || [];
        this.loadedFor = this.selectedDate;
      } catch (e) {
        if (id === this.requestId) this.error = e.message || '生成失败';
      } finally {
        if (id === this.requestId) this.loading = false;
      }
    },
    reset() {
      this.draft = this.generated;
      this.dirty = false;
    },
    async copy() {
      if (!this.draft) return;
      try {
        await navigator.clipboard.writeText(this.draft);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 2000);
      } catch (_) {
        // 复制失败要说出来，静默失败会让人以为已经复制了
        this.error = '复制失败，请手动选中文本复制';
      }
    },
    async requestSuggestion() {
      this.suggesting = true;
      this.suggestionError = '';
      try {
        const res = await ipc.invoke('suggest-next-action', { date: this.selectedDate, draft: this.draft });
        if (res && res.ok && res.text) this.suggestion = res.text;
        else this.suggestionError = (res && res.error) || 'AI 没有返回内容';
      } catch (e) {
        this.suggestionError = e.message || 'AI 调用失败';
      } finally {
        this.suggesting = false;
      }
    },
    appendSuggestion() {
      if (!this.suggestion) return;
      this.draft = `${this.draft}\n\n### 明天最重要的一件事\n${this.suggestion}\n`;
      this.dirty = true;
      this.suggestion = '';
    }
  }
};
</script>

<style scoped>
.review-card { grid-column: 1 / -1; }
.review-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.review-title { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.review-peek {
  margin: var(--sp-2) 0 0;
  color: var(--text-secondary);
  font-size: var(--fs-11);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.review-peek:hover { color: var(--text-primary); }
.review-empty { padding: var(--sp-5); text-align: center; color: var(--text-tertiary); font-size: var(--fs-11); }
.review-error { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); color: var(--danger, #e06060); font-size: var(--fs-11); }
.review-error-text { margin: var(--sp-2) 0 0; color: var(--danger, #e06060); font-size: var(--fs-10); }
.review-warnings {
  margin: var(--sp-2) 0;
  padding: var(--sp-2) var(--sp-3) var(--sp-2) 24px;
  border-radius: var(--r-sm);
  background: rgba(224, 160, 64, 0.08);
  color: var(--text-secondary);
  font-size: var(--fs-10);
  line-height: 1.6;
}
.review-editor {
  width: 100%;
  min-height: 260px;
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--text-primary);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.75;
  resize: vertical;
}
.review-editor:focus { outline: none; border-color: var(--border-strong, #3a3a3a); }
.review-footer {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-3); margin-top: var(--sp-2); flex-wrap: wrap;
}
.review-footer-left, .review-footer-right { display: flex; align-items: center; gap: var(--sp-2); }
.dirty-hint { color: var(--warning, #d09a4a); font-size: var(--fs-10); }
.review-suggest { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border-subtle); }
.suggest-body { margin-top: var(--sp-2); font-size: var(--fs-11); line-height: 1.7; color: var(--text-secondary); }
@media (max-width: 620px) {
  .review-footer { flex-direction: column; align-items: stretch; }
  .review-footer-left, .review-footer-right { justify-content: space-between; }
}
</style>
