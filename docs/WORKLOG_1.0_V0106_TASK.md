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

**渲染入口共 8 个**（不是 6 个）：

| # | 入口 | 类型 |
|---|---|---|
| 1 | `src/App.vue` | Vue |
| 2 | `src/views/TimelineView.vue` | Vue |
| 3 | `src/views/SettingsView.vue` | Vue |
| 4 | `src/components/CompareCard.vue` | Vue |
| 5 | `src/components/ProductivityOverview.vue` | Vue |
| 6 | `src/components/WeeklyReview.vue` | Vue |
| 7 | `electron/focus.html` | 独立 HTML |
| 8 | `electron/float.html` | 独立 HTML |

| 阶段 | 内容 | 覆盖入口 | 回退 | 验收 |
|---|---|---|---|---|
| **A1** | 新增 preload（主窗角色），按白名单暴露具名 API；**暂不启用** | — | 删文件 | 行为零变化 |
| **A2** | 6 个 Vue 文件改走 `window.worklog`，`require` 保留为降级 | 1-6 | 改回 require | 调用全走 preload |
| **A3a** | 新增 focus / float 两个角色 preload；**先改 `focus.html`、`float.html` 使用 preload API**，此时两窗仍开 nodeIntegration | 7, 8 | 改回 require | 两窗功能完整 |
| **A3b** | 两窗关闭 `nodeIntegration`、开启 `contextIsolation`、挂对应 preload | 7, 8 | 改配置 | 计时窗/悬浮条完整 |
| **A4** | mainWindow 同上 | 1-6 | 改配置 | **全功能回归** |
| **A5** | 移除全部 8 个入口的 `require('electron')`，静态断言 grep 无残留 | **1-8** | 恢复 | 构建通过 |
| **A6** | 74 通道 + 事件订阅按矩阵加校验 | — | 逐通道 | 越权测试全拒 |

> **A3 必须拆成 a/b 两步**：直接关 nodeIntegration 而 HTML 页面还在 `require('electron')`，
> 页面会立刻白屏。先迁移调用，再关能力。

**A1 关键设计**：preload 不暴露通用 `invoke(channel, ...)`（D-03 第 2 条禁止），
而是**每个通道一个具名方法**。三个窗口使用三个独立 preload 文件，
避免运行时推断角色——推断错了就是权限错配。

**A1 关键设计**：preload 不暴露通用 `invoke(channel, ...)`（D-03 第 2 条禁止），而是**每个通道一个具名方法**。三个窗口加载不同 preload（或同一 preload 按 `process.argv` 角色裁剪）。

### B 组：本地数据与访问

| 阶段 | 内容 | 回退 | 验收 |
|---|---|---|---|
| **B1** | `safeStorage` 加密 + 明文兼容 + 原子迁移 | 保留明文备份 | 老配置可用，迁移后明文消失 |
| **B2** | `openExternal` 目标白名单（见 4·六）+ 桥接 Token 安全传递 | 恢复原调用 | 非法目标被拒、Token 不入 URL |
| **B3** | CORS 严格 Origin 解析 + 明确「CORS 不是认证」 | 改回 `*` | 本地可用、外部被拒 |
| **B4** | 删除 `enableRemoteModule` | 加回 | 无行为变化 |

### C 组：AI 隐私出口

| 阶段 | 内容 | 回退 | 验收 |
|---|---|---|---|
| **C1** | 发送前二次过滤 + `ai.sendWindowTitle` 开关（默认 false） + `ai.sendAppName`（默认 true） | 关闭开关 | 标题原文不出现 |
| **C2** | 设置页展示实际发送的数据类型 | 纯 UI | 用户可见 |

**顺序约束**：A1→A2 前置；A3 先于 A4；A5 在 A2 之后；A6 最后（角色边界此时才清晰）。

---

## 四·五、密钥返回边界（修订补充，最高优先）

### 实测确认的问题

```
main.js:824   ipcMain.handle('get-config', () => configManager.getConfig());
configManager.js:235   getConfig() { return this.config; }
```

**`get-config` 直接返回含明文 `api.apiKey` 与 `dida.token` 的完整配置对象。**
渲染层任何脚本（含将来可能引入的第三方代码、或页面被注入时）都能读到密钥。

`configManager.js:220-223` 的置空操作**只作用于写入 `config.json` 的那份副本**，
与渲染层拿到的对象无关。这一点必须在文档里写清楚，否则容易被误认为「已经脱敏」。

