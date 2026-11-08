<template>
  <div class="settings">
    <div class="set-intro">
      <h2>设置</h2>
      <p>先调整外观与记录，再管理连接和扩展能力</p>
    </div>

    <div class="sec-nav">
      <button
        v-for="s in sections"
        :key="s.id"
        class="nav-chip"
        :class="{ active: section === s.id }"
        @click="goSection(s.id)"
      >{{ s.label }}</button>
    </div>

    <p class="group-title basic-group">基本设置 <span>界面、记录与数据</span></p>

    <!-- ---------------- 外观 ---------------- -->
    <section id="sec-appearance" class="sec">
      <div class="sec-head">
        <Icon name="palette" :size="13" />
        <span>外观</span>
        <button class="chev" :class="{ open: !folded.appearance }" title="展开 / 收起" @click="toggleFold('appearance')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.appearance" class="sec-body">
        <div class="row-block">
          <span class="row-label">主题风格<span class="row-desc">决定画布、卡片和文字的整体气质；分类色保持语义</span></span>
          <div class="surface-grid">
            <button v-for="s in surfaces" :key="s.id" class="surface-choice" :class="[s.id, { active: (ui.surface || 'nocturne') === s.id }]"
              :aria-pressed="(ui.surface || 'nocturne') === s.id" @click="$emit('surface-change', s.id)">
              <span class="surface-preview"><i></i><b></b><em></em></span>
              <strong>{{ s.label }}</strong><small>{{ s.hint }}</small>
            </button>
          </div>
        </div>
        <div class="row-block">
          <span class="row-label">明暗</span>
          <div class="mode-row">
            <button v-for="m in modes" :key="m.id" class="mode-cell" :class="[m.id, { active: theme === m.id }]" @click="$emit('theme-change', m.id)">
              <span class="mode-preview"><span class="mp-bar"></span><span class="mp-line"></span></span>
              <span class="mode-name">{{ m.label }}</span>
              <Icon v-if="theme === m.id" name="check" :size="11" class="mode-check" />
            </button>
          </div>
        </div>
        <div class="row-block">
          <span class="row-label">强调色</span>
          <div class="accent-row">
            <button v-for="a in accentOptions" :key="a.id" class="accent-cell" :class="{ active: accent === a.id }" :title="a.label" @click="$emit('accent-change', a.id)">
              <span class="accent-dot" :style="{ background: accentColor(a.id) }"><Icon v-if="accent === a.id" name="check" :size="10" /></span>
              <span class="accent-name">{{ a.label }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠</div>
    </section>

    <!-- ---------------- 首页与图表 ---------------- -->
    <section id="sec-dashboard" class="sec">
      <div class="sec-head">
        <Icon name="grid" :size="13" />
        <span>首页与图表</span>
        <button class="chev" :class="{ open: !folded.dashboard }" title="展开 / 收起" @click="toggleFold('dashboard')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.dashboard" class="sec-body">
        <div class="row">
          <span class="row-label">首页插件坞<span class="row-desc">在首页最底部显示四个插件状态方块</span></span>
          <div class="row-control">
            <label class="switch">
              <input type="checkbox" :checked="dashboard.showPluginDock !== false" @change="set('dashboard.showPluginDock', $event.target.checked)">
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="hr"></div>
        <div class="row" v-for="c in dashboardCards" :key="c.key">
          <span class="row-label">显示「{{ c.label }}」</span>
          <div class="row-control">
            <label class="switch">
              <input type="checkbox" :checked="cardOn(c.key)" @change="set('dashboard.cards.' + c.key, $event.target.checked)">
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="hr"></div>
        <div class="row">
          <span class="row-label">热力图周数<span class="row-desc">同时改变首页热力图的跨度与标题</span></span>
          <div class="row-control sm">
            <input type="number" min="4" max="52" :value="dashboard.heatmapWeeks || 12" @change="num('dashboard.heatmapWeeks', $event.target.value, 4, 52)">
            <span class="unit">周</span>
          </div>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠</div>
    </section>

    <!-- ---------------- 采集前隐私排除 ---------------- -->
    <section id="sec-privacy" class="sec">
      <div class="sec-head">
        <Icon name="shield" :size="13" />
        <span>隐私与采集</span>
        <button class="chev" :class="{ open: !folded.privacy }" title="展开 / 收起" @click="toggleFold('privacy')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.privacy" class="sec-body">
        <p class="sec-desc">以下规则在新片段形成前生效。命中时不写入应用名和窗口标题；已有历史记录不会自动删除。</p>
        <div class="row-block">
          <label class="row-label" for="exclude-apps">排除应用名</label>
          <textarea id="exclude-apps" class="rule-input" :value="monitoring.excludeApps || ''" rows="3" placeholder="每行一个，例如 bankapp.exe" spellcheck="false" @change="set('monitoring.excludeApps', $event.target.value)"></textarea>
          <p class="hint">与采集到的进程名完整匹配，不区分大小写；也可用逗号分隔。</p>
        </div>
        <div class="row-block">
          <label class="row-label" for="exclude-titles">排除标题关键词</label>
          <textarea id="exclude-titles" class="rule-input" :value="monitoring.excludeTitleContains || ''" rows="3" placeholder="每行一个，例如 客户资料" spellcheck="false" @change="set('monitoring.excludeTitleContains', $event.target.value)"></textarea>
          <p class="hint">标题包含任一关键词即排除，不区分大小写。请避免填写过短的通用词。</p>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠 · 管理新记录的隐私排除规则</div>
    </section>

    <!-- ---------------- 数据 ---------------- -->
    <section id="sec-data" class="sec">
      <div class="sec-head">
        <Icon name="database" :size="13" />
        <span>数据</span>
        <button class="chev" :class="{ open: !folded.data }" title="展开 / 收起" @click="toggleFold('data')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.data" class="sec-body">
        <div class="row-block">
          <span class="row-label">存储路径</span>
          <code class="path-box" :title="storagePath">{{ storagePath || '默认路径' }}</code>
          <div class="path-actions">
            <button class="btn btn-secondary btn-sm" @click="$emit('select-storage')">更改</button>
            <button v-if="config.storage && config.storage.customPath" class="btn btn-danger btn-sm" @click="$emit('reset-storage')">恢复默认</button>
          </div>
          <p class="hint">指向 iCloud / OneDrive / 坚果云 目录可实现跨设备同步；更改后立即生效，无需重启。</p>
        </div>
        <div class="row-block">
          <span class="row-label">导出</span>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" @click="$emit('export-day')"><Icon name="download" :size="12" /> 当日 JSON</button>
            <button class="btn btn-secondary btn-sm" @click="$emit('export-full-json')"><Icon name="download" :size="12" /> 全部 JSON</button>
            <button class="btn btn-secondary btn-sm" @click="$emit('export-csv')"><Icon name="download" :size="12" /> CSV</button>
          </div>
        </div>
        <div class="row-block">
          <span class="row-label">导入</span>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" @click="$emit('import-merge')"><Icon name="upload" :size="12" /> 合并</button>
            <button class="btn btn-danger btn-sm" @click="$emit('import-overwrite')"><Icon name="upload" :size="12" /> 覆盖</button>
          </div>
          <p class="hint">可选「完整导出 JSON 文件」或「数据目录」。选目录会直接切换过去并立即生效，不覆盖已有数据；「覆盖」仅对单文件导入生效。</p>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠</div>
    </section>

    <p class="group-title plugin-group">连接与能力 <span>关闭开关后，对应设置会收起</span></p>

    <!-- ---------------- 滴答同步 ---------------- -->
    <section id="sec-dida" class="sec plugin-sec">
      <div class="sec-head">
        <Icon name="refresh" :size="13" />
        <span>滴答同步</span>
        <span class="sec-badge" :class="{ on: didaOn }">{{ didaOn ? '已开启' : '已关闭' }}</span>
        <label class="switch">
          <input type="checkbox" :checked="didaOn" @change="set('dida.enabled', $event.target.checked)">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
        <button v-if="didaOn" class="chev" :class="{ open: !folded.dida }" title="展开 / 收起" @click="toggleFold('dida')">
          <Icon name="chevronDown" :size="13" />
        </button>
      </div>
      <div v-if="didaOn && !folded.dida" class="sec-body">
        <p class="sec-desc">拉取与推送是两条独立通道，各有自己的开关和同步间隔。</p>

        <div class="stat-grid">
          <div class="stat-item"><b>{{ didaStat.pulledTotal || 0 }}</b><span>累计拉取 · 条</span></div>
          <div class="stat-item"><b>{{ didaStat.pushedTotal || 0 }}</b><span>累计推送 · 条</span></div>
          <div class="stat-item"><b>{{ didaStat.todayFocusCount || 0 }}</b><span>今日专注 · {{ didaStat.todayFocusMinutes || 0 }} 分钟</span></div>
        </div>

        <div class="row">
          <span class="row-label">API 口令<span class="row-desc">网页版滴答 → 设置 → 账户与安全 → API 口令；只保存在本机</span></span>
          <div class="row-control wide">
            <input type="password" :value="dida.token" placeholder="未填写" autocomplete="off" @change="set('dida.token', $event.target.value)">
          </div>
        </div>

        <div class="hr"></div>
        <div class="sub-head">
          <span><strong>拉取专注</strong><em>把滴答的专注记录作为展示层第二层级</em></span>
          <label class="switch">
            <input type="checkbox" :checked="dida.pullFocus !== false" @change="set('dida.pullFocus', $event.target.checked)">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <template v-if="dida.pullFocus !== false">
          <div class="row">
            <span class="row-label">同步间隔</span>
            <div class="row-control sm">
              <input type="number" min="5" max="1440" step="5" :value="dida.pullIntervalMin || 30" @change="num('dida.pullIntervalMin', $event.target.value, 5, 1440)">
              <span class="unit">分钟</span>
            </div>
          </div>
          <div class="row">
            <span class="row-label">同步范围<span class="row-desc">超过 30 天会按月自动分页</span></span>
            <div class="row-control sm">
              <input type="number" min="1" max="365" :value="dida.syncDays || 30" @change="num('dida.syncDays', $event.target.value, 1, 365)">
              <span class="unit">天</span>
            </div>
          </div>
          <div class="row">
            <span class="row-label">启动时自动同步</span>
            <div class="row-control">
              <label class="switch">
                <input type="checkbox" :checked="dida.autoSyncOnStart !== false" @change="set('dida.autoSyncOnStart', $event.target.checked)">
                <span class="switch-track"><span class="switch-thumb"></span></span>
              </label>
            </div>
          </div>
          <div class="row">
            <span class="row-label">状态<span class="row-desc">{{ lastPullText }}</span></span>
            <div class="row-control">
              <button class="btn btn-primary btn-sm" :disabled="syncing.pull" @click="syncDida('pull')">{{ syncing.pull ? '同步中…' : '立即拉取' }}</button>
            </div>
          </div>
        </template>
        <div class="hr"></div>
        <div class="sub-head">
          <span><strong>推送展示层</strong><em>把标注写成滴答任务；默认关闭，不会写入任何内容</em></span>
          <label class="switch">
            <input type="checkbox" :checked="dida.pushEnabled === true" @change="set('dida.pushEnabled', $event.target.checked)">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div v-if="dida.pushEnabled === true">
          <p class="danger-note">这条通道会真的往滴答清单里创建任务。请先确认目标清单，评估好再开启。</p>
          <div class="row">
            <span class="row-label">推送间隔</span>
            <div class="row-control sm">
              <input type="number" min="5" max="1440" step="5" :value="dida.pushIntervalMin || 60" @change="num('dida.pushIntervalMin', $event.target.value, 5, 1440)">
              <span class="unit">分钟</span>
            </div>
          </div>
          <div class="row">
            <span class="row-label">目标清单 ID<span class="row-desc">留空时推送不会执行</span></span>
            <div class="row-control wide">
              <input type="text" :value="dida.pushProjectId" placeholder="滴答清单项目 ID" spellcheck="false" @change="set('dida.pushProjectId', $event.target.value)">
            </div>
          </div>
          <div class="row">
            <span class="row-label">状态<span class="row-desc">{{ lastPushText }}</span></span>
            <div class="row-control">
              <button class="btn btn-secondary btn-sm" :disabled="syncing.push" @click="syncDida('push')">{{ syncing.push ? '推送中…' : '立即推送' }}</button>
            </div>
          </div>
        </div>
        <p v-else class="hint">当前为「关闭」。两个方向相互独立，关掉推送不影响专注拉取。</p>
        <p v-if="didaStat.lastError" class="danger-note">{{ didaStat.lastError }}</p>
      </div>
      <div v-else-if="!didaOn" class="sec-collapsed">已关闭 · 开启后可配置拉取与推送通道</div>
    </section>

    <!-- ---------------- AI 能力 ---------------- -->
    <section id="sec-ai" class="sec plugin-sec">
      <div class="sec-head">
        <Icon name="zap" :size="13" />
        <span>AI 能力</span>
        <span class="sec-badge" :class="{ on: aiOn }">{{ aiOn ? '已开启' : '已关闭' }}</span>
        <label class="switch">
          <input type="checkbox" :checked="aiOn" @change="set('ai.enabled', $event.target.checked)">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
        <button v-if="aiOn" class="chev" :class="{ open: !folded.ai }" title="展开 / 收起" @click="toggleFold('ai')">
          <Icon name="chevronDown" :size="13" />
        </button>
      </div>
      <div v-if="aiOn && !folded.ai" class="sec-body">
        <p class="sec-desc">开启自动回顾后，后台按时间段增量评估记录。模型会看到相关应用名、窗口标题，以及人工解释与窗口重叠的线索；结果显示在首页 AI 回顾中。</p>
        <div class="row">
          <span class="row-label">自动评估与回顾<span class="row-desc">开启后才会定期发送记录；空时段不会调用模型</span></span>
          <div class="row-control"><label class="switch"><input type="checkbox" :checked="config.summary?.autoGenerate === true" @change="set('summary.autoGenerate', $event.target.checked)"><span class="switch-track"><span class="switch-thumb"></span></span></label></div>
        </div>
        <div v-if="config.summary?.autoGenerate === true" class="row">
          <span class="row-label">评估间隔<span class="row-desc">每段仅处理新增记录；建议 60–240 分钟</span></span>
          <div class="row-control sm"><input type="number" min="30" max="300" step="30" :value="config.summary?.intervalMinutes || 60" @change="num('summary.intervalMinutes', $event.target.value, 30, 300)"><span class="unit">分钟</span></div>
        </div>
        <div class="row-block">
          <span class="row-label">Token 用量<span class="row-desc">以最近一个间隔的记录估算单次输入；实际用量优先取服务商返回值</span></span>
          <p class="hint">{{ aiUsage.next?.records ? `参考单次约 ${aiUsage.next.inputTokens} 输入 Token + 最多 ${aiUsage.next.outputLimit} 输出 Token（${aiUsage.next.records} 条记录）` : '最近一个评估间隔没有已保存记录，暂不预计模型调用' }}。</p>
          <p class="hint">本机最近 {{ aiUsage.calls || 0 }} 次：输入 {{ aiUsage.inputTokens || 0 }}、输出 {{ aiUsage.outputTokens || 0 }} Token<span v-if="aiUsage.estimatedCalls">；其中 {{ aiUsage.estimatedCalls }} 次由字符数估算</span>。不同模型分词不同，估算仅供控制调用量。</p>
        </div>
        <div class="row">
          <span class="row-label">服务商</span>
          <div class="row-control">
            <select :value="api.provider" @change="$emit('provider-change', $event.target.value)">
              <option v-for="(preset, key) in providerPresets" :key="key" :value="key">{{ preset.name }}</option>
            </select>
          </div>
        </div>
        <div class="row">
          <span class="row-label">API Key</span>
          <div class="row-control wide">
            <input :value="api.apiKey" type="password" placeholder="sk-..." autocomplete="off" @change="set('api.apiKey', $event.target.value)">
          </div>
        </div>
        <div class="row-block">
          <span class="row-label">模型</span>
          <div class="model-chips">
            <button v-for="m in modelPresets" :key="m.id" class="chip" :class="{ active: api.modelName === m.id }" :title="m.note" @click="set('api.modelName', m.id)">{{ m.label }}</button>
          </div>
          <div class="row-control wide model-custom">
            <input type="text" :value="api.modelName" spellcheck="false" @change="set('api.modelName', $event.target.value)">
          </div>
          <p class="hint">deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用。当前推荐 deepseek-flash（V4.1 Flash），深度推理用 deepseek-v4-pro。</p>
        </div>
      </div>
      <div v-else-if="!aiOn" class="sec-collapsed">已关闭 · 开启后可配置模型与 API Key</div>
    </section>

    <!-- ---------------- 番茄钟 ---------------- -->
    <section id="sec-pomodoro" class="sec plugin-sec">
      <div class="sec-head">
        <Icon name="target" :size="13" />
        <span>本地专注</span>
        <span class="sec-badge" :class="{ on: pomodoroOn }">{{ pomodoroOn ? '已开启' : '已关闭' }}</span>
        <label class="switch">
          <input type="checkbox" :checked="pomodoroOn" @change="set('focus.enabled', $event.target.checked)">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
        <button v-if="pomodoroOn" class="chev" :class="{ open: !folded.pomodoro }" title="展开 / 收起" @click="toggleFold('pomodoro')">
          <Icon name="chevronDown" :size="13" />
        </button>
      </div>
      <div v-if="pomodoroOn && !folded.pomodoro" class="sec-body">
        <p class="sec-desc">本地专注计时。若专注数据全部来自滴答清单，可以直接关闭这个插件。</p>
        <div class="row">
          <span class="row-label">专注时长</span>
          <div class="row-control sm">
            <input type="number" min="5" max="120" step="5" :value="focus.pomodoro && focus.pomodoro.workMin" @change="num('focus.pomodoro.workMin', $event.target.value, 5, 120)">
            <span class="unit">分钟</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">休息时长</span>
          <div class="row-control sm">
            <input type="number" min="0" max="60" step="1" :value="focus.pomodoro && focus.pomodoro.breakMin" @change="num('focus.pomodoro.breakMin', $event.target.value, 0, 60)">
            <span class="unit">分钟</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">每组轮数</span>
          <div class="row-control sm">
            <input type="number" min="0" max="12" step="1" :value="focus.pomodoro && focus.pomodoro.rounds" @change="num('focus.pomodoro.rounds', $event.target.value, 0, 12)">
            <span class="unit">轮</span>
          </div>
        </div>
      </div>
      <div v-else-if="!pomodoroOn" class="sec-collapsed">已关闭 · 开启后可自定义计时</div>
    </section>

    <!-- ---------------- MCP 接口 ---------------- -->
    <section id="sec-bridge" class="sec plugin-sec">
      <div class="sec-head">
        <Icon name="plug" :size="13" />
        <span>MCP 接口</span>
        <span class="sec-badge" :class="{ on: bridgeOn }">{{ bridgeOn ? '运行中' : (bridgeEnabled ? '未启动' : '已关闭') }}</span>
        <label class="switch">
          <input type="checkbox" :checked="bridgeEnabled" :disabled="bridgeLoading" @change="$emit('bridge-toggle', $event.target.checked)">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
        <button v-if="bridgeEnabled" class="chev" :class="{ open: !folded.bridge }" title="展开 / 收起" @click="toggleFold('bridge')">
          <Icon name="chevronDown" :size="13" />
        </button>
      </div>
      <div v-if="bridgeEnabled && !folded.bridge" class="sec-body">
        <p class="sec-desc">把聚合后的工时数据开放给支持 MCP 的客户端，配一次即可用自然语言查询。</p>
        <div class="row">
          <span class="row-label">端口<span class="row-desc" v-if="bridgeOn">{{ bridge.url }}</span><span class="row-desc" v-else>端口被占用时会自动顺延</span></span>
          <div class="row-control">
            <input :value="bridgePortInput" type="number" min="1024" max="65535" class="port-input" @input="$emit('update:bridgePortInput', $event.target.value)">
            <button class="btn btn-secondary btn-sm" :disabled="bridgeLoading" @click="$emit('bridge-apply-port')">应用</button>
          </div>
        </div>
        <div class="row">
          <span class="row-label">访问 Token</span>
          <div class="row-control">
            <code class="token-box">{{ bridge ? bridge.token : '' }}</code>
            <button class="btn-icon" title="复制" @click="copy(bridge ? bridge.token : '', 'token')"><Icon :name="bridgeCopied === 'token' ? 'check' : 'copy'" :size="13" /></button>
            <button class="btn-icon" title="重新生成" :disabled="bridgeLoading" @click="$emit('bridge-regen')"><Icon name="refresh" :size="13" /></button>
          </div>
        </div>
        <div class="row">
          <span class="row-label">连通性</span>
          <div class="row-control">
            <button class="btn btn-secondary btn-sm" :disabled="bridgeTesting" @click="$emit('bridge-test')">{{ bridgeTesting ? '测试中' : '测试' }}</button>
            <button v-if="bridgeOn" class="btn btn-ghost btn-sm" @click="$emit('bridge-open')">打开 <Icon name="external" :size="11" /></button>
            <span v-if="bridgeTestResult" class="test-result" :class="{ ok: bridgeTestResult.ok }">{{ bridgeTestResult.ok ? 'HTTP ' + bridgeTestResult.statusCode : (bridgeTestResult.error || '失败') }}</span>
          </div>
        </div>
        <div class="mcp-box">
          <div class="mcp-head">
            <span>MCP 配置</span>
            <button class="btn btn-ghost btn-sm" @click="copy(bridge ? bridge.mcpConfig : '', 'mcp')"><Icon :name="bridgeCopied === 'mcp' ? 'check' : 'copy'" :size="11" /> {{ bridgeCopied === 'mcp' ? '已复制' : '复制' }}</button>
          </div>
          <pre class="mcp-pre">{{ bridge ? bridge.mcpConfig : '加载中…' }}</pre>
          <p class="hint">粘贴到客户端的 <code>mcp.json</code> 后重启。可用工具：日报告、区间报告、应用排行、关键词检索、时间线。</p>
        </div>
      </div>
      <div v-else-if="!bridgeEnabled" class="sec-collapsed">已关闭 · 本地数据服务已停止</div>
    </section>

    <!-- ---------------- 高级：内部技术参数 ---------------- -->
    <section id="sec-advanced" class="sec">
      <div class="sec-head">
        <Icon name="terminal" :size="13" />
        <span>运行与高级</span>
        <button class="chev" :class="{ open: !folded.advanced }" title="展开 / 收起" @click="toggleFold('advanced')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.advanced" class="sec-body">
        <p class="sec-desc">窗口运行、开机行为和采集参数。</p>
        <div class="row">
          <span class="row-label">最小化时显示浮窗</span>
          <div class="row-control"><label class="switch"><input type="checkbox" :checked="ui.floatWindow !== false" @change="set('ui.floatWindow', $event.target.checked)"><span class="switch-track"><span class="switch-thumb"></span></span></label></div>
        </div>
        <div class="row">
          <span class="row-label">开机自启动</span>
          <div class="row-control"><label class="switch"><input type="checkbox" :checked="autoLaunch" @change="$emit('toggle-auto-launch', $event.target.checked)"><span class="switch-track"><span class="switch-thumb"></span></span></label></div>
        </div>
        <div class="row">
          <span class="row-label">空闲判定阈值</span>
          <div class="row-control sm">
            <input :value="monitoring.idleThresholdSec" type="number" min="30" max="3600" step="30" @change="num('monitoring.idleThresholdSec', $event.target.value, 30, 3600)">
            <span class="unit">秒</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">最短片段</span>
          <div class="row-control sm">
            <input :value="monitoring.minSegmentSec" type="number" min="0" max="60" step="1" @change="num('monitoring.minSegmentSec', $event.target.value, 0, 60)">
            <span class="unit">秒</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">轮询间隔<span class="row-desc">仅在无法常驻采样的平台生效</span></span>
          <div class="row-control sm">
            <input :value="monitoring.interval" type="number" min="5" max="300" step="5" @change="num('monitoring.interval', $event.target.value, 5, 300)">
            <span class="unit">秒</span>
          </div>
        </div>
        <div class="row">
          <span class="row-label">Base URL<span class="row-desc">仅自定义服务商需要修改</span></span>
          <div class="row-control wide">
            <input :value="api.baseUrl" type="text" spellcheck="false" @change="set('api.baseUrl', $event.target.value)">
          </div>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠 · 内部技术参数</div>
    </section>

    <!-- ---------------- 诊断与关于 ---------------- -->
    <section id="sec-about" class="sec">
      <div class="sec-head">
        <Icon name="info" :size="13" />
        <span>诊断与关于</span>
        <span class="sec-badge">{{ logs.length }} 条日志</span>
        <button class="chev" :class="{ open: !folded.about }" title="展开 / 收起" @click="toggleFold('about')"><Icon name="chevronDown" :size="13" /></button>
      </div>
      <div v-if="!folded.about" class="sec-body">
        <div class="row">
          <span class="row-label">LifeLog<span class="row-desc">自动记录实际时间，结合滴答清单回顾生活与工作</span></span>
          <div class="row-control">
            <button class="btn btn-secondary btn-sm" :disabled="checkingUpdate" @click="$emit('check-update')">{{ checkingUpdate ? '检查中' : '检查更新' }}</button>
            <button v-if="updateInfo && updateInfo.hasUpdate" class="btn btn-primary btn-sm" @click="$emit('open-download')">v{{ updateInfo.latestVersion }}</button>
            <span v-else-if="updateInfo && !updateInfo.error" class="test-result ok">已是最新</span>
            <span class="tag">v{{ appVersion }}</span>
          </div>
        </div>
        <div class="log-toolbar">
          <button class="btn btn-ghost btn-sm" @click="$emit('open-logs')"><Icon name="folder" :size="12" /> 打开日志目录</button>
          <button class="btn btn-ghost btn-sm" @click="$emit('clear-logs')"><Icon name="trash" :size="12" /> 清空</button>
        </div>
        <div class="log-box">
          <div v-for="(l, i) in logs.slice(0, 200)" :key="i" class="log-line" :class="l.type">
            <span class="log-t">{{ l.time }}</span>
            <span class="log-m">{{ l.message }}</span>
          </div>
          <div v-if="!logs.length" class="log-empty">暂无日志</div>
        </div>
      </div>
      <div v-else class="sec-collapsed">已折叠</div>
    </section>

    <div class="set-foot">LifeLog v{{ appVersion }}</div>
  </div>
</template>
<script>
import Icon from '../components/Icon.vue';
import { accentSwatch, ACCENTS, MODES, SURFACES } from '../styles/accents.js';
import { DASHBOARD_CARDS, AI_MODELS } from '../plugins/registry.js';

export default {
  name: 'SettingsView',
  components: { Icon },
  props: {
    config: { type: Object, required: true },
    theme: { type: String, default: 'dark' },
    accent: { type: String, default: 'blue' },
    accentOptions: { type: Array, default: () => ACCENTS },
    activeSection: { type: String, default: 'appearance' },
    providerPresets: { type: Object, default: () => ({}) },
    aiUsage: { type: Object, default: () => ({}) },
    didaStatus: { type: Object, default: () => ({}) },
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
    storagePath: { type: String, default: '' }
  },
  emits: [
    'save', 'provider-change', 'toggle-auto-launch', 'theme-change', 'accent-change', 'surface-change',
    'select-storage', 'reset-storage',
    'export-day', 'export-full-json', 'export-csv', 'import-merge', 'import-overwrite',
    'bridge-toggle', 'bridge-apply-port', 'bridge-regen', 'bridge-test', 'bridge-copy', 'bridge-open',
    'update:bridgePortInput', 'add-schedule', 'remove-schedule',
    'check-update', 'open-download', 'clear-logs', 'open-logs', 'dida-sync'
  ],
  data() {
    return {
      // 注意：不能叫 activeSection —— 那会覆盖同名 prop，导致从首页跳分区永远失效
      section: this.activeSection || 'appearance',
      modes: MODES,
      surfaces: SURFACES,
      sections: [
        { id: 'appearance', label: '外观' },
        { id: 'dashboard', label: '首页' },
        { id: 'privacy', label: '隐私' },
        { id: 'data', label: '数据' },
        { id: 'dida', label: '滴答' },
        { id: 'ai', label: 'AI' },
        { id: 'pomodoro', label: '本地专注' },
        { id: 'bridge', label: 'MCP' },
        { id: 'advanced', label: '运行与高级' },
        { id: 'about', label: '诊断与关于' }
      ],
      // 插件相关默认展开，次要分区默认折叠
      folded: {
        pomodoro: true, ai: true, bridge: true, dida: true,
        dashboard: true, appearance: false, data: true, privacy: true, advanced: true, about: true
      }
    };
  },
  watch: {
    activeSection(val) {
      if (val) this.goSection(val);
    }
  },
  mounted() {
    this.$nextTick(() => this.scrollTo(this.section));
  },
  computed: {
    dashboardCards() { return DASHBOARD_CARDS; },
    modelPresets() { return AI_MODELS; },
    dida() { return this.config.dida || {}; },
    dashboard() { return this.config.dashboard || {}; },
    didaStat() { return this.didaStatus || {}; },
    didaOn() { return !!this.dida.enabled; },
    aiOn() { return !!(this.config.ai && this.config.ai.enabled); },
    pomodoroOn() {
      const v = this.config.focus && this.config.focus.enabled;
      return v === undefined ? true : !!v;
    },
    monitoring() { return this.config.monitoring || {}; },
    api() { return this.config.api || {}; },
    ui() { return this.config.ui || {}; },
    focus() { return this.config.focus || {}; },
    bridgeOn() { return !!this.bridge && this.bridge.running; },
    // 与首页插件坞读同一份配置，不再用 bridge 状态反推开关
    bridgeEnabled() {
      const v = this.config.bridge && this.config.bridge.enabled;
      return v === undefined ? true : !!v;
    },
    syncing() {
      const busy = this.didaStat.busy || {};
      return { pull: !!busy.pull, push: !!busy.push };
    },
    lastPullText() {
      const s = this.didaStat;
      if (!s.lastPullAt) return '尚未同步';
      return `上次 ${this.fmtTime(s.lastPullAt)} · 新增 ${s.lastPullCount || 0} 条`;
    },
    lastPushText() {
      const s = this.didaStat;
      if (!s.lastPushAt) return '尚未推送';
      return `上次 ${this.fmtTime(s.lastPushAt)} · 新增 ${s.lastPushCount || 0} 条`;
    }
  },
  methods: {
    /** 写入配置并持久化。path 支持 "dida.pullIntervalMin" */
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
    copy(text, tag) { this.$emit('bridge-copy', text, tag); },
    accentColor(id) { return accentSwatch(id, this.theme); },
    cardOn(key) {
      const cards = (this.config.dashboard && this.config.dashboard.cards) || {};
      return cards[key] === undefined ? true : !!cards[key];
    },
    toggleFold(id) { this.folded = { ...this.folded, [id]: !this.folded[id] }; },
    goSection(id) {
      this.section = id;
      this.$nextTick(() => this.scrollTo(id));
    },
    scrollTo(id) {
      const el = this.$el.querySelector(`#sec-${id}`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    fmtTime(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    syncDida(direction) { this.$emit('dida-sync', direction); }
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
.settings > .plugin-group { margin-top: var(--sp-3); }

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

.rule-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 70px;
  padding: var(--sp-3);
  resize: vertical;
  font: inherit;
  font-size: var(--fs-12);
  color: var(--text-primary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-radius: var(--r-md);
}

.rule-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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

/* AI 能力总开关 */
.ai-hero {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  transition: border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}

.ai-hero.on {
  border-color: var(--accent-border);
  background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg-inset));
}

.ai-hero-main {
  flex: 1;
  min-width: 0;
}

.ai-hero-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}

.ai-hero.on .ai-hero-title :deep(svg) {
  color: var(--accent);
}

.ai-hero-desc {
  margin: 4px 0 0;
  font-size: var(--fs-11);
  line-height: 1.6;
  color: var(--text-tertiary);
}

/* 开关 */
.switch {
  position: relative;
  display: inline-flex;
  flex: none;
  cursor: pointer;
}

.switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.switch-track {
  width: 40px;
  height: 22px;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--r-full);
  background: var(--bg-active);
  border: 1px solid var(--border-default);
  transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}

.switch-thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--r-full);
  background: var(--text-tertiary);
  transition: transform var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}

