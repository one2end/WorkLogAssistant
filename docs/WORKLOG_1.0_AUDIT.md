# WorkLog 1.0 工程基线审计报告

> 版本：V0.10.1（工程基线审计与测试准备）
> 分支：`worklog-1.0-dev`
> 审计基线提交：`f1b612c`（master，v0.10.0）
> 审计日期：2026-11-12
> 性质：只读审计 + 补充测试。本次不修改任何生产代码、不改数据格式、不动 15 分钟规则。

> ## ⚠️ 本报告已被第二轮审查修订
>
> 第二轮独立审查（`docs/WORKLOG_1.0_AUDIT_ROUND2.md`）核实本报告后，发现 **1 个被完全遗漏的 P0 问题**、**2 处结论错误**、**1 处建议错误**、**测试质量结论过于乐观**。本文已在对应位置插入 `【第二轮修订】` 标注。
>
> **以第二轮报告为准的地方**：问题严重度分级、去重方案、安全结论、测试分类、开发路线图。
>
> 最重要的更正：**覆盖导入会永久删除全部原始自动采集记录**（`clearActivities()` → `unlinkSync`，无备份、不进回收站）。这是本报告完全漏掉的，现列为 P0-01。

> ## ✅ 四项产品决策已确认（2026-11-12）
>
> | 决策 | 结论 |
> |---|---|
> | D-01 覆盖导入 | **取消危险入口**，保留合并导入，普通导入不得清空原始记录；恢复备份单独立项 |
> | D-02 15 分钟规则 | 起止**分别就近吸附**，时长 = 吸附后结束 − 开始，**不再单独取整**；最短 15 分钟（**不足即拒绝**）；重叠需提示 |
> | D-03 记录标识 | 新记录 UUID `rid` 落盘；**不批量改写历史**；旧数据仅兼容定位；只有确认同一副本才去重 |
> | D-04 版本拆分 | V0.10.2a（迁移幂等）+ V0.10.2b（导入安全），独立提交/测试/验收 |
>
> **详细实施方案见 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md`（第 4 版，最终方案）。**

> ## ✅ v4 最终方案要点（2026-11-12 01:41）
>
> 第四轮审查后，实施计划升级到 v4。与本报告相关的变化：
>
> | 主题 | v4 结论 |
> |---|---|
> | 迁移状态 | 引入**显式状态机**，`done`/`rolledback`/`conflict`/`failed` 为终态，重启不自动重跑、不自动重试 |
> | 回滚保护 | 回滚前**逐文件比对 SHA256**，含迁移后新数据的文件只隔离不覆盖 |
> | 源文件保护 | 改名前**重新校验源 SHA**，变化则拒绝改名并标记 conflict |
> | 写入锁 | 下沉到 `StorageManager` 数据层，覆盖 **13 个写方法 + `flush()` 非 IPC 路径**；明确「应用内锁防不了外部进程，必须保留 SHA 检测」 |
> | 导入续传 | 引入 `imp.batch + imp.idx` 写入身份；**明确不承诺 exactly-once** |
> | 测试矩阵 | **47 个测试条目**，故障注入 **22 点**（活动 11 + 摘要 11） |
>
> **一以贯之的原则：宁可停止、提示人工处理，也不静默丢失、覆盖或重复累计。**

---

## 零、结论摘要

先说最重要的四条：

1. **记录层只读是真的做到了。** `StorageManager.layerOf()` 以 `source` 字段判定层级，`updateDisplayRecord` 对记录层直接返回错误。已补 5 条测试锁定，全部通过。
2. **15 分钟规则目前有 7 处独立实现，取整策略不一致。** 最直接的后果：用户填 09:14 补记，保存后变成 09:00；填 22 分钟，保存成 15 分钟。
3. **安全基线偏弱。** 三个窗口全部 `nodeIntegration: true` + `contextIsolation: false`，没有 preload，73 个 IPC 通道无来源校验。当前不构成即时攻击面（只加载本地文件），但它是所有后续安全改造的前置阻塞项。【第二轮修订】`enableRemoteModule` 在 Electron 28 已移除，是**无效选项**，安全影响为零，不应与风险并列。
4. **数据层有两个真实的重复累计风险。** 旧版 JSON 导入无去重键（同一文件导两次就翻倍）；iCloud 冲突副本与主文件同存时会读成两条。

【第二轮新增】5. **覆盖导入会删除全部原始记录**（P0）。`clearActivities()` 用 `unlinkSync` 删除 `activities/` 下所有 `.json` 与 `.jsonl`，不分记录层/展示层，无备份、不进回收站。实测已确认。

测试基线：**109/109 通过**（原有 95 + 新增 14），lint 0 告警，构建成功。【第二轮修订】其中**约 9 条不是契约测试**：`manualSnap.test.cjs` 5 条复刻了算法而非调用生产函数（假绿），`duplicateImport.test.cjs` 2 条锁定的是已知错误行为。真正有契约价值约 100 条。详见第二轮报告第二节。

---

## 一、当前架构

### 1.1 技术栈（取自 `package.json`）

| 项 | 值 |
|---|---|
| name / version | `worklog-assistant` / `0.10.0` |
| 入口 | `electron/main.js` |
| 运行时依赖 | `axios`、`marked`、`vue` 三个 |
| 开发依赖 | `vite`、`electron`、`electron-builder`、`eslint`、`@vitejs/plugin-vue`、`concurrently`、`cross-env`、`wait-on` |
| Electron | 28.3.3（`node_modules/electron/path.txt`） |
| 测试框架 | Node 内置 `node --test`（无第三方测试库） |

依赖面很窄，这符合「不随意更换依赖」的原则，也说明技术债主要不在依赖上，而在自研代码的组织方式。

### 1.2 进程与窗口

单主进程 + 三个渲染进程窗口，全部通过 `loadFile` 加载本地文件：

| 窗口 | 创建位置 | 用途 | webPreferences |
|---|---|---|---|
| 主窗口 `mainWindow` | `main.js:290` | 今日概览 / 时间线 / 设置 | `nodeIntegration: true`, `contextIsolation: false`, `enableRemoteModule: true` |
| 计时小窗 `focusWindow` | `main.js:154` | 番茄钟 HUD | `nodeIntegration: true`, `contextIsolation: false` |
| 悬浮条 `floatWindow` | `main.js:448` | 常驻悬浮控制条 | `nodeIntegration: true`, `contextIsolation: false` |
| 专注全屏页 `focus.html` | `main.js:172` / `main.js:465` | 由上述两窗口加载 | 继承窗口配置 |

**没有 preload 脚本，也没有使用 `contextBridge`。** 前端直接 `require('electron')`（见 `src/App.vue:199`）。

### 1.3 代码规模（`wc -l` 实测）

主进程合计 **9885 行**，前端合计约 **11200 行**。

主进程最大的三个文件：

| 文件 | 行数 | 职责 |
|---|---|---|
| `electron/analytics.js` | 1938 | 日/区间报告、槽位占用、分类归并、线程聚合 |
| `electron/main.js` | 1799 | 应用生命周期、73 个 IPC 通道、窗口管理、补录校验 |
| `electron/storageManager.js` | 950 | JSONL 读写、展示层编辑、目录迁移 |

前端最大的三个文件：

| 文件 | 行数 | 风险提示 |
|---|---|---|
| `src/views/TimelineView.vue` | 3173 | 单文件过大，拖拽/吸附/拆分逻辑与模板混在一起 |
| `src/views/SettingsView.vue` | 1686 | 单文件过大 |
| `src/views/TodayView.vue` | 1624 | 单文件过大 |
| `src/App.vue` | 1539 | 承担了全局状态 + IPC 调用 + 跨组件编排 |

其余模块：`didaSync.js`（816，滴答同步）、`summarizer.js`（541，AI 摘要）、`apiServer.js`（449，本地 HTTP）、`focusManager.js`（364）、`activityRecorder.js`（323）、`configManager.js`（315）、`screenshotManager.js`（294）、`windowMonitor.js`（292）、`planManager.js`（273）、`arhatManager.js`（262）。

小模块：`atomicFile.js`（60）、`fileMigration.js`（38）、`aiReview.js`（36）、`annotationAdvisor.js`（35）、`timeSplit.js`（16）、`timeBalance.js`（16）、`privacyRules.js`（13）。

### 1.4 数据流

```
windowMonitor（PowerShell 常驻采样，1 秒）
        ↓ sample
