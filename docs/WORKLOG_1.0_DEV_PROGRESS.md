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

---

# V0.10.4：15 分钟规则统一

## 阶段零：开发前核查结论

**V0.10.3 远端状态**：六个提交全部存在且已推送，本地 HEAD `8d960da` 与远端 `workbuddy/worklog-1-0-dev-2a79589a` 完全一致，工作区干净。

`master` 仍是 `f1b612c` **不是同步失败**——全部 V0.10.2a/2b/3 工作都在独立开发分支上，按约束从未向 master 推送。经核验 `1de413e`（冻结方案提交）并不在 master 历史上。

**方案与实际代码的 3 处不一致**（已如实报告并处理）：
1. 方案 §5.2 标题写「7 处」，正文只列了 6 项 —— 实际按盘点结果处理
2. 全部行号因前两版改动而偏移（`main.js` +35、`storageManager.js` +82）
3. 全项目实际有 28 处 15 分钟计算，远多于方案列的 6 处

## 阶段一：规则差异量化

用脚本对比当前规则与方案规则，14 个代表性输入中 **6 个结果不同**：

| 输入 | 旧规则 | 新规则 | 性质 |
|---|---|---|---|
| `09:07 + 95min` | 09:00–10:30 (90分) | 09:00–10:45 (**105分**) | 少记 15 分 |
| `09:07 + 35min` | 09:00–09:30 (30分) | 09:00–09:45 (**45分**) | 少记 15 分 |
| `09:14 + 15min` | **09:00**–09:15 | **09:15**–09:30 | 起点前移 |
| `09:07 + 3min` | 存成 15 分 | **拒绝** | 虚假工时 |
| `09:07 + 8min` | 存成 15 分 | **拒绝** | 虚假工时 |
| `23:53 + 15min` | 23:45–24:00 | **拒绝** | 起点跨日 |

## 阶段二：`slotRule.js` 接口

严格按方案 §5.1，未扩展：

```js
snapStart(dateStr, startHHMM)              // → { startMin, crossDay }
deriveEnd(startRaw, durationMin)           // → { endRaw, crossMidnight }
snapEnd(endRaw)                            // → { endMin }  允许 1440
snapRange(dateStr, startHHMM, durationMin) // → { startMin, endMin, durationMin, crossMidnight, distorted, rejected?, reason? }
findOverlaps(dateStr, start, end, records) // → [{ index, record, overlapMs, overlapMin, kind, source }]
```

另有 `snapToStep` / `formatHHMM` / `parseHHMM` 供内部与调用点复用，避免任何地方再写一遍 `round(x/15)*15`。

**核心不变量**：时长 = `snapEnd - snapStart`，**绝不对时长二次取整**。有专门用例逐一核对 `durationMin === endMin - startMin`。

## 阶段三：调用点替换

### A 类：真正的时间吸附（8 处已替换）

| 位置 | 改动 |
|---|---|
| `main.js` 人工补记 | 整段吸附改为 `snapRange`，最短时长用原始值判定 |
| `storageManager.js` 覆盖标注 | 起点/时长改为 `snapRange` |
| `App.vue` 活动线程确认 | 不再自行取整，传原始时长由主进程吸附 |
| `TimelineView.vue` `minuteAt` | 像素换算保留，吸附改调 `snapToStep` |
| `planManager.js` upsert | 仅统一吸附用 `snapToStep`（**B1**） |

### D 类：TimelineView 逐处判定（按裁定有条件修改）

| # | 职责 | 处理 |
|---|---|---|
| D1 `L1264` | 拖计划块改时长 | 吸附改 `snapToStep`，夹取 `[15,1440]` 保留 |
| D2 `L1300/1838` | 像素→分钟换算 | **不替换**（纯 UI 坐标） |
| D3 `L1362` | 拖动前算块高 | 吸附改 `snapToStep` |
| D4 `L1377` | 拖动位移格数 | 格差吸附改 `snapToStep`，夹取保留 |
| D5 `L1830` | 缩放前算块高 | 吸附改 `snapToStep` |
| D6 `L1843/2186` | 缩放终点 + 快捷补记默认时长 | 吸附改 `snapToStep`，夹取保留 |
| A7 `L1128` | `minuteAt` 夹取 | **`Math.max(0, Math.min(1440, ...))` 一行未动** |

