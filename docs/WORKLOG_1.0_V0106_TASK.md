# WorkLog V0.10.6 任务书 — Electron 安全与本地数据边界加固

> 状态：**已规划，待范围确认后开发**
> 前置基线：`bf942e6`（V0.10.5 完成）
> 依据：`docs/WORKLOG_1.0_AUDIT.md`、`docs/WORKLOG_1.0_AUDIT_ROUND2.md`、本轮静态扫描实测
> 本轮只规划，未修改任何生产代码

---

## 一、版本目标

一次性完成 WorkLog 本地应用的安全边界治理，而不是把同一主题拆成多个过小版本。

三块内容：

| 组 | 主题 | 来源 |
|---|---|---|
| **A** | Electron 运行环境安全（S1-S6） | 审计 P1-02 |
| **B** | 本地数据与访问安全 | 原 V0.10.7 合并 |
| **C** | AI 隐私与数据出口 | 本轮新增 |

---

## 二、实测现状（非引用报告）

| 项 | 实际值 | 位置 |
|---|---|---|
| 窗口数 | 3 | main / focus / float |
| `nodeIntegration: true` | **3 处全部开启** | `main.js:200, 331, 491` |
| `contextIsolation: false` | **3 处全部关闭** | 同上 |
| `enableRemoteModule: true` | **1 处**（Electron 28 起已移除，无效） | `main.js:333` |
| IPC 通道注册 | **74 个** | 全在 `main.js` |
| 前端 `require('electron')` | **6 个文件** | App.vue、CompareCard、ProductivityOverview、WeeklyReview、SettingsView、TimelineView |
| 小窗加载方式 | `loadFile(focus.html)` / `loadFile(float.html)` | 非 Vue 应用 |
| `safeStorage` | **未使用** | — |
| 密钥存储 | 分文件（`config.local.json`）但**明文** | `configManager.js:212-213` |
| CORS `*` | **3 处** | `apiServer.js:31, 42, 126` |
| `openExternal` | **1 处**，token 拼进 URL | `main.js:1977` |
| AI 发送 `windowTitle` | **是** | `summarizer.js:201, 270, 507` |
| 隐私过滤 | `privacyRules.js` 仅 13 行，仅录制侧使用 | — |

---

## 三、安全权限矩阵（静态扫描核实）

> D-03 要求「必须经过完整静态调用扫描核实」。以下为**实测结果**，与 D-03 给定矩阵一致。

### 3.1 窗口角色

| 角色 | 窗口 | 加载源 | 最小能力 |
|---|---|---|---|
| `main` | mainWindow | Vue SPA (`dist/index.html`) | 全功能 |
| `focus` | focusWindow | `electron/focus.html` | 专注计时 |
| `float` | floatWindow | `electron/float.html` | 悬浮条 |

### 3.2 调用向（渲染层 → 主进程）

**focus.html 实测调用**：`focus-add-note`、`focus-end`、`focus-hud-expand`、`focus-toggle-pause`、`show-main-window`

**float.html 实测调用**：`get-float-bounds`、`save-float-width`、`set-float-pos`、`set-float-width`、`show-main-window`、`toggle-monitoring`

| 通道 | main | focus | float | 依据 |
|---|---|---|---|---|
| 其余 **64** 个通道 | ✅ | ❌ | ❌ | 仅主窗调用（静态扫描） |
| `show-main-window` | ✅ | ✅ | ✅ | 三窗均为「回到主界面」 |
| `toggle-monitoring` | ✅ | ❌ | ✅ | float.html 实测调用 |
| `focus-hud-expand` | ✅ | ✅ | ❌ | focus.html 实测调用 |
| `focus-toggle-pause` | ✅ | ✅ | ❌ | 同上 |
| `focus-end` | ✅ | ✅ | ❌ | 同上 |
| `focus-add-note` | ✅ | ✅ | ❌ | 同上 |
| `get-float-bounds` | ✅ | ❌ | ✅ | float.html 实测调用 |
| `set-float-pos` | ✅ | ❌ | ✅ | 同上 |
| `set-float-width` | ✅ | ❌ | ✅ | 同上 |
| `save-float-width` | ✅ | ❌ | ✅ | 同上 |

**合计**：64 + 1 + 1 + 4 + 4 = **74** ✅ 与实测通道数一致。

### 3.3 订阅向（主进程 → 渲染层）— D-03 未列，但必须纳入

D-03 第 7 条要求「重要事件订阅也按窗口角色设置白名单」。实测：