activityRecorder（切分片段、休眠截断、5 分钟 checkpoint）
        ↓ 片段批量
storageManager.appendActivityRecords()
        ↓ 追加写
Data/activities/YYYY-MM-DD.jsonl   ← 记录层（source 缺省或 recorded）
Data/activities/YYYY-MM-DD.jsonl   ← 展示层（source=manual/dida/uptimer）同文件混写
        ↓
analytics.buildDayReport() → 按 source 优先级合并 → 槽位占用 → 分类统计
        ↓ IPC
App.vue → TodayView / TimelineView / SettingsView
```

关键设计：**记录层与展示层共用一个 JSONL 文件**，靠 `source` 字段区分。这是所有「能不能改」判断的唯一依据（`storageManager.js:415`）。

### 1.5 数据目录结构

```
%APPDATA%/worklog-assistant/
├── config.json           ← 非敏感配置（apiKey / dida.token 置空）
├── config.local.json     ← 敏感配置（apiKey、dida.token），明文
└── Data/
    ├── activities/YYYY-MM-DD.jsonl   （记录层 + 展示层混写）
    ├── activities/YYYY-MM-DD.json    （旧版格式，仍会被读取和写入）
    ├── summaries/YYYY-MM-DD.json
    ├── summaries_md/
    ├── screenshots/
    ├── logs/app_log_YYYY-MM-DD.log
    └── dida/sync-status.json
```

支持自定义数据目录（`storage.customPath`），会整体切换到该目录。**这一点是历史卡死事故的来源**（见 4.6）。

---

## 二、现有功能清单

按代码实际能力整理，不按 README 描述。

### 2.1 记录

| 能力 | 实现位置 | 状态 |
|---|---|---|
| 前台窗口自动采样 | `windowMonitor.js`（PowerShell 常驻进程） | 可用 |
| 空闲判定 | `activityRecorder.js:162`，默认 3 分钟阈值 | 可用 |
| 休眠/唤醒截断 | `activityRecorder.js:144` | 可用 |
| 5 分钟 checkpoint 封口 | `activityRecorder.js:183` | 可用，防止长窗口记录丢失 |
| 短片段合并 | `activityRecorder.js:249`，默认 3 秒 | 可用 |
| 隐私排除（应用名/标题关键词） | `privacyRules.js` + `activityRecorder.js:157` | 可用，**在入片段前过滤** |
| 人工补记 | `main.js:1176` `add-manual-record` | 可用，15 分钟规则见第 6 节 |
| 时间线拖拽补录 | `TimelineView.vue` | 可用 |
| 展示层覆盖标注 | `storageManager.replaceDisplayRanges` | 可用 |
| 按应用批量改分类 | `storageManager.recategorizeAppForDay` | 可用 |

### 2.2 查看与分析

| 能力 | 实现位置 |
|---|---|
| 日报告（槽位、分类、应用） | `analytics.buildDayReport` |
| 区间报告 | `analytics.buildRangeReport`，IPC `get-range-analytics` |
| 活动线程（「在推进什么」） | `src/components/ActivityThreads.vue` |
| 周期对比（7/30 天） | `src/components/CompareCard.vue` + `src/utils/compareRange.mjs` |
| 热力图 | `ActivityHeatmap.vue` |
| 生产力三档 | `ProductivityOverview.vue` |
| 周回顾草稿 | `WeeklyReview.vue` |
| 计划对照 | `planManager.js` + `PlanOverview.vue` + `PlanEditor.vue` |

### 2.3 扩展与集成

| 能力 | 状态 | 备注 |
|---|---|---|
| 本地 HTTP API | 可用，默认关 | 只绑 127.0.0.1，必须 token |
| MCP server | 存在（`mcp/`） | 未在本次深入审计 |
| 滴答清单同步 | 可用，默认关 | 拉取/推送独立开关 |
| AI 摘要与分类建议 | 可用，**默认关** (`ai.enabled: false`) | 见 3.7 |
| 番茄钟 / 沉浸计时 | 可用 | `focusManager.js` |
| 导出（单日/全量） | 可用 | `export-data` / `export-full-data` |
| 导入 | 可用 | 见 4.3 重复累计风险 |
| 自动更新检查 | 可用 | `check-for-updates` |
| 开机自启 | 可用 | `set-auto-launch` |

---

## 三、安全风险清单

按严重程度排序。「当前可利用性」一列很重要——多数问题现在不可利用，但会阻碍后续改造。

### 3.1 S1 三个窗口关闭了上下文隔离且开启 Node 集成

**位置**：`main.js:169`、`main.js:300-302`、`main.js:460-461`

```js
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  enableRemoteModule: true   // 主窗口额外开启
}
```

> **【第二轮修订】上一版此处结论有误。**
>
> `enableRemoteModule` 自 Electron 14 起随 `remote` 模块一并移除，在本项目使用的 **Electron 28.3.3 中是完全无效的选项**，不产生任何行为，**安全影响为零**。
>
> 准确表述应为：真实风险只有 `nodeIntegration: true` + `contextIsolation: false` 两项。`enableRemoteModule` 全仓库仅出现 1 次（`main.js:302`），删除它属于**代码清理**，不属于安全修复，可与任意改动合并，不构成独立任务。
>
> 另外补充实测数据：前端对 Node 的依赖面为 **0**（无任何 `fs`/`path`/`child_process` 引用），80 个 Electron 调用中 `invoke` 79 个、`on` 1 个、`send` 0 个。这让 preload 改造的实际工作量远小于上一版估计。

**影响**：渲染进程拥有完整 Node 权限（`fs`、`child_process`、`require`）。任何能注入到渲染层的 XSS 都会升级为任意代码执行。

**当前可利用性**：低。三个窗口都只 `loadFile` 本地文件，没有远程页面。但存在两个放大因素：

- `main.js:316` 用 `loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(...))` 加载错误页——`data:` URL 在某些场景下比 `file:` 更容易被注入。
- 应用渲染用户可控内容：窗口标题来自其他程序（`windowMonitor`），备注/分类来自用户输入。当前 Vue 默认转义，未见 `v-html` 之外的注入点——但 `marked` 已作为依赖引入（`package.json`），若用于渲染 AI 返回内容需要单独确认。

**建议**：这是所有安全改造的前置项。不要求一次到位，但应作为 0.10.2 的主线，按窗口逐个迁移（先浮动窗/专注窗，它们功能最单纯，再动主窗口）。

### 3.2 S2 没有 preload，前端直接 require electron

**位置**：`src/App.vue:199`

```js
const { ipcRenderer, shell, clipboard } = require('electron');
```

**影响**：缺少能力收窄的中间层。前端能拿到 `shell`（可 `openExternal` 任意 URL）和 `clipboard`（可读剪贴板）。

**当前可利用性**：低（依赖 3.1 的前提），但一旦 3.1 被利用，`shell.openExternal` 是最直接的钓鱼/跳转通道。

**建议**：与 3.1 同批处理。preload 暴露白名单 API，而不是把整个 `electron` 模块递下去。

### 3.3 S3 73 个 IPC 通道无来源校验

**位置**：`main.js` 全文，共 73 个 `ipcMain.handle/on`

**影响**：`event.senderFrame` 从未被校验。任意一个渲染进程（包括浮动窗、专注窗）都能调用全部通道，例如从浮动窗调用 `migrate-storage` 切走数据目录，或调用 `import-data` 写数据。

**当前可利用性**：低，但这是「最小权限」的实质缺失，也让 3.1 的后果被放大。

**建议**：按通道分组（只读 / 写 / 危险），危险通道（`migrate-storage`、`import-data`、`export-full-data`、`save-config`、`clear-logs`）校验 `event.senderFrame === mainWindow.webContents.mainFrame`。

### 3.4 S4 密钥明文存储

**位置**：`configManager.js:210-225`

```js
// 敏感信息只进 config.local.json，不写进 config.json（后者可能被同步/备份）
fs.writeFileSync(this.localConfigPath, JSON.stringify(localConfig, null, 2), 'utf8');
```

**现状**：已经把 `api.apiKey` 和 `dida.token` 从 `config.json` 分离到 `config.local.json`，并且在 `config.json` 里置空（`configManager.js:220/223`）。这个设计是对的。

**问题**：`config.local.json` 本身是**明文**。全仓库检索 `safeStorage` / `encryptString` 结果为 0。

**影响**：任何能读 `%APPDATA%` 的进程（同用户下的其他程序）都能拿到 DeepSeek API Key 和滴答 Token。若用户把 `%APPDATA%` 纳入同步（有人会这么做），密钥会随之上云。

**建议**：改用 Electron 内置 `safeStorage.encryptString()`（Windows 下走 DPAPI，绑定当前用户）。需要保留降级路径：`safeStorage.isEncryptionAvailable()` 为 false 时回退明文并提示。

### 3.5 S5 外部链接未校验协议

**位置**：`main.js:1744`、`src/App.vue:1233`

```js
shell.openExternal(`${status.url}/?token=${status.token}`);   // main.js:1744
shell.openExternal(this.updateInfo.downloadUrl);              // App.vue:1233
```

**影响**：`downloadUrl` 来自 GitHub API 响应的 `release.html_url`，理论上被篡改可触发 `file://` 或自定义协议。未见 `will-navigate` / `setWindowOpenHandler` 拦截。

