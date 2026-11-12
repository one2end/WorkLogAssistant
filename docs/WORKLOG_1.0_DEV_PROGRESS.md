# WorkLog 1.0 开发进度 — V0.10.2a / V0.10.2b

> 冻结方案基线：`1de413e`（docs: freeze the WorkLog 1.0 plan for V0.10.2a）
> 开发分支：`workbuddy/worklog-1-0-dev-2a79589a`（已推送 GitHub，与远程 HEAD 一致）
> （任务书写的是 `ai/overnight-v0102a`；实际分支以 Git 为准，未强行改名以免打断已有提交）
> 依据：`docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md`
> · V0.10.2a → §2.5 / §2.5a / §2.5b / §2.6 / §2.6a / §2.8 / §2.10 / §2.11 / §2.13 / §2.14
> · V0.10.2b → §3.1 ~ §3.11

> **上下文恢复指引**：若会话被压缩或中断，先读本文件 + `git log --oneline -8`，从「下一步任务」继续。

---

## V0.10.2b 版本裁定记录（重要）

收到两份互相矛盾的任务书，已按用户正式裁定执行：

| 来源 | 声称的 V0.10.2b 主题 |
|---|---|
| 冻结方案 §六 | **导入安全**（删覆盖入口、三目录快照、指纹、续传） |
| 早前开发任务书 | 迁移交互闭环（状态查询 / IPC / 冲突 UI） |

**裁定结果：以冻结方案为准，V0.10.2b = 导入安全。** 迁移交互闭环（状态展示、人工恢复 UI、显式迁移入口）留待后续版本单独规划，**本版本一行未做**。

同时确认的边界：
- UI 只增不改 → 实际只删除了危险按钮与其事件链，共 14 行 Vue
- 不新增显式迁移触发 API
- 不改九状态机、终态定义、staging / manifest / 归档规则

已用 `git diff 7ea558f..HEAD -- electron/legacyMigration.js electron/writeGate.js` 核验：**迁移引擎与写入锁零改动**。

---

## 阶段总览

### V0.10.2a

| 阶段 | 内容 | 状态 | Commit |
|---|---|---|---|
| 一 | 统一写入锁 | ✅ 完成 | `f814fc7` |
| 二 | 独立迁移引擎 | ✅ 完成 | `c9e4e67` |
| 三 | 故障注入测试（F 11 + S 11） | ✅ 完成 | `e00c6da`、`92d49bc` |
| 四 | 回归测试 | ✅ 完成 | `7ea558f` |

### V0.10.2b

| 阶段 | 内容 | 状态 | Commit |
|---|---|---|---|
| 一 | 整文件指纹（§3.7） | ✅ 完成 | `0e9ad91` |
| 二 | 三目录快照 + 摘要半成功（§3.2 / §3.4） | ✅ 完成 | `efd4b7e` |
| 三 | 导入批次与安全续传（§3.3 / §3.6） | ✅ 完成 | `2602ebe` |
| 四 | 删除覆盖入口（§3.1 / §3.8）+ 独立审计 | ✅ 完成 | 见下方 |


---

## 阶段一：统一写入锁 ✅ `f814fc7`

### 已完成

1. **新建 `electron/writeGate.js`**
   - `tryAcquire(owner, reason)` / `release(owner)` / `forceRelease()` — owner 校验，非持有者释放无效
   - `withMigrationContext(fn)` — `migrationDepth` 计数器，支持嵌套，迁移自身不被自我阻塞
   - `assertWritable(operation)` — 特权上下文放行，否则抛 `WriteBlockedError`（`code = 'MIGRATION_IN_PROGRESS'`）
   - `onReleased(fn)` — 迁移结束回调，供录制器主动补 flush
   - `isLocked()` / `getHolder()` / `inMigrationContext()` / `_resetForTests()`