| 推送通道 | main | focus | float | 依据 |
|---|---|---|---|---|
| `focus-hud` | ✅ | ✅ | ❌ | focus.html `on` |
| `focus-theme` | ✅ | ✅ | ❌ | focus.html `on` |
| `float-accent` | ✅ | ❌ | ✅ | float.html `on` |
| `float-theme` | ✅ | ❌ | ✅ | float.html `on` |
| `float-update` | ✅ | ❌ | ✅ | float.html `on` |
| `float-monitoring-status` | ✅ | ❌ | ✅ | float.html `on` |
| `focus-state` / `focus-ended` | ✅ | ✅ | ❌ | 专注状态（主进程推送） |
| `data-changed` 等其余 10 个 | ✅ | ❌ | ❌ | 仅主窗订阅 |

### 3.4 校验策略

**默认拒绝**：未在矩阵中显式声明的通道，非 `main` 一律拒绝。

四项校验（D-03 第 3-5 条）：

1. **发送者身份** — `event.sender` 必须是已注册的窗口 `webContents`
2. **主 frame** — `event.senderFrame === event.sender.mainFrame`，拒绝 iframe
3. **页面 URL** — 与角色预期源一致（`file://.../focus.html` 等）
4. **参数校验** — 每个 handler 在主进程验证入参

**窗口销毁时清理注册信息**（D-03 第 8 条）：`closed` 事件里从 `roleRegistry` 移除。

---

## 四、实施计划（10 阶段，独立提交/回退）

### A 组：Electron 运行环境

| 阶段 | 内容 | 回退 | 验收 |
|---|---|---|---|
| **A1** | 新增 `electron/preload.js`，按角色暴露白名单 API；**暂不启用** | 删文件 | 行为零变化 |
| **A2** | 6 个前端文件改用 `window.worklog`，`require` 保留为降级 | 改回 | 调用全走 preload |
| **A3** | focus + float 关 `nodeIntegration`、开 `contextIsolation`、挂 preload | 改配置 | 计时窗/悬浮条完整 |
| **A4** | mainWindow 同上 | 改配置 | **全功能回归** |
| **A5** | 移除前端全部 `require('electron')` | 恢复 | 构建通过、grep 无残留 |
| **A6** | 74 通道 + 事件订阅按矩阵加校验 | 逐通道 | 越权测试全拒 |

**A1 关键设计**：preload 不暴露通用 `invoke(channel, ...)`（D-03 第 2 条禁止），而是**每个通道一个具名方法**。三个窗口加载不同 preload（或同一 preload 按 `process.argv` 角色裁剪）。

### B 组：本地数据与访问

| 阶段 | 内容 | 回退 | 验收 |
|---|---|---|---|
| **B1** | `safeStorage` 加密 + 明文兼容 + 原子迁移 | 保留明文备份 | 老配置可用，迁移后明文消失 |
| **B2** | `openExternal` 协议白名单（仅 https）+ 目标校验 | 恢复 | 非法协议被拒 |
| **B3** | CORS 收紧到 localhost/127.0.0.1 | 改回 `*` | 本地可用、外部被拒 |
| **B4** | 删除 `enableRemoteModule` | 加回 | 无行为变化 |

### C 组：AI 隐私出口

| 阶段 | 内容 | 回退 | 验收 |
|---|---|---|---|
| **C1** | 发送前二次过滤 + `ai.sendWindowTitle` 开关（默认 false） + `ai.sendAppName`（默认 true） | 关闭开关 | 标题原文不出现 |
| **C2** | 设置页展示实际发送的数据类型 | 纯 UI | 用户可见 |

**顺序约束**：A1→A2 前置；A3 先于 A4；A5 在 A2 之后；A6 最后（角色边界此时才清晰）。

---

## 五、配置加密迁移方案（按 D-02）

### 现状

- `config.json` — 已脱敏（apiKey/token 置空），可能被同步/备份
- `config.local.json` — **明文**存储 apiKey/token

### 加密可用性判定

```
available = safeStorage.isEncryptionAvailable()
若 Linux: 额外检查 safeStorage.getSelectedStorageBackend()
  basic_text → 视为安全工作不可用（不得描述为安全加密）
```

### 迁移流程（仅当加密可用）

```
1. 读 config.local.json
2. 对每个密钥:
   a. 已是 enc:v1: 前缀 → 跳过（已加密）
   b. 明文 → safeStorage.encryptString() → "enc:v1:" + base64
3. 写入临时文件 config.local.json.tmp
4. 原子 rename 替换
5. 读回并逐个解密验证
6. 全部验证成功 → 删除相应明文；任一失败 → 恢复备份，保留明文
```

### 加密不可用时（D-02 第 4-6 条）

| 行为 | 规则 |
|---|---|
| 已有明文密钥 | **保持原位置、原值**，不删除不清空不强制迁移 |
| 能否继续使用 | 可以，但设置页**必须提示仍以明文存储** |
| 新密钥 | 默认不允许静默明文落盘；用户明确确认风险后可明文保存，并持续提示 |
| **禁止** | 不得因安全存储不可用而清空配置或改变 AI 启用状态 |
| **禁止** | 不得自建「同目录明文密钥文件」伪加密方案 |