**建议**：`openExternal` 前校验 `new URL(u).protocol === 'https:'`；补 `webContents.setWindowOpenHandler` 统一拒绝或转交。

### 3.6 S6 API Server 设计正确，但 CORS 放宽到任意来源

**位置**：`apiServer.js:424` `server.listen(port, '127.0.0.1')`；`apiServer.js:32/43` `'Access-Control-Allow-Origin': '*'`

**做得好的部分**（应保留，不要动）：

- 只绑 `127.0.0.1`，不监听 `0.0.0.0`
- 必须携带 token，支持 `Authorization: Bearer` / `X-WorkLog-Token` / `?token=`
- 用 `crypto.timingSafeEqual` 比较，先比长度（`apiServer.js:109-111`），防时序攻击
- 仅允许 GET
- `/health` 免 token 用于探活（合理）

**风险**：`Access-Control-Allow-Origin: '*'` 意味着任意网页的 JS 只要拿到 token 就能读数据。token 在 `?token=` 查询串里传递时还可能进浏览器历史/日志。

**建议**：CORS 收紧为 `null` 或不发该头（本地 CLI/MCP 不需要 CORS）；`?token=` 只在文档页保留，弃用为鉴权主路径。

### 3.7 S7 AI 发送范围：窗口标题原文外发

**位置**：`summarizer.js:201`

```js
`[${new Date(a.timestamp).toLocaleTimeString('zh-CN')}] ${a.processName} - ${a.windowTitle}`
```

**现状**（符合规范的部分）：

- `ai.enabled` 默认 `false`（`configManager.js:141-143`）
- `summarizer.js:283` 在未开启时直接返回，不发请求
- `privacyRules.isExcludedSample` 在**形成片段前**过滤（`activityRecorder.js:157`），被排除的应用/标题不会进入 `activities/`，因此也不会进 AI

**风险**：一旦用户开启 AI，`processName + windowTitle` 原文会发到 `config.api.baseUrl`（默认 `https://api.deepseek.com/chat/completions`）。窗口标题常含文件名、网页标题、聊天对象名。**现有隐私规则只作用于采集端，AI 发送端没有二次过滤**。

**建议**：发送前再过一遍 `privacyRules`；提供「只发应用名，不发标题」的档位。这是 P1 事项，不阻塞本次。

---

## 四、数据完整性风险

### 4.1 D1 记录层只读——机制正确（已验证）

**位置**：`storageManager.js:415`

```js
static layerOf(rec) {
  const src = rec && rec.source;
  return (!src || src === 'recorded') ? 'record' : 'display';
}
```

`updateDisplayRecord`（`storageManager.js:433-435`）对记录层直接返回 `{ success: false, error: '记录层数据不可修改' }`。

新增测试 `tests/recordImmutability.test.cjs`（5 条，全部通过）覆盖：

- 记录层拒绝改标题、时长
- 显式 `source: 'recorded'` 同样拒绝
- 同一文件内人工标注可改，且不连带改掉事实
- `layerOf` 对 5 种 source 值的分类
- `deleteDisplayRange` 只删展示层

**结论**：这一条符合规范，无需改造。

### 4.2 D2 自动记录与人工记录共用一个文件

**位置**：`storageManager.js:299-344`（`appendActivityRecords` 同时接受两种）

**风险**：不是逻辑错误，而是运维风险——任何「整文件重写」类操作（`replaceDisplayRanges`、`deleteDisplayRange`、`updateDisplayRecord`、`recategorizeAppForDay`）都必须逐行判断 `layerOf`。目前**四处都做了判断**，但这是靠人工纪律维持的：

| 方法 | 位置 | 是否判断 layerOf |
|---|---|---|
| `updateDisplayRecord` | `storageManager.js:433` | 是 |
| `deleteDisplayRange` | `storageManager.js:456` 起 | 是 |
| `replaceDisplayRanges` | `storageManager.js:500/517/544` | 是 |
| `recategorizeAppForDay` | `storageManager.js:576` 起 | 是 |
| `deleteDisplayRecord` | `storageManager.js:649` | 是（已复核） |

**结论**：五处逐行重写全部守住了记录层。这是靠人工纪律维持的正确性，不是靠结构保证的。

**建议**：把「逐行重写必须过滤记录层」抽成一个共用函数（如 `rewriteDisplayOnly(file, transform)`），消灭五处重复判断。这是低风险重构，但**本次不做**（规范禁止顺手改）。

### 4.3 D3 旧版 JSON 导入无去重键（真实风险）

**位置**：`main.js:1510-1524`

```js
if (Array.isArray(data.activities)) {
  data.activities.forEach(a => {
    if (a.timestamp && a.processName) {
      storageManager.saveActivity(a);   // 读 → push → 全量重写，无去重
      importedCount++;
    }
  });
}
```

`saveActivity`（`storageManager.js:281`）的实现是 `read → push → write`，没有任何「这条是否已存在」的判断。