2. **`electron/storageManager.js` 接入 15 个写方法**（§2.13 表格逐条对齐）
   `saveActivity`、`appendActivityRecords`、`deleteActivity`、`updateDisplayRecord`、
   `deleteDisplayRange`、`replaceDisplayRanges`、`recategorizeAppForDay`、`deleteDisplayRecord`、
   `clearActivities`、`saveSummary`、`deleteSummary`、**`saveScreenshot`**、**`cleanupOldData`**、
   `migrateDataTo`、`setDataDir`
   - `_writeJsonFile` 按规范不单独加锁（内部工具，由调用方负责）
   - **关键实现细节**：`assertWritable` 一律放在 `try` 块**之外**。这些方法内部 `catch` 会把异常吞成 `return false`，若断言放进 `try`，阻断语义就退化成静默失败，调用方无法区分「迁移中」和「写失败」。

3. **`electron/activityRecorder.js` 缓冲处理**
   - 捕获到 `MIGRATION_IN_PROGRESS` 时片段**原样放回、不截断**（规范禁止迁移分支走 `slice(-200)`）
   - 普通写失败仍保持原有 `slice(-200)` 行为，**未改变既有语义**
   - 订阅 `writeGate.onReleased`：迁移一结束立即补 flush，不等 15 秒周期

### 修改文件
`electron/writeGate.js`（新增）、`electron/storageManager.js`、`electron/activityRecorder.js`、`tests/writeGate.test.cjs`（新增）

### 测试
`node --test tests/writeGate.test.cjs` → **12 pass / 0 fail**
覆盖 T-M09、T-M10、T-M16、T-M17、T-M18、T-M19、T-M20、T-M21、T-M22，另加 3 个补充用例。
T-M18 的验证方式：15 个方法逐个调用，断言 `error.code === ERR` **且** `activities/` 全目录 SHA 前后一致——不只是「抛错了」。

---

## 阶段二：独立迁移引擎 ✅ `c9e4e67`

### 已完成

新建 `electron/legacyMigration.js`（约 1300 行），包含：

- **9 状态状态机**（`init / snapshot / staging / replacing / finishing / done / rolledback / conflict / failed`），4 个终态。终态绝不自动重入。
- **manifest**：`preReplaceExists` / `preReplaceRecordCount`（缺失时为 `0` 而非 `null`）/ `preReplaceSha256` / `preReplaceBackup` / `expectedRecordCount` / `expectedSha256`
- **SHA256 判定**：`expectedSha256` 让「rename 成功但 status 未写」的崩溃窗口可判定，不依赖 status
- **staging**：已存在且哈希正确则复用，否则重生成（staging 是可再生中间产物）
- **跨卷探测**：真实 `renameSync` 探测为最终依据，捕获 `EXDEV` / 其他错误码均拒绝，临时文件必然清理
- **归档三点校验**（§2.6a）：改名前校验 → 唯一归档名 rename → **改名后校验归档内容**
- **唯一归档名**：`.migrated` 已存在时用 `.migrated-<ts>`，绝不覆盖（`renameSync` 会静默覆盖）
- **恢复判定**（§2.5b）：逐 target 比对 `expectedSha256` / `preReplaceSha256`
- **回滚五分支**（§2.8）：恢复 / 跳过 / 跳过 / 冲突不重建 / 隔离不覆盖
- **人工介入**（§2.14）：`archiveWorkspace('accepted'|'abandoned')`

### 修改文件
`electron/legacyMigration.js`（新增）、`electron/storageManager.js`（`_migrateIfNeeded` 改为调用引擎两次，各自独立）

### 测试
`node --test tests/legacyMigration.test.cjs` → **13 pass / 0 fail**（F 系列 11 点全部通过）

### 开发过程中由测试暴露出的 3 个真实缺陷

1. **源文件改名失败被判为 `failed`（终态）** → 数据永远卡在半路。
   改为停在 `finishing`（非终态），下次启动重试改名。