### 密文解不开时（D-02 第 9 条）

- **不得解释为空密钥**
- **不得覆盖原密文**
- 保留原值，报错，提示用户重新输入

---

## 六、AI 数据出口隐私方案（按 D-01）

### 默认值（D-01 确定，不得改动）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `ai.enabled` | **false** | 保持现状，AI 默认关闭 |
| `ai.sendAppName` | **true** | 仅在 `ai.enabled` 为 true 后生效 |
| `ai.sendWindowTitle` | **false** | 必须用户主动开启才发送标题 |

**缺字段一律按 `false` 处理**（D-01 第 5 条）。

### 统一执行点

所有 AI 请求入口共用同一个「构造请求体」函数，确保规则只有一处：

- 单日报告（`summarizer.js` 日摘要）
- 区间报告（`generate-summary-range`）
- 分类建议（`suggest-categories`、`get-annotation-suggestions`）
- 其他模型调用

### 发送前二次过滤（D-01 第 4 条）

```
即使读取阶段已过滤，发送前再跑一次 isExcludedSample：
  · 配置可能在读取与发送之间变化
  · 历史数据可能绕过录制侧过滤
历史记录同样遵守当前隐私规则
```

### 正文约束（D-01 第 2 条）

`ai.sendWindowTitle === false` 时，请求正文**不得包含窗口标题原文**——不是空字符串占位，是根本不出现该字段。

### 不做

- 不修改历史记录（D-01 第 6 条）
- 不改变 `ai.enabled` 默认关闭的产品决策

---

## 七、测试计划

### 自动测试

| 文件 | 覆盖 |
|---|---|
| `tests/preloadContract.test.cjs` | preload 暴露面 = 矩阵声明面；无通用 invoke |
| `tests/ipcPermissionMatrix.test.cjs` | 74 通道 × 3 角色全覆盖；默认拒绝；未登记通道被拒 |
| `tests/ipcSenderValidation.test.cjs` | 发送者身份 / mainFrame / URL / iframe 拒绝 |
| `tests/secureConfig.test.cjs` | 加密 / 解密 / 明文兼容 / 不可用降级 / basic_text / 密文损坏 |
| `tests/openExternalGuard.test.cjs` | 协议白名单、非 https 拒绝 |
| `tests/corsPolicy.test.cjs` | 允许 localhost、拒绝外部 Origin |
| `tests/aiPrivacyEgress.test.cjs` | AI 关闭 / 标题关闭 / 标题开启 / 隐私规则命中 / 历史记录 |

### 手工验收清单（D-03 最终验收要求）

不得以测试数量代替实际功能验证。逐项手工确认：

- [ ] 主窗：启动、录制、补录、时间线拖拽、日历、统计、热力图
- [ ] 主窗：设置保存、导出（日/全量/CSV）、导入、切换目录
- [ ] 主窗：AI 摘要（关闭状态 / 开启但标题关闭 / 开启且标题开启）
- [ ] 专注窗：启动、暂停、跳过、结束、备注、展开
- [ ] 悬浮窗：拖动、调宽、点击回主窗、监控开关
- [ ] 桥接页 / 滴答同步
- [ ] safeStorage 不可用时的设置页提示
- [ ] 密文损坏时的行为

---

## 八、回归风险与回退

| 风险 | 等级 | 缓解 |
|---|---|---|
| A4 主窗隔离导致功能失效 | **高** | 单独提交，立即回退该提交 |
| 前端漏改 `require` | 中 | A5 静态断言 + 构建拦截 |
| `safeStorage` 不可用环境 | 中 | 降级明文 + 提示，不阻断 |
| CORS 收紧后桥接失效 | 中 | 保留 localhost 全端口，手工验证 |
| AI 默认值变化影响用户 | 低 | 默认值按 D-01 固定，只增选项 |
| 小窗 preload 角色判定失败 | 中 | 用独立 preload 文件而非运行时推断 |

**回退粒度**：A 组每阶段独立 `git revert`；B/C 同理。A4 失败不影响 A1-A3 成果。

---

## 九、明确排除（本版本不做）

- 大规模 Vue 组件重构
- `main.js` 无关拆分
- 数据格式变更
- 历史记录批量修改
- `rid` / 去重 / 迁移机制调整
- 无关功能开发
- `atomicFile` 错误链修复（P2-01，留后续）
- 一般代码清理

---

## 十、待确认事项

1. 本任务书的阶段划分与提交粒度是否认可
2. 事件订阅白名单（3.3 节）是否纳入 A6（D-03 第 7 条要求纳入，此处确认范围）
3. `ai.sendAppName` 关闭时，`processName` 也不发送——是否需要提供「应用名脱敏」（如「应用 A / 应用 B」）作为中间选项

> 第 3 条不阻塞开发，可按「关闭即不发」实现，后续有需要再扩展。