### 安全配置投影（B1 的强制要求）

新增 `configManager.getSafeConfig()`，`get-config` 只能返回它：

```
投影规则：
  api.apiKey       → 删除原文，改置 api.hasApiKey: boolean
  dida.token       → 删除原文，改置 dida.hasDidaToken: boolean
  其余字段          → 原样返回
```

**禁止**用空字符串代替原文——空串会让前端无法区分「没设过」和「设了但被隐藏」，
进而出现「保存设置时把已有密钥覆盖成空」这类事故。

### 密钥写入语义（避免空值覆盖）

`save-config` 收到前端回传的配置时：

| 前端传来的值 | 语义 | 后端行为 |
|---|---|---|
| 字段不存在 | 未修改 | **保留现有密钥** |
| `''`（空串） | 用户主动清除 | **清除密钥** |
| 非空字符串 | 用户设置新密钥 | 覆盖 |

**判定依据是「字段是否存在」而不是「值是否为空」**。这条规则必须写进测试，
因为它的失效方式是静默的：用户改个开关，密钥没了。

### 主动清除接口

提供 `clear-api-key` 与 `clear-dida-token` 两个独立通道，
语义明确、可审计，不必依赖「传空串」这个隐晦约定。

---

## 四·六、外部打开与桥接 Token 传递（修订补充）

### 为什么不能「一律只允许 https」

实测：桥接服务监听 `127.0.0.1` 上的**动态端口**，地址形如 `http://127.0.0.1:52873`。
它永远是 `http`，且端口每次启动不同。简单禁止 `http` 会直接废掉「打开桥接页」这个功能。

### 白名单规则

允许打开的目标，只限两类：

| 类型 | 规则 | 示例 |
|---|---|---|
| 本机桥接地址 | `http://127.0.0.1:<当前实际监听端口>` **精确匹配** | `http://127.0.0.1:52873/` |
| 外部 https | 仅 `https:` 协议 | 帮助文档链接 |

**明确拒绝**：

- 任意其他 `http://` 地址（含 `http://localhost:*`、`http://127.0.0.1:*` 的其他端口）
- `file:`、`javascript:`、`data:`、`vbscript:` 等协议
- 非字符串、空值、无法解析的 URL
- 端口不在当前监听端口的本机地址

**端口来源**：从 `apiServer.getStatus().port` 取，不从前端传。前端传端口等于让渲染层决定白名单。

### 桥接 Token 的泄漏风险

现状：`shell.openExternal(`${status.url}/?token=${status.token}`)`。

Token 出现在 URL 查询串里，会留下这些痕迹：

| 泄漏面 | 说明 |
|---|---|
| 浏览器历史 | 长期 Token 被持久化，用户下次输 `127.0.0.1` 时可能从历史联想出来 |
| Referer | 桥接页若引用任何外部资源，`Referer` 会带出完整 URL |
| 地址栏 / 截图 | 用户截图反馈问题时 Token 一并泄漏 |
| 扩展 / 剪贴板 | 浏览器扩展可读当前 URL |

### 安全传递方案（本版本实施）

**方案：改为一次性短票据换长期 Token**

```
1. 主进程生成一次性码（otc）：
     · 随机 32 字节，有效期 60 秒，绑定端口
     · 存入内存 Map，用过即删（single-use）
2. openExternal 打开 http://127.0.0.1:<port>/?otc=<一次性码>
3. 桥接页加载后，用 otc 调 POST /auth/exchange 换取实际 token
     · 主进程校验 otc：存在、未过期、未使用
     · 校验通过 → 返回 token，并立即删除 otc
4. 桥接页把 token 存在 sessionStorage（关标签页即失效）
```

**为什么这样能降低风险**：URL 里只有 60 秒有效的一次性码，用完即废。
被历史记录、截图、Referer 带走的都是废码。长期 Token 不再出现在任何 URL 中。

**兼容性**：桥接页是应用自己提供的，可同步改造。若外部工具直接用
`?token=` 访问，保留该方式一个版本并在下一版移除（记录在案）。

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

### 迁移流程（仅当加密可用）—— 五步，任何一步失败都保留原始配置