2. **归档后重启被当成「没东西可迁」**（源文件已消失）→ 工作区永远停在 `finishing`。
   增加 `_resumeWithoutSource()`，先做 F5a 四重判定。
3. **F7：工作区按源哈希命名，源变化后自然落到新目录** → 与未完成的迁移叠加，记录数翻倍。
   增加前置防线：存在非终态工作区时，禁止新建。

---

## 阶段三：故障注入测试 ✅ `e00c6da`、`92d49bc`

### 测试文件

| 文件 | 用例数 | 内容 |
|---|---|---|
| `tests/helpers/migrationFixture.cjs` | — | 临时目录夹具、模拟崩溃哨兵、哈希快照 |
| `tests/legacyMigration.test.cjs` | 13 | F 系列 11 点 |
| `tests/legacyMigrationSummaries.test.cjs` | 12 | S 系列 11 点（独立数值） |
| `tests/migrationRecovery.test.cjs` | 10 | 回滚五分支、T-M07/M12/M13/M14/M25、人工介入 |
| `tests/migrationArchive.test.cjs` | 12 | T-M08/M11/M15/M23/M24、损坏源文件、锁的持有与释放 |
| `tests/migrationConcurrency.test.cjs` | 4 | T-M09/M12 的 IPC 契约与并发 |
| `tests/migrationCoverage.test.cjs` | 4 | 编号自检（缺一个编号就失败） |
| `tests/writeGate.test.cjs` | 12 | 写入锁 |
| **合计新增** | **67** | |

### 故障注入点（22 个，对称完整）

| 系列 | 中断点 | 状态 |
|---|---|---|
| 活动 | F1、F2、F3、F4、F4a、F5、F5a、F6、F7、F8、F9 | ✅ 11/11 |
| 摘要 | S1、S2、S3、S4、S4a、S5、S5a、S6、S7、S8、S9 | ✅ 11/11 |

### 断言口径

每个中断点的断言是**「恢复后与一次成功逐字节相同」**（目录内全部文件 SHA 比对），不是「没抛错」或「状态是 done」。

### 安全性

- 全部使用 `os.tmpdir()` 下 `mkdtemp` 临时目录
- 「崩溃」用哨兵异常模拟，不 kill 进程；`MigrationEngine` 显式让哨兵穿透 `run()` 的 catch，避免被误判为业务失败
- `tests/migrationCoverage.test.cjs` 自动校验测试中无硬编码真实路径

### 由测试暴露的额外缺陷
`assertWritable` 的阻断若被 `try/catch` 吞掉会退化为 `return false`；同时 IPC handler 原先不捕获异常，会把 `WriteBlockedError` 变成无上下文异常。已在 `main.js` 增加 `writeFailure()` / `callStorage()`，返回 `{ code: 'MIGRATION_IN_PROGRESS', retryable: true }`。

---

## 阶段四：回归测试 ✅

### 实测结果（在本机、本次会话真实执行）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run lint` | **0** | 0 error / 0 warning |
| `npm run build` | **0** | `✓ 58 modules transformed`，`✓ built in 1.28s` |
| `npm test` | **1** | **176 tests，175 pass，1 fail** |

### 那 1 个失败是什么

`tests/focusEditing.test.cjs` → `Electron failed to install correctly`。

- **根因**：Electron 二进制（约 100MB）未下载，`npm rebuild electron` 因 DNS 解析失败无法完成（网络受限）
- **与本次改动无关**：该用例毫无 `electron` mock（`grep -c "Module._load" = 0`），直接 `require('../electron/arhatManager')` 触发真实 electron 包加载
- **基线即失败**：接手时依赖完全未装，`npm test` 有 5 个失败；装完依赖后剩这 1 个，**在 V0.10.2a 改动之前就已存在**
- **本阶段未触碰任何 focus 相关代码**

> 按「不得跳过失败测试、不得降低断言」的约束：断言未做任何放宽，该失败如实记录，未标记为通过。