.switch input:checked + .switch-track {
  background: var(--accent);
  border-color: var(--accent);
}

.switch input:checked + .switch-track .switch-thumb {
  transform: translateX(18px);
  background: var(--on-accent);
}

.ai-model-hint {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}

/* 未开启时模型配置淡化，但不禁止填写——用户可以先把 Key 备好 */
.ai-model.is-off {
  opacity: 0.6;
  transition: opacity var(--dur-2) var(--ease);
}

.ai-model.is-off:hover {
  opacity: 1;
}

/* 明暗：两张缩略预览卡 */
.mode-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
  max-width: 320px;
}

.mode-cell {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}

.mode-cell:hover {
  border-color: var(--border-strong);
}

.mode-cell.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 小预览：一块底色 + 一条标题条 + 一条正文条 */
.mode-preview {
  width: 26px;
  height: 20px;
  flex: none;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-default);
}

.mode-cell.dark .mode-preview { background: #0b0c0e; }
.mode-cell.light .mode-preview { background: #f7f8fa; }

.mp-bar {
  display: block;
  height: 3px;
  width: 60%;
  border-radius: 2px;
}

.mode-cell.dark .mp-bar { background: #eceef2; }
.mode-cell.light .mp-bar { background: #0f172a; }

.mp-line {
  display: block;
  height: 2px;
  width: 90%;
  border-radius: 2px;
}

.mode-cell.dark .mp-line { background: rgba(236, 238, 242, 0.3); }
.mode-cell.light .mp-line { background: rgba(15, 23, 42, 0.25); }

.mode-name {
  font-size: var(--fs-12);
  color: var(--text-secondary);
}

.mode-cell.active .mode-name {
  color: var(--text-primary);
}

.mode-check {
  margin-left: auto;
  color: var(--accent);
}

.surface-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
.surface-choice {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  padding: var(--sp-2); text-align: left; color: var(--text-secondary);
  background: var(--bg-inset); border: 1px solid var(--border-default);
  border-radius: var(--r-md); cursor: pointer;
}
.surface-choice.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.surface-choice strong { font-size: var(--fs-12); color: var(--text-primary); }
.surface-choice small { font-size: var(--fs-10); line-height: 1.3; }
.surface-preview {
  display: flex; align-items: flex-end; gap: 4px; width: 100%; height: 36px;
  padding: 7px; margin-bottom: 4px; border-radius: var(--r-sm);
}
.surface-preview i { width: 7px; height: 100%; border-radius: 2px; background: rgba(255,255,255,.25); }
.surface-preview b { flex: 1; height: 100%; border-radius: 3px; background: rgba(255,255,255,.18); }
.surface-preview em { width: 25%; height: 65%; border-radius: 3px; background: rgba(255,255,255,.27); }
.nocturne .surface-preview { background: linear-gradient(135deg, #0d192b, #31557e); }
.linen .surface-preview { background: linear-gradient(135deg, #a77d51, #f3e6c9); }
.mist .surface-preview { background: linear-gradient(135deg, #2e544f, #d6eadc); }
@media (max-width: 600px) { .surface-grid { grid-template-columns: 1fr; } }

/* 强调色：一排圆点 */
.accent-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.accent-cell {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}

.accent-cell:hover {
  background: var(--bg-hover);
}

.accent-cell.active {
  border-color: var(--border-strong);
  background: var(--bg-inset);
}

.accent-dot {
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}

.accent-name {
  font-size: var(--fs-10);
  color: var(--text-secondary);
}

.accent-cell.active .accent-name {
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

/* ---------- 折叠式设置页 ---------- */
.sec-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--sp-4);
}
.nav-chip {
  padding: 5px 11px;
  border-radius: var(--r-full);
  font-size: var(--fs-12);
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid transparent;
}
.nav-chip:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-chip.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 24%, transparent);
}
.group-title {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.group-title span {
  font-size: var(--fs-11);
  font-weight: var(--fw-regular);
  color: var(--text-tertiary);
}
.plugin-sec .sec-head { gap: var(--sp-2); }
.sec-head .switch { margin-left: auto; }
.chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  margin-left: var(--sp-1);
  border-radius: var(--r-xs);
  color: var(--text-tertiary);
}
.chev:hover { background: var(--bg-hover); color: var(--text-primary); }
.chev svg { transition: transform var(--dur-1) var(--ease); }
.chev.open svg { transform: rotate(180deg); }
.sec-collapsed {
  padding: 10px var(--sp-5) 14px;
  font-size: var(--fs-12);
  color: var(--text-tertiary);
}
.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-bottom: var(--sp-2);
}
.sub-head strong {
  display: block;
  font-size: var(--fs-13);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.sub-head em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: var(--fs-11);
  color: var(--text-tertiary);
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.stat-item {
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: var(--bg-inset);
}
.stat-item b {
  display: block;
  font-size: var(--fs-20);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.stat-item span { font-size: var(--fs-11); color: var(--text-tertiary); }
.model-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip {
  padding: 5px 10px;
  border-radius: var(--r-full);
  font-size: var(--fs-12);
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
}
.chip:hover { color: var(--text-primary); }
.chip.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 26%, transparent);
}
.model-custom { margin-top: 4px; }
.danger-note {
  margin: var(--sp-2) 0;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-12);
  color: var(--danger);
  background: var(--danger-soft);
}
@media (max-width: 640px) {
  .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stat-item { padding: 8px; }
  .stat-item b { font-size: var(--fs-16); }
}
</style>