**实测**（`tests/duplicateImport.test.cjs` 第 1 条）：同一份 2 条记录导入两次，文件里变成 **4 条**。

**影响**：用户重复点击导入，工时翻倍，且无法区分哪条是重复的（记录层不可编辑，只能手工删文件）。

> **【第二轮修订】上一版建议有误，已推翻。**
>
> 上一版写的是「建立去重键 `timestamp + processName + windowTitle + durationMs`」。**这是错的。**
>
> 实测证据：同一天落盘 4 条记录，其中第 1 条与第 4 条字段完全相同（`t`、`app`、`dur`、`kind`、`title` 全同），但二者都是合法记录（checkpoint 重开同应用段时，两次采样可能落在同一毫秒）。按上一版的键去重，这 4 条会被合并成 1 条，**误删 3 条合法记录**。
>
> 更根本的问题：记录本身**没有稳定唯一标识**。`storageManager.js:120` 的 `id` 是 `${rec.t}#${index}`，`index` 是**读取时的数组下标**，删掉一行后面全部漂移，不能作持久标识。
>
> 正确方案（详见第二轮报告 P0-03 与实施计划 §4）：先引入 `rid`（新记录生成 UUID，落盘保留）；旧记录**不做批量改写**，「文件名+行号」**仅用于单次读取内的兼容定位，不是持久身份**；去重**只在双方都有相同 `rid` 时**进行，无 `rid` 一律保留。
>
> ~~旧记录用「文件名+行号」推导稳定指纹~~ —— **已作废**。行号在 `replaceDisplayRanges` 等整文件重写后会变，不能跨读取使用。

### 4.4 D4 iCloud 冲突副本与主文件不去重

**位置**：`storageManager.js:167-182`（`_activityFilesOfDay`）

```js
for (const name of fs.readdirSync(dir)) {
  if (name === base) continue;
  if (!name.startsWith(dateStr)) continue;
  if (!name.endsWith('.jsonl')) continue;
  files.push(path.join(dir, name));
}
```

**设计意图**是好的：iCloud / OneDrive 生成 `2026-11-08 2.jsonl` 这类副本时，只读主文件会漏数据。但**没有跨文件去重**。

**实测**（`tests/duplicateImport.test.cjs` 第 2 条）：同一条记录同时存在于主文件和副本，读成 **2 条**。

> **【第二轮修订】** 同 D3，不能用内容做去重键。修复方案为按 `rid` 识别，见第二轮报告 P0-03。

### 4.5 D5 跨午夜拆分——已验证正确

**位置**：`electron/timeSplit.js`（全文 16 行）

```js
function splitRecordAtMidnight(record) {
  const start = new Date(record.t);
  const midnight = new Date(start);
  midnight.setHours(24, 0, 0, 0);
  const end = start.getTime() + record.dur;
  if (end <= midnight.getTime()) return [record];
  return [
    { ...record, dur: midnight.getTime() - start.getTime() },
    { ...record, t: midnight.toISOString(), dur: end - midnight.getTime() }
  ];
}
```

用 `setHours(24,0,0,0)` 取**本地**午夜（不是 UTC），避免了时区错位。

现有测试 `tests/timeSplit.test.cjs` + 新增 `tests/manualSnap.test.cjs` 第 4 条覆盖：拆分后总时长不变、次段从本地 00:00 起。

**结论**：符合规范，无需改造。

### 4.6 D6 写入失败处理——分三层，但有静默丢数据点

**第一层：`atomicFile.js`**（60 行）

临时文件 → rename → 失败重试 4 次（60/120/180/240ms 退避，只对 `EPERM/EBUSY/EMFILE/ENFILE` 重试）→ 最终回退直接覆盖写。设计合理，有测试（`tests/atomicFile.test.cjs`）。

**第二层：`storageManager.appendActivityRecords`**

`fs.appendFileSync` 失败时 catch 并 `console.error`，返回 `ok = false`。

**第三层：`activityRecorder.flush`**（`activityRecorder.js:278-293`）

```js
} catch (error) {
  this.onLog('写入活动记录失败: ' + error.message, 'error');
  // 放回去，下次再试（避免丢数据），但要防止无限增长
  this._buffer = batch.concat(this._buffer).slice(-200);
  return 0;
}
```

**风险**：`slice(-200)` 是**静默丢弃**。当缓冲超过 200 条且持续写不进去时，最早的记录会被直接扔掉，只留一条 error 日志，用户不会知道具体丢了哪段时间。

**建议**：超出上限时不要静默截断，而是把溢出部分写到一个 `pending/overflow-YYYYMMDD-HHmm.jsonl` 待恢复文件，并在 UI 上提示「有 N 条记录待写入」。这是数据安全项，优先级应高于新功能。

### 4.7 D7 历史数据迁移无可回滚，且不幂等

> **【第二轮修订】严重度由 P1 升级为 P0，问题描述补充「不幂等」。**
>
> 上一版只说「没有 `.bak` 备份」，实际更严重：`_migrateIfNeeded`（`storageManager.js:232-241`）**逐日写入完成后才 `renameSync` 源文件**。若中途失败，源文件仍在，下次启动会把已写入的天再 `concat` 一次。**实测：`1 1 1` → 重启后 `2 2 2`。**
>
> 修复不能靠去重（会误删合法重复），要靠迁移状态凭证 `.migration-state.json` + `.pre-migrate.bak`。详见第二轮报告 P0-02。

**位置**：`storageManager._migrateIfNeeded`（`storageManager.js:220`）、`fileMigration.js`（38 行）、`migrateDataTo`（`storageManager.js:928`）

`_migrateIfNeeded` 处理旧的 `activities.json` / `summaries.json` → 新目录结构。旧文件在迁移后被移动，**没有保留 `.bak`**。

**实测依据**：`tests/fileMigration.test.cjs` 覆盖了迁移成功路径，但没有覆盖「迁移到一半失败」的回滚。

### 4.8 D8【第二轮新增 P0】覆盖导入会删除全部原始记录

**位置**：`main.js:1514-1516` → `storageManager.js:663-678`（`clearActivities`）

```js
if (mode === 'overwrite') {
  storageManager.clearActivities();   // 删 activities/ 下所有 .json 与 .jsonl
}
```

`clearActivities()` 内部是 `fs.unlinkSync(p)`，**不分记录层/展示层，不进回收站，无任何备份**。实测：清空后 `activities/` 为空，数据目录无备份残留。

触发路径：设置页「覆盖」按钮（`SettingsView.vue:277`）→ `App.vue:1173` → `import-data`（`main.js:1453`），**无二次确认**。且提示文案写「『覆盖』仅对单文件导入生效」，未告知会删除原始记录。

这直接违反规范第 3 条 P0-1、第 4 条「原始记录只读」、第 9 条「删除必须有依据」。详见第二轮报告 P0-01。

### 4.9 D9 自定义数据目录缺少可用性预检（历史事故根因）

**位置**：`main.js` `save-config` / `migrate-storage` / `select-storage-folder`

**已发生的事实**（2026-11-10、11-11 两次应用无响应）：把数据目录切到 iCloud Drive 后，目录里存在带 `RECALL_ON_DATA_ACCESS` 属性的「仅在线」文件。`storageManager` / `analytics` 全部使用**同步 fs**（`readFileSync`、`readdirSync`、`statSync`）在主进程读取，命中未下载文件时在内核态阻塞，`try/catch` 和超时都无法中断，单线程主进程直接冻结。Windows 事件日志记录为 `Application Hang (Id 1002)`，不是 crash。