---

## 未完成内容

1. **`focusEditing.test.cjs` 的环境修复**：需要在有网络的环境执行 `npm install electron`，或为该用例补 `Module._load` mock。**不建议**为了绿而改测试——补 mock 会掩盖它原本要验证的真实集成路径，应作为独立任务评估。
2. **UI 层冲突展示**：引擎已产出 `conflictDetail`（含文件列表、期望/实际哈希），但渲染层尚无「迁移冲突」界面。属 §2.14 的 UI 部分，本阶段范围外。
3. **用户显式触发的迁移入口**：`run({ auto: false })` 已支持，但尚无 IPC 通道调用它（`archiveWorkspace` 同理）。当前只有启动时自动迁移。
4. **`cleanupOldData` / `saveScreenshot` 仍是死代码**：已加锁保护，但按冻结方案应在 V0.10.7 清理，本版本不动。

---

## 已知风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | **外部同步竞态无法消除** | 校验与 rename 之间有微秒级窗口。已按方案降级为「可检测的 conflict + 三份数据全保留」，**不承诺零窗口** |
| 2 | **`jsonl` 文件不在迁移范围** | 迁移只处理 `activities.json` → `activities/*.json`。`*.<date>.jsonl` 由录制器写入，与迁移目标不重叠，但回滚只覆盖 `manifest.targets` |
| 3 | **摘要 MD 文件不迁移** | `summaries_md/*.md` 不在本次范围（§2.9 只列 json） |
| 4 | **合并顺序依赖源文件原顺序** | `existing.concat(incoming)` 保留两侧原序，不做时间排序（排序会改变哈希基线）。若源文件本身乱序，结果也乱序——与旧行为一致 |
| 5 | **`preReplaceRecordCount` 依赖 manifest 快照** | 若用户在迁移前手工改过目标文件且 manifest 已生成，该值会过期 → 由替换前 SHA 校验拦截并判 conflict |
| 6 | **大文件性能未测** | 1284 条量级手工验证过；万级未见实测 |

---

## 下一步任务（按优先级）

1. **在有网络的环境补装 Electron**，确认 `focusEditing.test.cjs` 恢复通过，让 `npm test` 退出码归零
2. **渲染层迁移冲突提示**：消费 `storageManager.getMigrationStatus()`，在设置页展示 `conflictDetail`，提供 §2.14 的四种操作入口
3. **补 IPC 通道**：`migration-status` / `migration-rollback` / `migration-accept` / `migration-abandon`，走 `writeGate` 保护
4. **V0.10.2b 起点**：按方案删除覆盖导入入口、三目录快照、逐条统计、指纹模块（**本版本明确不做**）

---

## 提交记录

| Commit | 内容 |
|---|---|
| `f814fc7` | Put every write to the activity and summary files behind one gate |
| `c9e4e67` | Migrate the old single files with a manifest instead of a blind concat |
| `e00c6da` | Roll back without trampling what was written after the migration |
| `92d49bc` | Make the test ids auditable instead of merely claimed |

---

# V0.10.2b：导入安全

## 阶段一：整文件指纹 ✅ `0e9ad91`

### 已完成
新建 `electron/importFingerprint.js`：
- `FINGERPRINT_VERSION = 4`
- **只覆盖 `activities` + `summaries`**，与「实际导入什么」严格对齐
- volatile 字段按类型定义（activity: `id` / `editedAt`；summary: `id` / `generatedAt`），且**只在顶层过滤**
- 对象键排序，数组保序保重复
- `isComparable()`：版本不匹配返回 false（不误判为已导入）

### 修改文件
`electron/importFingerprint.js`（新增）、`tests/importFingerprint.test.cjs`（新增）

### 测试
13 pass / 0 fail，覆盖 T-I05、T-I06、T-I07、T-I08