### 未替换（按裁定与性质）

| 位置 | 原因 |
|---|---|
| `planManager.js:188/189` | **B2/B3，裁定明确不改**（计划语义，非事实补记） |
| `analytics.js:1212/1214` | 统计聚合，非吸附 |
| `TimeRangePicker.vue:47` | 滑块步长 |
| `TimelineView:2027/2043` | 当前时刻取整，UI 默认值 |

### 渲染层如何共享同一份实现

通过 `vite.config.js` 别名 `@slot-rule` 指向 `electron/slotRule.js`，并在 `build.commonjsOptions` 中允许 CJS 转换。**没有复制到 `src/`** —— 复制会编译通过、测试通过，然后在某个时刻悄悄漂开，第一个症状是「预览说 105 分、实际存了 90 分」。

## 阶段四：重叠检测与失真提示

**§5.4 规则落地**：
- 与**自动记录**重叠 → 提示但允许（补记的正当用途）
- 与**另一条人工记录**重叠 → 默认阻断，返回 `OVERLAP_MANUAL`
- 任何情况下**不动记录层**

**失真标记**：`snapRange` 返回 `distorted`（吸附是否改变了时长）与 `rawDurationMin`，UI 据此提示「输入 22 分钟 → 将保存为 15 分钟」。本来就对齐的输入不会误报。

**新增只读 IPC `preview-snap`**：渲染层无法 require 主进程模块，但预览结果必须与落盘一致，所以让渲染层问主进程要结果——同一份代码、同一次计算。

## 阶段五：测试改造

`manualSnap.test.cjs` 删除 `snapCurrent()` 复刻函数，改为直接调用 `slotRule`。
- 原 `KNOWN ISSUE` 用例改为断言**正确行为**（不是放宽）：`09:14 + 22min` 现在起点是 `09:15` 而非 `09:00`
- 新增一条元测试：断言测试文件里**不得再出现** `snapCurrent` 或手写 `round(x/15)*15`

## 测试与回归实测（V0.10.4 收尾后）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run lint` | **0** | 0 error / 0 warning |
| `npm run build` | **0** | ✓ built |
| `npm test` | **0** | **305 tests，305 pass，0 fail** |

新增测试：`slotRule.test.cjs` 34 项、`overlapDetection.test.cjs` 10 项、`slotRuleUi.test.cjs` 7 项；`manualSnap.test.cjs` 由 6 项改造为 9 项。

**`focusEditing.test.cjs` 已修复**——它只需要为 `electron.app.getPath` 提供桩，与后写的测试做法一致。这条从 V0.10.2a 之前就存在的失败至此消失，**整套测试首次全绿**。

## 独立审计

| 审计项 | 结果 |
|---|---|
| 迁移引擎 / 写入锁 / 导入指纹 / imp 机制 / timeSplit / didaSync | ✅ `git diff 8d960da..HEAD` **无输出**，完全未动 |
| 记录层毫秒级时长 | ✅ `slotRule` 只读 `durationMs` 计算重叠，从不写回；有文件哈希对比测试 |
| A7 夹取 `Math.max(0, Math.min(1440, ...))` | ✅ 原样保留（`L1128`） |
| D 类夹取 | ✅ `Math.max(15, Math.min(1440, ...))` 全部保留 |
| 原始 JSONL 数据结构 | ✅ 仅 `main.js` 新增返回字段，写入结构未变 |
| 与版本无关的 UI | ✅ 仅 `TimelineView` 吸附算法与 `App.vue` 时长传递，无布局改动 |

## 开发过程中发现并修复的实现缺陷

`snapToStep` 最初用 `Math.round(minutes / 15) * 15`，被测试当场抓住：**`22.5 / 15` 在浮点下等于 `1.4999999999999998`**，`Math.round` 得 1，于是 22.5 被吸附到 15 而不是 30——与「中间值向后取」的约定相反，且只在特定数值上出错。改为整数运算 `Math.floor((2x + 15) / 30) * 15`，并有用例固定 `snapToStep(22.5) === 30`。