**当前代码状态**：仍未做任何预检或异步化。

**建议**：这是 P0 数据安全项。两条互补措施：

1. 切换目录前抽样读 20 个文件并计时，检测到 `0x400000` 属性或读取超时则拒绝切换并明确提示。
2. 数据读取迁到 `worker_threads`，主线程只收结果，超时 `terminate()`。这是唯一能真正中断内核级阻塞的方式。

---

## 五、补录体验问题

### 5.1 15 分钟规则散落在 7 处，策略不一致（核心问题）

**全部实现位置**（`grep` 实测）：

| # | 文件:行 | 起始吸附 | 时长取整 |
|---|---|---|---|
| 1 | `main.js:1150` / `1154` | `Math.floor(min/15)*15` 向下 | `Math.max(15, Math.round(raw/15)*15)` 就近 |
| 2 | `storageManager.js:610` / `611` | `Math.floor` 向下 | `Math.max(15, Math.round(...))` 就近 |
| 3 | `planManager.js:183` / `165` | `Math.floor` 向下 | `Math.max(15, Math.round(...))` 就近 |
| 4 | `analytics.js:1212` / `1214` | `Math.floor` 向下 | `Math.max(15, Math.round(...))` 就近 |
| 5 | `App.vue:541` | — | `Math.round` 就近 |
| 6 | `TimelineView.vue:1116` | **`Math.round` 就近** | — |
| 7 | `planManager.js:265` | — | `Math.max(1, Math.round(...))` **未按 15 取整** |

### 5.2 实测取整结果（脚本复现 `main.js:1150/1154`）

| 用户输入 | 实际保存起始 | 起始位移 | 实际时长 | 时长位移 | 实际结束 |
|---|---|---|---|---|---|
| 09:00 + 15min | 09:00 | 0 | 15 分 | 0 | 09:15 |
| 09:07 + 15min | 09:00 | **−7 分** | 15 分 | 0 | 09:15 |
| 09:07 + 22min | 09:00 | **−7 分** | **15 分** | **−7 分** | 09:15 |
| 09:14 + 15min | 09:00 | **−14 分** | 15 分 | 0 | 09:15 |
| 09:53 + 15min | 09:45 | **−8 分** | 15 分 | 0 | 10:00 |
| 23:50 + 30min | 23:45 | **−5 分** | 30 分 | 0 | 次日 00:15 |

**三个具体问题**：

1. **起始一律向下取整**。用户填 09:14，保存成 09:00，前移 14 分钟。而用户在前端拖动时（`TimelineView.vue:1116`）是按 `round` 就近吸附的——UI 上预览的是 09:15，保存后变成 09:00。**这就是「开始时间和结束时间取整不一致」的具体表现**。
2. **时长用 `Math.round` 导致跳档**。用户填 22 分钟，存成 15 分钟，少记 7 分钟。按规范「时长为 15 分钟整数倍」，22 分钟更接近 15 还是 30 需要产品决策；但当前实现是「就近」，而起始是「向下」，两者不同源。
3. **校验与提示不符**。`main.js:1144`：

```js
if (!Number.isFinite(rawDuration) || rawDuration < 1 || rawDuration > 24 * 60) {
  return { error: '时长需在 15–1440 分钟之间' };
}
```

实际拒绝的是 `< 1`，1–14 分钟都能通过并被提升到 15 分钟。提示文字却说「需在 15–1440 之间」。

### 5.3 拆分 / 合并 / 跨日对 15 分钟规则的影响

| 操作 | 实现 | 是否守住 15 分钟 |
|---|---|---|
| 跨日拆分 | `timeSplit.splitRecordAtMidnight` | **否**。午夜切点不是 15 的倍数时，会产出非 15 倍数的段（如 23:45→00:00 是 15 分，但 23:52 起就是 8 分 + 22 分） |
| 拖动改时长 | `TimelineView.vue:1253` `Math.round(.../15)*15` | 是 |
| 拆分时间段 | `TimelineView.vue` 拖拽切分 | 依赖 `minuteAt` 的 `round` 吸附，是 |
| 合并 | `activityRecorder.js:249` 短片段并入上一段 | **否**。这是记录层行为，按规范属「自动采集不取整」，正确 |
| 计划转事实 | `planManager.js:265` `Math.max(1, Math.round(...))` | **否**。未按 15 取整，可能写出 7 分钟的事实 |

### 5.4 建议（**已由 D-02 决策确定**，实施见计划文档）

规范禁止本次修改 15 分钟规则，所以以上只记录不动手。修复方向是**把 15 分钟规则收敛到一个模块**：`electron/slotRule.js`，7 处调用点全部改为引用它。

**用户已就吸附方向作出决策（D-02），取代本文原先的「待决策」：**

```
step = 15 分钟
snapStart(hhmm) = round(minutes / 15) * 15    // 就近，不是 floor
snapEnd(hhmm)   = round(minutes / 15) * 15    // 同样就近
duration        = snapEnd - snapStart          // 不再单独对时长取整
最短 15 分钟
重叠时必须提示用户，不允许静默覆盖
```

**样例验证**（用户给定，必须通过）：

| 输入 | 吸附后 | 时长 |
|---|---|---|
| 09:07 — 10:42 | 09:00 — 10:45 | **105 分钟** |

**与现状的差异**（这是行为变更）：

| 输入 | 现状 | D-02 后 |
|---|---|---|
| 09:14 起 15 分 | 09:00（floor，前移 14 分） | **09:15**（就近） |
| 09:00 起 22 分 | 09:00 — 09:15（少记 7 分） | 09:00 — **09:15（仍少记 7 分）** |
| 09:07 起 3 分 | 09:00 — 09:15（凭空变 15 分） | **拒绝保存**（Q1 选 B） |

> **⚠️ 此处更正一个错误说法。**
>
> 本文 v1 曾写「D-02 从根上消除了『填 22 分钟存 15 分钟』的失真」。**这句话是错的，现予作废。**
>
> D-02 只取消了「独立的时长取整」环节，但**吸附本身仍会改变时长**：
>
> - `09:00 + 22min` → 吸附为 `09:00—09:15` → **实际仍保存 15 分钟**，比输入少 7 分钟
> - `09:07 + 95min` → 吸附为 `09:00—10:45` → 实际保存 105 分钟，比输入多 10 分钟
>
> 因此 D-02 第 6 条「保存前显示吸附后的实际时间」**不是可选优化，而是必需措施**：用户必须看到「将保存为 09:00—09:15，共 15 分钟」才知道自己输入的 22 分钟会被记成 15 分钟。UI 不得隐藏这个差异。
>
> D-02 真正解决的问题是：①起始不再被 floor 前移最多 14 分钟；②两端吸附策略一致，前端预览与后端保存同源；③不足 15 分钟的输入被拒绝而非静默提升。

**跨午夜判定（v2 补充，此前未明确）**

现有 `manualRecordFromPayload` 接收 `startTime + durationMin`，**没有 `endTime`**。因此：

```
endRaw = startRaw + durationMin
crossMidnight = endRaw >= 1440     // 唯一判据
```

`durationMin` 恒为正，所以 **`endRaw < startRaw` 不可能发生**。本文 v1 提到「`duration <= 0` 则加 24 小时」是错误设计，已删除 —— 它会把「同一天内的短时段」误判为跨日。

**次日 00:00 是合法结果**：`23:45 + 15min` 吸附后是 `23:45—24:00`，写入时由 `timeSplit` 拆成两段，不应被视为错误。

完整算法、实测验证表与边界用例见 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` 第一节。

完整算法定义、跨日处理、重叠检测设计见 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` 第一节。