### 关键设计点
v3 草案全局排除 `id`，会把 `summaries[].slots[].id` 这类**嵌套合法内容**一起抹掉，导致不同文件算出相同指纹。已用 `canon(value, volatileKeys, depth)` 只在 `depth === 0` 应用 volatile 集合，并有专门用例锁住。

---

## 阶段二：三目录快照与摘要半成功 ✅ `efd4b7e`

### 已完成
`electron/storageManager.js` 新增：
- **`snapshotBeforeImport(reason)`**：复制 `activities/`、`summaries/`、`summaries_md/` 三目录 + `snapshot-manifest.json`。同一秒内连续导入自动加后缀，**绝不覆盖上一份快照**。
- **`saveSummaryDetailed(summary)`**：返回 `{ jsonOk, mdOk }`。JSON 是唯一事实来源，MD 失败只记 `mdFailed`。
- **`rebuildSummaryMarkdown(summary)`**：从已落盘 JSON 重建 MD，**不写 JSON**（不会产生重复记录）。
- `clearActivities()` 保留方法体，加上「不得从导入/恢复流程调用」的警示注释（§3.8）。

### 修改文件
`electron/storageManager.js`

### 解决的原始缺陷
`saveSummary` 先写 JSON 再写 MD，任一步失败都返回 `false`。若 MD 失败，JSON 里其实已有这条摘要——调用方计入失败，用户重试就写了第二条。现在这个区分是可见的。

---

## 阶段三：导入批次与安全续传 ✅ `2602ebe`

### 已完成
新建 `electron/importSafety.js`：
- **`planImport()`**：判定 `new` / `resume-available` / `already-completed` / `version-mismatch` / `restart-*`
- **`executeImport()`**：逐条写 `imp = { batch, idx }`，输出 `succeeded` / `failed` / `skipped` / `mdFailed`
- **`collectDoneIdx()`**：扫描目标目录收集已有 `imp.batch` 的 idx —— **续传的事实来源**
- **`rebuildMissingMarkdown()`**：只补 MD
- 任务文件 `Data/.import-tasks/<fingerprint16>.json`，`progress` 仅作加速缓存

### 修改文件
`electron/importSafety.js`（新增）、`electron/main.js`、`src/App.vue`、`src/views/SettingsView.vue`、`tests/importSafety.test.cjs`（新增）

### 删除的危险入口（§3.1）
- `SettingsView.vue`：删除「覆盖」按钮 + `import-overwrite` emit 声明 + 修正文案
- `App.vue`：删除 `@import-overwrite` 绑定
- `main.js`：删除 `mode === 'overwrite'` 的 `clearActivities()` 调用（改为拒绝）

**Vue 共改动 14 行，全部与导入安全直接相关。**

---

## 阶段四：独立审计 ✅

按任务书 §五 逐项检查：

| 审计项 | 结果 |
|---|---|
| IPC 权限边界 | ✅ 路径由主进程 `showOpenDialog` 决定，渲染层**无法传入任意路径**；`mode` 仅用于拒绝 `overwrite` |
| 写入锁是否被绕过 | ⚠️ **发现 1 个 P1 并已修复**：`rebuildSummaryMarkdown` 原本未过 `assertWritable`，与 `saveSummary` 写同一 `summaries_md/` 目录。已补锁并加测试 |
| UI 是否可能误导用户执行危险操作 | ✅ 危险按钮已删除；`App.vue` 仅如实展示逐条统计，无「一键覆盖」类入口 |
| 冲突信息是否完整 | ✅ `failed` / `skipped` / `mdFailed` 分列，失败条数与快照路径都回传给 UI |
| 历史数据是否可能被覆盖 | ✅ `importSafety.js` 中 `unlinkSync` / `rmSync` / `clearActivities` / `truncate` **均为零**（有静态断言锁住） |
| 状态机是否存在非法转换 | ✅ 任务状态只有 `in_progress` / `completed` 两值；`abort` 直接拦截不写状态。V0.10.2a 的九状态机**零改动** |