## V0.10.4 未做 / 已知边界

| 项 | 说明 |
|---|---|
| `analytics.js` 专注聚合取整 | 属统计展示，非落盘吸附，未纳入 |
| `planManager` 起点向下取整 | B2，按裁定保留（计划语义） |
| TimelineView 当前时刻取整 | UI 默认值（新建块的默认起点），非数据吸附 |
| 历史记录 | **不做任何回填或迁移**，旧记录保持原有数值 |
| 滴答清单同步的计划起点 | 只用 `snapToStep` 统一时长吸附，起点沿用外部给的分钟数 |

### 收尾阶段（同一版本内完成）

按「版本以完整目标为单位」的原则，把 §5.3 的三条 UI 要求一并做完：

| 方案要求 | 落地 |
|---|---|
| §5.3-1 保存前显示吸附结果 | `SegmentEditor` 显示「09:07—10:42 → 将保存为 09:00—10:45，共 105 分钟」 |
| §5.3-2 失真必须明确告知 | 另起一行「输入 22 分钟，吸附后为 15 分钟」；对齐的输入不显示 |
| §5.3-3 不足 15 分钟提示 | 显示「人工记录最短 15 分钟，当前 3 分钟，请调整时间」并禁用保存按钮 |

**过程中发现的根因**：§5.3-3 这条提示此前**从来没有触发过**。`SegmentEditor.submit` 与
`TimeRangePicker.setDuration` 都在提交前把时长下限夹到 15——用户填的 3 分钟到达主进程时
已经是 15，后端校验永远看不到原始值。表面上只是「保证最小值」，实际把校验对象提前修正没了。
现在两处下限都改为 1，真正的判定只在 `slotRule` 里做一次。

**didaSync 的同类问题**：`didaSync.js:488` 只把毫秒换成整分钟，**从未吸附到 15**，
于是 `1234567ms` 会得到 21 分钟——全项目只有这一处会产生非整格时长。已统一。

**`focusEditing.test.cjs` 修复**：该测试只需为 `electron.app.getPath` 提供桩，与后写的测试
完全同一做法。此前一直归因为「环境限制」，实际是测试本身的写法问题。修掉之后整套测试首次全绿。

## 提交记录（V0.10.4）

| Commit | 内容 |
|---|---|
| `71ea96a` | Write the fifteen-minute rule down once |
| `12316ea` | Route every snapping call site through the one rule |
| `2e00003` | Stop testing a copy of the rule, and check overlap without touching samples |
| `5b5bdd5` | Write down what V0.10.4 changes for the user, not just the code |
| `afb30b7` | Show what will be saved before saving it, and stop lying about the minimum |

---

# V0.10.5：存储目录可靠性与主线程卡死

依据：`docs/WORKLOG_1.0_AUDIT_ROUND2.md`「V0.10.5 — 存储目录可靠性与主线程卡死（P1）」

## 任务一：切目录前预检 ✅ `be1dce6`

新增 `electron/storagePrecheck.js` + `storagePrecheckWorker.js`。

检查两项：
1. **真的写一个探针文件再删掉**——只查权限位不够，同步盘、只读挂载、权限继承异常的目录常常通过权限检查但写不进去
2. **抽样读真实数据文件并计时**——这是唯一能发现「仅在线文件」的办法

**预检本身跑在子进程里**：如果读云端占位文件会阻塞，在主进程做预检就等于把要防的问题自己做一遍。父进程到点 kill，结果按「拒绝」处理而不是「通过」。

覆盖两个入口：`migrate-storage` 与 `save-config`（后者更隐蔽——用户改个开关可能顺手把路径也换了）。

**偏离方案的一处，已说明理由**：方案要求检测 `0x400000` 属性位。Node 的 `fs.stat` 拿不到 Windows 文件属性位，要实现就得引 native 模块。**与其写一个永远返回 false 的 `isCloudOnly()` 让人误以为检查过了，不如用「实际读一次并计时」**——它测的正是真正会让界面卡住的那个操作，且跨平台成立。实现时先写了 `isCloudOnly` 的空壳，随即删掉，因为留着比没有更糟。

## 任务二：报表计算迁 worker ✅ `91922d4`