---

## 六、测试覆盖率与测试结果

### 6.1 基线测试真实执行结果

| 命令 | 结果 | 耗时 |
|---|---|---|
| `npm test` | **95 / 95 通过**（补充测试前） | 1255ms |
| `npm run lint` | **0 error / 0 warning** | — |
| `npm run build` | **成功**，58 modules，`dist/assets/index-DSFjVUKZ.js` 356.41 kB (gzip 120.12 kB) | 1.94s |

### 6.2 补充测试后

| 命令 | 结果 |
|---|---|
| `npm test` | **109 / 109 通过**（1372ms） |
| `npm run lint` | **0 告警**（含新增文件） |

### 6.3 新增测试文件

| 文件 | 条数 | 覆盖内容 |
|---|---|---|
| `tests/recordImmutability.test.cjs` | 5 | 原始记录只读（拒绝改标题/时长）、`source: 'recorded'` 同样拒绝、同文件内标注可改、`layerOf` 五分类、`deleteDisplayRange` 只删展示层 |
| `tests/manualSnap.test.cjs` | 5 | 时长必为 15 的倍数（14 种输入）、起始必落刻度、**已知问题锁定**（起始向下/时长就近）、跨午夜拆分不丢时长、写入读回不被二次取整 |
| `tests/duplicateImport.test.cjs` | 4 | 重复导入翻倍（风险记录）、iCloud 副本不去重（风险记录）、单行损坏不影响整文件、跨午夜 5 分钟封口按本地日期正确归属 |

### 6.4 规范要求的 7 项覆盖情况

| 要求 | 覆盖 | 说明 |
|---|---|---|
| 原始记录只读 | ✅ 新增 5 条 | |
| 人工记录写入 | ✅ 已有 + `manualSnap` 第 5 条 | |
| 跨午夜 | ✅ `timeSplit.test.cjs` + `storageReplace.test.cjs` 2 条 + `manualSnap` 第 4 条 | |
| 重复导入 | ✅ 新增 3 条（记录当前风险） | 测试是「锁定现状」，不是「证明正确」 |
| 时间块重叠 | ✅ `slotOccupancy.test.cjs` 5 条 | |
| 15 分钟取整 | ✅ 新增 5 条 | 含一条显式标注的 KNOWN ISSUE |
| 历史 JSON/JSONL 兼容 | ✅ `storageReplace.test.cjs` 第 3/4 条 + `duplicateImport` 第 3 条 + `fileMigration.test.cjs` | |

### 6.5 未覆盖（诚实说明）

- **`manualRecordFromPayload` 本身未被直接测试**。它定义在 `main.js:1133` 内部且未导出，`main.js` 依赖 Electron 运行时（`app.whenReady` 等），无法在 `node --test` 中 require。新增测试通过「复刻取整算法」的方式锁定口径。**这本身就是一个待改项**：规则逻辑应从 `main.js` 提取到可测试模块。
- **`main.js` 的 73 个 IPC handler 全部无单元测试**。
- **`analytics.buildRangeReport` 无独立测试**（只有 `analytics.test.cjs` 的部分间接覆盖）。
- **UI 交互（拖拽吸附、分割线）无自动化测试**。本次用临时 CDP 脚本人工验证过渲染，但没有沉淀成测试。
- **性能未测**。只有历史观测数据：1123 个活动文件读取 771ms（本地磁盘）。

### 6.6 测试数据隔离

所有测试使用 `fs.mkdtempSync(path.join(os.tmpdir(), 'lifelog-*'))` 建立临时目录，通过 `Module._load` 拦截 `require('electron')` 让 `app.getPath('userData')` 指向临时目录。**全仓库检索 `tests/` 无一处引用 `%APPDATA%` 或真实数据目录**，本次审计也未读写任何用户真实数据。

---

## 七、需要修改的具体文件

> **【第二轮修订】** 本节顺序已按第二轮报告的严重度重排。P0 部分新增了覆盖导入与迁移幂等两项，原先排在最前的「activityRecorder 静默丢弃」降为 P1。

### P0 — 数据安全（必须先做）

| 文件 | 改动 | 风险 | 对应问题 |
|---|---|---|---|
| `electron/storageManager.js:663` | 新增 `snapshotBeforeImport()`；`clearActivities` 加备份或直接废弃 | 低 | P0-01 |
| `electron/main.js:1504-1520` | 覆盖导入改「staging → 校验 → 替换 → 失败回滚」 | 中 | P0-01 |
| `src/views/SettingsView.vue:277-279` | 二次确认 + 修正「仅对单文件生效」的误导文案 | 低 | P0-01 |
| `electron/storageManager.js:220-271` | 迁移加 `.migration-state.json` + `.pre-migrate.bak`，实现幂等 | 中 | P0-02 |
| `electron/activityRecorder.js` + `storageManager.js:316` | 新增 `rid` 字段（只对新记录生效） | 低 | P0-03 |
| `electron/storageManager.js:421-449` | 编辑旧记录时**只给被编辑那条**补 rid，其他记录逐字节不变 | 中 | P0-03 |
| ~~`storageManager.js:120` 旧记录改「文件名+行号」稳定指纹~~ | **【已作废】** 行号在文件重写后会变，不能作持久身份。改为「仅单次读取内兼容定位」 | — | — |
| ~~`electron/main.js:1510-1524` 导入引入 `importBatchId`~~ | **【已作废】** 每次重新导入都会生成新 ID，无法阻止重复导入。改为**导入来源指纹**（`sha256` 全字段） | — | P1-01 |
| `electron/storageManager.js:167-182` | 冲突副本按 `rid` 去重（**无 `rid` 一律保留**） | 低 | P1-01 |

### P1 — 可靠性与体验

| 文件 | 改动 | 风险 | 对应问题 |
|---|---|---|---|
| `electron/activityRecorder.js:290` | `slice(-200)` 静默丢弃 → 溢出写待恢复文件 + UI 提示 | 低 | P1-04 |
| `electron/main.js`（`save-config` / `migrate-storage`） | 切目录前做可用性预检（抽样读 + 超时 + `0x400000` 属性检测） | 中 | P1-05 |
| `electron/storageManager.js` | 数据读取迁 `worker_threads`，超时 `terminate()` | **高** | P1-05 |
| 新增 `electron/slotRule.js` | 15 分钟规则唯一实现 | 低 | P1-03 |
| `main.js:1132-1173` | `manualRecordFromPayload` 迁出，改为引用 `slotRule`；修正错误提示文字 | 中 | P1-03 |
| `storageManager.js:610-611`、`planManager.js:165/183/265`、`analytics.js:1212-1214`、`App.vue:541`、`TimelineView.vue:1116` | 改为调用 `slotRule` | 中 | P1-03 |
| `main.js:1133`（接口） | **后端改收原始 `startTime` + `rawDurationMin`**，自行调 `slotRule` 验算（不能只收吸附后的值） | 中 | P1-03 |

### P1 — 安全基线（渐进，不一次到位）

| 文件 | 改动 | 风险 |
|---|---|---|
| 新增 `electron/preload.js` | 用 `contextBridge` 暴露白名单 API | **高**，需同时改三个窗口与全部前端调用点 |
| `main.js:169/300/460` | `nodeIntegration: false` + `contextIsolation: true` | **高**，与 preload 同批 |
| `main.js` 73 个 handler | 危险通道加 `senderFrame` 校验 | 中 |
| `src/App.vue:199` | 去掉 `require('electron')`，改用 preload 暴露的对象 | 高（依赖 preload） |
| `configManager.js:210-225` | `safeStorage` 加密 `config.local.json` | 低，有降级路径 |
| `main.js:1744`、`App.vue:1233` | `openExternal` 前校验 `https:` 协议 | 低 |
| `apiServer.js:32/43` | CORS 收紧 | 低 |