### 审计修复
`rebuildSummaryMarkdown` 补写锁 + 新增 `every new summary write honours the migration gate` 用例。

---

## V0.10.2b 测试矩阵

| ID | 场景 | 状态 |
|---|---|---|
| T-I01 | 合并导入不清空原始记录 | ✅ |
| T-I02 | 三目录快照完整 | ✅ |
| T-I03 | 逐条写入统计准确 | ✅ |
| T-I04 | 无 `clearActivities` 生产调用 | ✅（静态扫描 electron/ src/ mcp/） |
| T-I05 | 指纹覆盖全部非 volatile 字段（含嵌套 `slots[].id`） | ✅ |
| T-I06 | 保留数组顺序与合法重复 | ✅ |
| T-I07 | `arhat*` / `config` / `summariesMd` 不参与指纹 | ✅ |
| T-I08 | `fingerprintVersion` 不匹配 | ✅ |
| T-I09 | 写到第 N 条崩溃后「继续」不重复 | ✅ |
| T-I10 | 数据写完、progress 未写仍能判定 | ✅ |
| T-I11 | 文件内两条相同记录都导入 | ✅ |
| T-I12 | 强制重导生成新批次并警告 | ✅ |
| T-I13 | JSON 成功 MD 失败后续传不重写 JSON | ✅ |
| T-I14 | 原始字段逐字节保留，仅新增 `imp` | ✅ |
| T-I15 | 部分失败默认走「继续」 | ✅ |

补充用例：同秒双快照不覆盖、abort 不写入、跨多日 imp 收集、任务状态合法值、写锁覆盖、导入模块无删除操作。

**导入测试总计 20 个用例，全部通过。**