新增 `electron/reportWorker.js` + `reportRunner.js`。

- 只开放只读作业（`dayReport` / `rangeReport` / `listApps`）；任何写操作都不进 worker——会让写锁与迁移的时序无法推理
- 超时 `terminate()`，默认 15s

**最关键的设计决定是失败时的行为**：超时、崩溃、线程起不来，**一律回退到主进程同步计算**，绝不返回空报告。空报告在界面上表现为「今天没有记录」，用户会以为数据丢了。慢而正确，好过快而错——尤其在「你到底有没有记录」这个问题上。

回退会写日志，超时的情况还会指出可能的云端目录问题，让降级路径有机会被发现并修掉，而不是悄悄变成常态。

## 任务三：缓冲溢出不再丢数据 ✅ `17accb8`

`activityRecorder.flush()` 的 `slice(-200)` 改为溢出到 `activities/<日期>.overflow.jsonl`。

- 缓冲仍维持 200 条上限（无限增长只是把问题搬到内存）
- 溢出**追加**而非覆盖，重复失败会累积
- 落在独立文件，**不自动合并回主文件**——那会让报表在没人知道原因的情况下变化。文件留给人工处理
- `onOverflow` 回调把条数与路径交给上层，UI 才有机会提示

迁移期间被写锁拒绝的路径**保持原样**（全部留在内存不截断）——迁移是有界事件，在那里丢数据和这里犯的是同一个错。