### P1 — 可维护性（不阻塞功能）

| 文件 | 改动 | 风险 |
|---|---|---|
| `storageManager.js` | 抽出 `rewriteDisplayOnly()`，消灭 5 处重复的 layerOf 判断 | 低，但触碰数据写路径 |
| `analytics.js`（1938 行） | 按职责拆分（槽位 / 分类 / 线程 / 区间报告） | 中 |
| `TimelineView.vue`（3173 行） | 抽出拖拽与吸附为 composable | 中 |

### 不建议现在动的

- `analytics.js` 的计算逻辑（改错会静默改变所有统计数字）
- 任何 JSONL 字段名或语义
- `atomicFile.js`（当前实现与测试匹配良好）

---

## 八、推荐改造顺序

严格一版一件事，每版独立提交 + 版本标记，通过独立审查后再进行下一版。

> **【第二轮修订】整个路线图已重排。** 原则改为「数据安全 > 功能 > 架构」。原先把「15 分钟规则」放第一版，现在后移——因为丢数据比体验差严重得多。
>
> **【决策后修订】V0.10.2 已按 D-04 拆分为 0.10.2a 与 0.10.2b，两者独立提交、独立测试、独立验收。** 完整任务拆解、文件范围、测试矩阵与验收标准见 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md`。

### V0.10.2a — 历史数据迁移幂等性（P0）

新增 `electron/legacyMigration.js`，实现「源文件快照 + 不可变暂存 + 迁移清单 + 每文件完成状态 + 原子替换 + 可验证恢复」。

> **v2 修订：范围扩大到摘要迁移。** `_migrateIfNeeded()` 实际有两段（`storageManager.js:222-245` 活动、`248-270` 摘要），两段都用 `existing.concat(items)`，**重复风险完全相同**。因此 `activities.json` 与 `summaries.json` 各自需要独立的 manifest、源快照、staging、完成状态与故障注入测试。
>
> **恢复判定改为 SHA256 比对**：manifest 记录每个目标文件的 `expectedSha256` 与替换前原文件的 `preReplaceSha256`。重启时比对正式文件哈希即可判定「是否已就位」，不依赖 status 文件——从而覆盖「rename 成功后、status 写入前崩溃」这个窗口（测试编号 F4a）。
>
> **暂存必须与目标同卷**：`.migration/` 工作区放在 `dataDir` 下，保证 `renameSync` 不抛 `EXDEV`。实现前需断言同卷。

测试：F1-F9（活动）+ S1-S9（摘要）故障注入矩阵，含 F4a 崩溃窗口、F7 源文件变化、F9 跨卷。

> **v2 修订：回滚流程修正。** v1 写的「删掉 `activities/*.json`」是错的——会误删迁移期间新录制/补录的数据。正确做法是按 manifest 的 `preReplaceBackup` 逐文件恢复，且只处理 manifest 列出的日期，其他日期一概不碰。

### V0.10.2b — 覆盖导入安全与危险入口处理（P0）

按 D-01：删除「覆盖」按钮与事件链、删除 `import-data` 的 overwrite 分支、删除 `clearActivities()` 的生产调用、导入前自动快照、修正误导文案。

> **v2 修订：快照范围扩大。** 完整 JSON 导入同时写 activities 和 summaries（`main.js:1526-1544`），`saveSummary` 还会写 `summaries_md/`。v1 只快照 `activities/` 不够，v2 覆盖 `activities/`、`summaries/`、`summaries_md/` 三个目录。
>
> **v2 修订：写入结果必须逐条检查。** 现有代码 `storageManager.saveActivity(a); importedCount++;` 丢弃了返回值，无论成败都计数。v2 要求分别统计 `succeeded / failed / skipped` 并如实上报——「导入成功」必须意味着每条都写成功了。

**不做**恢复备份功能（D-01 第 4 条要求单独立项）。

测试：导入不清空原始记录、三目录快照完整、逐条统计准确、生产代码无 `clearActivities` 调用。

### V0.10.3 — 记录唯一标识与去重治理（P0）

按 D-03：新记录生成 `rid` 落盘、旧数据不改、副本按 `rid` 去重（**无 `rid` 一律保留**）、导入改用**来源指纹**（`importBatchId` 已作废）、副本文件名严格正则。

> **D-03 特别要求**：重新审查 iCloud 冲突副本中旧记录的去重安全性。结论是**旧记录在副本中绝对不能自动去重**——副本语义是「另一个版本」而非「复制品」，其中可能含主文件没有的记录。
>
> **v2 修订：RID 补齐的严格限制（Q3 选 A 但限定）。** 新记录正常生成 UUID；旧记录不批量补；用户编辑旧展示记录时**只给实际编辑的那一条**补 RID；同文件其他历史记录不得因本次编辑而补；**不得因 RID 引入而改变任何历史记录的时间、时长或分类**。测试需断言：编辑 1 条后，同文件其余记录的完整 JSON 序列化结果与编辑前**逐字节相同**。
>
> **v2 修订：来源指纹必须覆盖全部有效数据。** 指纹需包含活动与摘要两类数据，使用规范化 JSON（固定 key 顺序、缺失补 null），**保留数组顺序与合法重复记录**，不得只算部分字段造成误判。

### V0.10.4 — 15 分钟规则统一（P1）

按 D-02：新增 `electron/slotRule.js` 唯一实现，7 处调用点对齐，起止分别就近吸附，时长由两端相减，新增重叠检测与提示。

> **v2 修订：重叠处理分级（Q2）。** 与**自动记录**重叠提示但**允许**（补记的正当用途，写展示层）；与**另一条人工记录**重叠**默认阻断**；用户确认覆盖时**只能动展示层**。硬约束：原始自动记录在任何操作前后逐字节一致，测试必须验证。
>
> **v2 修订：不足 15 分钟选 B 拒绝。** 判定用**原始时长**而非吸附后时长——实测 `09:07 + 3min` 吸附后是 15 分钟，只有用原始 3 分钟才拦得住。
>
> **v2 修订：必须如实告知失真。** 本文 5.4 节已更正「完全消除失真」的错误说法。`09:00 + 22min` 在 D-02 下仍保存为 15 分钟，UI 必须显示「将保存为 09:00—09:15，共 15 分钟」，不得隐藏差异。

### V0.10.5 — 存储目录可靠性与主线程卡死（P1）

切目录前预检（抽样读 + 超时 + 仅在线属性检测）；数据读取迁 `worker_threads`；`slice(-200)` 改溢出文件。

这是 11-10 / 11-11 两次卡死事故的根治。涉及全部读路径，**风险最高的一版**，建议先只对 `analytics` 做 worker，`storageManager` 保持同步，分两次提交。

### V0.10.6 — Electron 安全改造（P1，六步渐进）

S1 新增 preload（不启用）→ S2 前端改用 `worklog` API（保留 require 降级）→ S3 两个小窗切换 → S4 主窗切换 → S5 移除前端 require → S6 IPC 来源校验。

每步独立验收，任一功能失效立即回退该步。

### V0.10.7 — 代码清理与诊断改进（P2）

删除无效的 `enableRemoteModule`、`atomicFile` 错误链修正、密钥 `safeStorage` 加密、CORS 收紧、`openExternal` 协议校验、超大文件拆分。

### V0.11.0 — 打包发布

在主进程改动稳定后做窄窗/半屏/全屏 UI 验收，然后打 Windows 安装版与便携版。

---

## 九、不建议删除的功能

规范第 9 条要求删除前检查引用关系。以下功能看起来「用得少」但有真实依赖，**不建议删**：

| 功能 | 位置 | 保留理由 |
|---|---|---|
| 合并导入 | `SettingsView.vue:276` → `main.js:1511` | 换机恢复的正当路径。重复导入由**来源指纹**识别（~~按 `importBatchId`~~ 已作废） |
| **覆盖导入** | `SettingsView.vue:277` → `main.js:1514` | **【决策已定：取消】** D-01 决定暂时取消该入口。它当前会用 `clearActivities()` 删除全部原始记录且无备份。恢复备份需求单独立项 |
| 旧版 JSON 读取（`activities/YYYY-MM-DD.json`） | `storageManager._readActivityFile:148` | 历史数据兼容。删了会让早期数据「凭空消失」 |
| iCloud 冲突副本合并 | `storageManager._activityFilesOfDay:167` | 用户数据目录可能在任何同步盘下。虽然当前不去重（D4），但删除会让数据丢失 |
| `enableRemoteModule` | `main.js:302` | 已在 ES 中废弃，但**不能单独删**——必须与 preload 改造一起处理，否则前端 `require('electron')` 会断裂 |
| 本地 HTTP API / MCP | `apiServer.js`、`mcp/` | 规范允许保留。设计正确（127.0.0.1 + token + timingSafeEqual） |
| 滴答同步 | `didaSync.js`（816 行） | 用户实际在用，推拉独立开关设计合理 |
| 番茄钟 / 沉浸计时 | `focusManager.js`、`focus.html`、`focusWindow` | 有独立数据（focus sessions）进入统计 |
| 截图采集 | `screenshotManager.js`（294 行） | 需确认是否有开关；若长期关闭可「隐藏」但不删 |
| 计划系统 | `planManager.js`、`PlanEditor.vue` | 最近两个版本的主力功能 |
| `animations` / `appearance` 配置 | `configManager.js` | 设置页依赖 |
| `legacySpill` 处理 | `storageManager.js:508-520` | 处理旧版未拆分的跨午夜记录，删了会破坏历史数据编辑 |

**唯一建议「隐藏或停止新增」而非删除的**：`arhatManager.js`（262 行）。功能不明确，需你确认是否还在用。按规范「对不确定是否使用的功能，优先隐藏或停止新增开发，不直接删除」。

---

## 十、可能影响历史数据的改动

以下改动一旦实施，会触及已有数据。**必须在实施前备份，并准备好回滚**。

| 改动 | 影响的历史数据 | 回滚方式 |
|---|---|---|
| 导入去重（D3） | 无（只影响新导入） | 无需回滚 |
| 跨文件读取去重（D4） | 只影响读取聚合，磁盘不动 | 改回代码即可 |
| 15 分钟规则统一 | **会影响新写入的记录，不影响已存的**。但如果改动 `analytics` 的槽位计算，历史日的工时数字会变 | 保留旧算法开关，或明确接受数字微调 |
| `config.local.json` 加密 | 需一次性迁移明文→加密。若用户降级到旧版，旧版读不了加密内容 | 保留明文备份 + `isEncryptionAvailable()` 降级 |
| 迁移前备份（D7） | 无破坏性 | 无需回滚 |
| `worker_threads` 异步化 | 无（读路径改造，数据格式不变） | 代码回退即可 |
| preload + contextIsolation | 无数据影响，但**前端全部 IPC 调用点需同步改** | 代码回退 |
| `slotRule` 提取 | 无（算法不变，只是搬位置） | 代码回退 |

**红线（本次及后续都不应做）**：

- 不批量把历史记录取整到 15 分钟（规范第 4 条）
- 不删除 `kind`、`source`、`src`、`groupId`、`planKey`、`origin`、`cat` 任一字段
- 不改变 `t`（ISO UTC）与 `dur`（毫秒）的语义
- 不把 `activities/*.jsonl` 合并成单一大文件

---

## 十一、待办清单（本次发现但不修改）

规范第 7 条：发现的其他问题记录到待办，不顺手改。

1. ~~`deleteDisplayRecord`（`storageManager.js:638`）是否判断了 `layerOf`~~ —— 已复核，**有判断**（第 649 行），五处写路径全部守住记录层
2. `planManager.js:265` 计划转事实产出非 15 倍数的 `durationMin`
3. ~~`checkpointMs` 跨午夜交互~~ —— 已实测，**行为正确**，见第二轮报告 2.4
4. ~~`analytics.js:1212` 进位问题~~ —— 已复核，**无进位问题**
5. `local v0.1.0` tag 与远程冲突，仅影响本地 tag
6. 前端三个超大文件（3173 / 1686 / 1624 行）的拆分
7. AI 发送端无二次隐私过滤（S7）
8. `?token=` 查询串鉴权会进浏览器历史

**【第二轮新增待办】**

9. `atomicFile.js:50` 抛出 `lastError` 而非 `directError`，错误码误导（P2-01）
10. `recordImmutability.test.cjs` 缺 `delete require.cache`，4 个测试共用第一个临时目录（2.2）
11. `manualSnap.test.cjs` 复刻算法，需在 `slotRule.js` 落地后改为直接调用生产函数（2.1）
12. `duplicateImport.test.cjs` 第 1、2 条在修复后需改为断言正确行为（2.3）
13. `enableRemoteModule` 无效选项，清理时删掉（P1-02）

---

## 十二、本次交付物

| 类型 | 路径 | 说明 |
|---|---|---|
| 审计报告 | `docs/WORKLOG_1.0_AUDIT.md` | 本文件（第一轮，已被第二轮修订） |
| 审查报告 | `docs/WORKLOG_1.0_AUDIT_ROUND2.md` | **第二轮独立审查，以此为准** |
| 新增测试 | `tests/recordImmutability.test.cjs` | 5 条，原始记录只读（⚠️ cache 缺陷待修） |
| 新增测试 | `tests/manualSnap.test.cjs` | 5 条，15 分钟口径（⚠️ 行为快照，非契约测试） |
| 新增测试 | `tests/duplicateImport.test.cjs` | 4 条，含 2 条已知缺陷回归 |
| 分支 | `worklog-1.0-dev` | 从 `f1b612c` 创建 |

**未做**：生产代码一行未改；数据格式未动；15 分钟规则未改；未开发任何新功能。

---

## 十三、下一步建议

> **【第二轮修订】本节结论已变更。** 原建议「V0.10.2 做 15 分钟规则收敛」**不再成立**——覆盖导入删光原始记录（P0-01）与迁移不幂等（P0-02）优先级更高。

**建议 V0.10.2 做「覆盖导入与迁移不丢数据」**，理由见第八节与第二轮报告第五节。

开工前需要你确认四项决策（详见第二轮报告第六节）：

- **D-01**：覆盖导入直接取消，还是保留但加快照+回滚？我倾向取消。
- **D-02**：15 分钟起始吸附方向、时长取整方式（V0.10.4 才用，可稍后定）。
- **D-03**：`rid` 是否接受「只对新记录生效，不迁移历史数据」？我倾向接受。
- **D-04**：V0.10.2 是否拆成 0.10.2a（迁移）与 0.10.2b（导入）？我倾向拆。

四项定了，0.10.2 的范围就能完全确定。

**本次到此停止，等待独立审查。** 未开始 V0.10.2。