## V0.10.2b 回归实测

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run lint` | **0** | 0 error / 0 warning |
| `npm run build` | **0** | built successfully |
| `npm test` | **1** | **206 tests，205 pass，1 fail** |

唯一的失败仍是 `tests/focusEditing.test.cjs` → `Electron failed to install correctly`（二进制未下载，DNS 受限）。**V0.10.2b 未触碰该文件，失败在 V0.10.2a 之前就存在**，断言未做任何放宽。

## V0.10.2b 未做 / 已知边界

| 项 | 说明 |
|---|---|
| 迁移交互 UI | 按裁定留待后续版本单独规划，本版本**一行未做** |
| 显式迁移触发 API | 同上 |
| 内容去重 | 方案 §3.5 明确不做，放 V0.10.3 |
| exactly-once | **不承诺**。崩溃后「继续」不重复；「重新开始」会产生重复（已警告）；用户手工删记录后重试会重导 |
| `import-data` 的 `mode` 参数 | 保留以兼容旧渲染层，`overwrite` 走拒绝分支 |
| 已导入文件的 UI 提示 | 目前走 toast（`alreadyImported`），无「继续 / 重新开始」选择界面 |

## 数据安全边界声明

| 场景 | 行为 |
|---|---|
| 导入中途崩溃 → 「继续」 | 不重复（靠 `imp.batch + idx`） |
| 导入中途崩溃 → 「重新开始」 | **会产生重复**，新批次无法匹配旧标记，必须警告 |
| 同一文件内两条相同记录 | 全部保留，`imp.idx` 不同 |
| 快照写失败 | **中止导入**，不写任何数据 |
| 摘要 JSON 成功 MD 失败 | 记为已导入，`mdFailed` 单独计数，重试只补 MD |
| 指纹版本不匹配 | 不判定已导入，提示「无法确认」 |
| 用户手工删记录后重导 | 会重导（无法区分「已删」与「未导入」） |

## V0.10.2b 下一步建议

1. 补装 Electron 二进制，让 `npm test` 归零
2. 「已导入过」的 UI 交互：提供「继续 / 重新开始」二选一，默认「继续」
3. `mdIncomplete` 的修复入口：设置页增加「重建摘要文字版」按钮
4. 后续版本单独规划迁移交互闭环（状态展示 / 人工恢复 UI）

## 提交记录（V0.10.2b）

| Commit | 内容 |
|---|---|
| `0e9ad91` | Fingerprint what gets imported, not what gets exported |
| `efd4b7e` | Snapshot all three directories an import can touch |
| `2602ebe` | Remove the overwrite import and make merges resumable |

---

# V0.10.3：记录唯一标识与去重治理

## 阶段一：副本文件名严格正则 ✅ `ec3e142`

### 已完成
`storageManager._activityFilesOfDay` 改用 `^<date>(?: (?:\(\d+\)|\d+))?\.jsonl$`。

### 实测确认的原始缺陷
| 文件名 | 旧规则 | 新规则 |
|---|---|---|
| `2026-11-08.jsonl` | 读取 | 读取 |
| `2026-11-08 2.jsonl` | 读取 | 读取 |
| `2026-11-08 (1).jsonl` | 读取 | 读取 |
| `2026-11-08-backup.jsonl` | **读取（错）** | 忽略 |
| `2026-11-08.old.jsonl` | **读取（错）** | 忽略 |
| `2026-11-080.jsonl` | **读取（错）** | 忽略 |

用户表现：某天记录数莫名翻倍，界面上没有任何东西指向一个叫 `-backup` 的文件。

### 测试
6 个用例，双向断言（该读的读、不该读的六个变体都不读，含下划线与连字符变体）。

---

## 阶段二：rid 生成、落盘与读取 ✅ `6705f42`

### 已完成
| 位置 | 改动 |
|---|---|
| `activityRecorder._emit()` | 统一生成 `crypto.randomUUID()`，active 与 idle 两个调用点都覆盖 |
| `storageManager.appendActivityRecords` | 落盘 `...(r.rid ? { rid: r.rid } : {})`，无 rid 不凭空写 |
| `storageManager._fromSegment` | 读回 `rid: rec.rid \|\| null`，**不重算** |
| `main.js` 3 处人工记录 | `groupId` 之外补 `rid`（两者语义不同层） |
| `timeSplit.splitRecordAtMidnight` | **拆分后半段生成独立 rid** |

### 测试逼出的缺陷
`splitRecordAtMidnight` 用 `{...record}` 复制，跨午夜两段**共享同一 rid**。去重会把后半段当重复删掉——用户 23:50 那小时的后半截消失。已修：前半段沿用原 rid，后半段新生成。

### 测试
14 个用例（T-R01 及补充），含「内部 id 会变但 rid 不变」「无 rid 读成 null 而非空串」等。

---

## 阶段三：冲突副本按 rid 去重 ✅ `352ae8e`

### 规则
| 场景 | 处理 |
|---|---|
| 双方同 rid | 合并成一条 |
| 双方不同 rid | 两条都留 |
| 一方无 rid | 两条都留 |
| 双方都无 rid | 两条都留 |
| **同一文件内重复** | **永不去重** |

### 测试逼出的缺陷
第一版用全局 `seenAcrossFiles` 集合，把**同一文件内**的第二个相同 rid 也跳过了。被「四条 t+app+dur 相同的记录必须读回四条」用例当场抓住（先返回 5，修一版后返回 3）。

### 测试
12 个用例（T-R02 五种组合 + 三副本收敛 + 主文件优先等）。

---

## 阶段四：编辑时只补被编辑那条的 rid ✅ `57fa0bc`

### 已完成
`updateDisplayRecord` 中 `if (!next.rid) next.rid = crypto.randomUUID()`，**仅此一行**。
其他行继续以**原始字符串**写回（不是 `JSON.parse`→`JSON.stringify` 往返），字段顺序与损坏行都原样保留。

### 测试
9 个用例（T-R03 / 验收第 4 条），逐字节比对未被编辑的行。

---

## 阶段五：修正旧断言 ✅ `3761f62`

`tests/duplicateImport.test.cjs` 有两个用例原本用 `KNOWN ISSUE` 锁定**错误行为**。行为已修正，断言同步改为断言正确行为（**不是放宽**）：
- 底层 `saveActivity` 仍无内容去重 → 断言它「不应有」，并新增用例证明重复导入由指纹层拦截
- 同一 rid 主文件+副本 → 断言 1 条（原断言 2 条）
- 新增反向用例：不同 rid 时 2 条都要留

---

## 独立审计（V0.10.3）

| 审计项 | 结果 |
|---|---|
| 是否批量改写历史 rid | ✅ 6 处生成点**全部**带 `if (!x.rid)` 守卫，只作用于新记录 |
| 读取路径是否凭空生成 rid | ✅ `_fromSegment` 只透传 `rec.rid \|\| null` |
| 迁移引擎是否受影响 | ✅ `git diff 4bf954f..HEAD -- electron/legacyMigration.js` **为空** |
| 导入记录是否被强加 rid | ✅ 导入只带 `imp`，不带 rid（有测试锁住） |
| 内容去重是否被引入 | ✅ 无任何按内容判重的代码；`saveActivity` 明确不加 |

### 审计发现的既有边界（非本版本引入，如实记录）
`updateDisplayRecord` 只处理 `activities/<date>.jsonl`，而导入写的是 `activities/<date>.json`（JSON 数组）。因此**导入的记录目前无法通过编辑通道补 rid**。这是既有架构分裂，不在 V0.10.3 范围内改动，已写进测试注释与风险清单。

---

## V0.10.3 回归实测

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run lint` | **0** | 0 error / 0 warning |
| `npm run build` | **0** | built successfully |
| `npm test` | **1** | **250 tests，249 pass，1 fail** |