## 测试与回归实测

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run lint` | **0** | 0 error / 0 warning |
| `npm run build` | **0** | ✓ built |
| `npm test` | **0** | **332 tests，332 pass，0 fail** |

新增：`storagePrecheck.test.cjs` 12 项、`reportWorker.test.cjs` 9 项、`recorderOverflow.test.cjs` 6 项（共 27 项）。

## 独立审计

| 审计项 | 结果 |
|---|---|
| 迁移引擎 / 写入锁 / 导入安全 / 指纹 / slotRule / timeSplit | ✅ `git diff b9cd041..HEAD` **无输出** |
| worker 是否含写操作 | ✅ 无 `writeFileSync` / `appendFileSync` / `saveActivity` |
| 预检是否碰数据文件 | ✅ 只写一个探针文件并立即删除 |
| 失败是否伪装成空数据 | ✅ 三个降级分支全部回退同步计算，有测试断言 `recordedMs > 0` |
| 溢出数据是否回流主文件 | ✅ 不回流，独立文件留待人工 |

## 过程中修复的两个自身问题

1. **`isCloudOnly` 空壳**：先写了一个永远返回 false 的实现。这种代码比没有更糟——它让「已检查云占位」这句话变成假的。已删除并说明替代方案。
2. **worker 注入点**：`buildDayReportSafe` 内部直接调用 `runInWorker`，从外部替换导出属性不生效。改为支持 `ro.runner` 注入，测试才能真正走降级分支而不是假装走。

## V0.10.5 未做 / 已知边界

| 项 | 说明 |
|---|---|
| `storageManager` 读路径仍在主进程 | 按方案建议分两次提交，本次只做 `analytics`。`storageManager.getActivities` 同步调用点多，改造面大，留待后续 |
| `rangeReport` / `listApps` | worker 已支持，但调用点尚未接入（`buildDayReportSafe` 只覆盖日报） |
| 溢出文件的手工合并 | 未提供工具，文件格式与主文件一致，可直接人工处理 |
| `0x400000` 属性检测 | 明确不做，理由见上 |

## 提交记录（V0.10.5）

| Commit | 内容 |
|---|---|
| `17accb8` | Spill the buffer to a file instead of silently dropping the oldest records |
| `be1dce6` | Check that a storage directory can actually be read before switching to it |
| `91922d4` | Compute day reports off the main thread, and never report failure as emptiness |

---

# V0.10.6：规划完成（未开发）

> 本轮只做规划，**未修改任何生产代码**。
> 完整任务书：`docs/WORKLOG_1.0_V0106_TASK.md`

## 版本范围调整

原计划：
- V0.10.6 = Electron 安全改造（S1-S6）
- V0.10.7 = 代码清理（含密钥加密、CORS、openExternal）

现合并为 **V0.10.6 = Electron 安全与本地数据边界加固**，含三组：
- **A** Electron 运行环境（S1-S6 保持原样）
- **B** 本地数据与访问（原 V0.10.7 安全项）
- **C** AI 隐私与数据出口（本版新增）

V0.10.7 缩减为 `atomicFile` 错误链 + 文件拆分 + 一般清理。

## 实测现状（本次重新扫描，非引用旧报告）

| 项 | 实测值 |
|---|---|
| 窗口数 | 3（main / focus / float） |
| `nodeIntegration: true` | 3 处全部开启 |
| `contextIsolation: false` | 3 处全部关闭 |
| `enableRemoteModule: true` | 1 处（Electron 28 起无效） |
| IPC 通道 | **74 个**（审计文档写 73，多的是 V0.10.4 新增的 `preview-snap`） |
| 前端 `require('electron')` | 6 个文件 |
| 小窗加载方式 | `loadFile(focus.html)` / `loadFile(float.html)`，非 Vue |
| `safeStorage` | 未使用 |
| 密钥 | 分文件（`config.local.json`）但明文 |
| CORS `*` | 3 处 |
| `openExternal` | 1 处，token 拼进 URL |
| AI 发送 `windowTitle` | 是（3 处） |

## 权限矩阵：静态扫描核实结果

D-03 要求「必须经过完整静态调用扫描核实」。扫描结果：

- **focus.html 实测调用**：`focus-add-note`、`focus-end`、`focus-hud-expand`、`focus-toggle-pause`、`show-main-window`
- **float.html 实测调用**：`get-float-bounds`、`save-float-width`、`set-float-pos`、`set-float-width`、`show-main-window`、`toggle-monitoring`

与 D-03 给定矩阵**完全一致**：64 主窗专用 + 1 三窗共享 + 1 双窗共享 + 4 专注专用 + 4 悬浮专用 = **74** ✅

**额外发现（D-03 未列，但第 7 条要求纳入）**：事件订阅白名单
- focus.html 订阅：`focus-hud`、`focus-theme`
- float.html 订阅：`float-accent`、`float-theme`、`float-update`、`float-monitoring-status`

## 已冻结的产品决策（来自 D-01 / D-02 / D-03 裁定）

| 决策 | 值 |
|---|---|
| `ai.enabled` | false（不变） |
| `ai.sendAppName` | true（仅 AI 开启后生效） |
| `ai.sendWindowTitle` | **false**（必须用户主动开启） |
| safeStorage 不可用 | 降级明文 + 持续提示，**不清空配置、不改 AI 状态** |
| 密钥迁移 | 临时文件 + 原子替换 + 读回解密验证，成功后才清明文 |
| 密文解不开 | 不解释为空、不覆盖原值 |
| IPC 校验 | 三角色 + 默认拒绝 + 身份/mainFrame/URL/参数四重校验 |

## 开发计划（10 阶段）

| 组 | 阶段 | Commit 粒度 |
|---|---|---|
| A | A1 preload（不启用）/ A2 前端迁移 / A3 小窗隔离 / A4 主窗隔离 / A5 移除 require / A6 矩阵校验 | 6 |
| B | B1 密钥加密 / B2 openExternal / B3 CORS / B4 删 enableRemoteModule | 4 |
| C | C1 AI 出口过滤 + 标题开关 / C2 设置页展示 | 2 |

## 回退方案

- A 组每阶段独立 `git revert`，A4（主窗隔离）风险最高，失败不影响 A1-A3
- B/C 同理
- `safeStorage` 迁移保留明文备份 `.local.json.bak`

## 本轮产出

| 文件 | 变更 |
|---|---|
| `docs/WORKLOG_1.0_V0106_TASK.md` | **新增**，完整任务书 |
| `docs/WORKLOG_1.0_AUDIT_ROUND2.md` | 更新 V0.10.6 / V0.10.7 范围 |
| `docs/ROADMAP.md` | 新增「六·五 V0.10.x 工程治理」章节 |
| `docs/WORKLOG_1.0_DEV_PROGRESS.md` | 本段 |

**生产代码零改动**（`git status` 除上述文档外应为空）。
