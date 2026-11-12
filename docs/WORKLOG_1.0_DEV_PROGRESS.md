# WorkLog 1.0 开发进度 — V0.10.2a

> 冻结方案基线：`1de413e`（docs: freeze the WorkLog 1.0 plan for V0.10.2a）
> 开发分支：`workbuddy/worklog-1-0-dev-2a79589a`
> （任务书写的是 `ai/overnight-v0102a`；实际分支以 Git 为准，未强行改名以免打断已有提交）
> 开发版本：V0.10.2a
> 依据：`docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` §2.5 / §2.5a / §2.5b / §2.6 / §2.6a / §2.8 / §2.10 / §2.11 / §2.13 / §2.14

> **上下文恢复指引**：若会话被压缩或中断，先读本文件 + `git log --oneline -8`，从「下一步任务」继续。

---

## 阶段总览

| 阶段 | 内容 | 状态 | Commit |
|---|---|---|---|
| 一 | 统一写入锁 | ✅ 完成 | `f814fc7` |
| 二 | 独立迁移引擎 | ✅ 完成 | `c9e4e67` |
| 三 | 故障注入测试（F 11 + S 11） | ✅ 完成 | `e00c6da`、`92d49bc` |
| 四 | 回归测试（test / lint / build） | ✅ 完成 | 见下方实测结果 |

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