唯一失败仍为 `tests/focusEditing.test.cjs` → `Electron failed to install correctly`（二进制未下载，DNS 受限）。V0.10.3 **未触碰该文件**，断言未放宽。

## V0.10.3 验收标准核对

| # | 标准 | 结果 |
|---|---|---|
| 1 | 新录制片段带 rid，重启后不变 | ✅ `T-R01 the rid survives a write and a read` |
| 2 | `t+app+dur` 相同的 4 条仍读回 4 条 | ✅ `the four records with identical t/app/dur all survive` |
| 3 | 同 rid → 1；不同 rid → 2；无 rid → 2 | ✅ `conflictDedupe` 前四个用例 |
| 4 | 编辑 1 条后其他记录逐字节不变 | ✅ `T-R03 the other records come back byte for byte identical` |
| 5 | `-backup`、`.old` 不再被读为当天数据 | ✅ `dayFilePattern` |

## V0.10.3 未做 / 已知风险

| 项 | 说明 |
|---|---|
| 导入记录无 rid | 符合设计（导入靠 `imp` + 指纹去重）。但导入记录无法经编辑通道补 rid，属既有架构分裂 |
| 跨午夜拆分的两段 | 各自独立 rid，但 `groupId` 相同，展示层仍可按 group 合并 |
| 内容去重 | **永不做**（方案 §3.5 / §4.4 明确） |
| 旧数据批量补 rid | **永不做**（§4.6） |
| 摘要 rid | 本版本只覆盖活动记录；摘要的 `id` 仍由调用方生成 |

## 提交记录（V0.10.3）

| Commit | 内容 |
|---|---|
| `ec3e142` | Only read the two file names a sync client actually creates |
| `6705f42` | Give every record a rid that survives a restart |
| `352ae8e` | Merge duplicates across copies, never within a file |
| `57fa0bc` | Backfill a rid for the edited record, and only that one |
| `3761f62` | Rewrite the two duplicate tests that had been pinning the bug |