```
步骤 0  备份
        把 config.local.json 复制为 config.local.json.bak-<时间戳>
        备份失败 → 整个迁移中止，不做任何改动

步骤 1  生成临时密文（不落盘到正式位置）
        对每个明文密钥：
          · 已有 enc:v1: 前缀 → 跳过
          · safeStorage.encryptString() → "enc:v1:" + base64
        写入 config.local.json.tmp

步骤 2  验证临时密文
        读回 .tmp，对每个 enc:v1: 值执行 decryptString()
        与原始明文逐字符比对
        任一不匹配 → 删除 .tmp，保留原文件，报错退出

步骤 3  原子替换
        fs.renameSync(.tmp → config.local.json)
        失败 → 保留原文件与原备份，报错退出

步骤 4  最终验证
        重新从正式文件读取，再次解密并比对
        成功 → 完成，保留 .bak 供用户手动回退
        失败 → 从 .bak 恢复，报错退出
```

**四条不可违反的约束**：

| 约束 | 原因 |
|---|---|
| 备份必须先于任何写入 | 没有备份就无法「失败时保留原始配置」 |
| 验证必须读回真实文件 | 只验证内存中的密文，无法发现写入被截断 |
| 明文只在最终验证通过后才算迁移完成 | 中途失败不能留下「一半加密一半明文」 |
| `.bak` 不自动删除 | 用户需要能自己回退 |

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

## 五·五、CORS 收紧的边界（修订补充）

### 核心前提：CORS 不是身份验证

CORS 是**浏览器**的同源策略执行机制，它只约束「浏览器里的脚本能不能读响应」。
它**不能**阻止：

- 非浏览器客户端（curl、脚本）直接发请求——它们根本不看 CORS 头
- 已经拿到 Token 的攻击者

**所以 CORS 收紧只是「减少浏览器端被跨站读取」的一层，真正的认证必须靠 Token。**
这一条要写进代码注释，避免将来有人以为设好了 CORS 就安全了。

### 严格 Origin 解析（不用字符串包含判断）

```
错误写法：origin.includes('localhost')     ← http://evil-localhost.com 也会通过
错误写法：origin.startsWith('http://127.') ← http://127.0.0.1.evil.com 也会通过
```

正确做法：`new URL(origin)` 解析后逐项比对

| 检查项 | 允许值 |
|---|---|
| protocol | `http:` |
| hostname | `127.0.0.1` 或 `localhost` **精确相等** |
| port | 空（默认 80）或白名单端口 |
| 无凭据 | `username` / `password` 必须为空 |

解析失败（非法 URL）→ 拒绝。

### Token 验证仍是唯一认证

| 层 | 作用 | 不能替代什么 |
|---|---|---|
| CORS | 减少浏览器跨站读取 | 不能阻止 curl |
| Token | **真正的认证** | — |
| 绑定 127.0.0.1 | 阻止局域网访问 | 不能阻止本机其他进程 |

三者叠加，缺一不可。

### 必测的边界用例

| 用例 | 期望 |
|---|---|
| `Origin: http://localhost:5173` | 允许 |
| `Origin: http://127.0.0.1:5173` | 允许 |
| `Origin: http://evil-localhost.com` | **拒绝**（包含判断会误放） |
| `Origin: http://127.0.0.1.evil.com` | **拒绝**（前缀判断会误放） |
| `Origin: https://localhost` | 拒绝（协议不符） |
| `Origin: null` | 拒绝 |
| 无 `Origin` 头（curl） | 不做 CORS 判断，但**仍要校验 Token** |
| `Origin: http://user:pass@127.0.0.1` | 拒绝（含凭据） |

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

`ai.sendAppName === false` 时，**完全不发送 `processName`**。

**本版本不做匿名映射**（如「应用 A / 应用 B」）。理由：映射表本身就是信息——
应用数量、切换频率、时段分布仍然可推断，却让用户以为自己被完全匿名了。
要做匿名就要做到不可逆且无序号，那是另一个设计问题，不在本版本。

关闭即不发，语义最直白，也最容易验证：**测试直接断言请求正文里不出现该字符串**。

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

## 十、范围确认状态

**已确认，无待决事项。**

- 版本范围：一个完整版本、10 个阶段（A1/A2/A3a/A3b/A4/A5/A6 + B1-B4 + C1/C2）
- 事件订阅白名单：**已纳入 A6**（D-03 第 7 条）
- `ai.sendAppName = false`：完全不发送 `processName`，**本版本不做匿名映射**

后续各阶段由 Agent 自主完成，仅在出现新的产品决策冲突、不可逆数据风险
或重大范围变化时暂停确认。
