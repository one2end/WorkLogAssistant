# WorkLog 1.0 开发进度 — V0.10.2a

> 冻结方案基线：`1de413e`（docs: freeze the WorkLog 1.0 plan for V0.10.2a）
> 开发分支：`workbuddy/worklog-1-0-dev-2a79589a`（任务书写的是 `ai/overnight-v0102a`，实际分支名以 Git 为准，未强行改名以免打断已有提交）
> 开发版本：V0.10.2a
> 依据文档：`docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` §2.5 / §2.5a / §2.5b / §2.6 / §2.6a / §2.8 / §2.10 / §2.11 / §2.13 / §2.14

> **上下文恢复指引**：若本会话被压缩或中断，先读本文件 + `git log --oneline -10`，再从「下一步任务」继续。

---

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 统一写入锁 `electron/writeGate.js` + 15 个写方法接入 + 录制器缓冲 | ✅ 完成 |
| 二 | 独立迁移引擎 `electron/legacyMigration.js` | ⏳ 进行中 |
| 三 | 故障注入测试（F 系列 11 点 / S 系列 11 点） | ⏳ 待开始 |
| 四 | 回归测试（test / lint / build） | ⏳ 待开始 |

---

## 阶段一：统一写入锁 ✅

### 已完成内容

1. **新建 `electron/writeGate.js`**
   - `tryAcquire(owner, reason)` / `release(owner)` / `forceRelease()`：owner 校验，非持有者释放无效
   - `withMigrationContext(fn)`：用 `migrationDepth` 计数器（支持嵌套），迁移自身写入不被自我阻塞
   - `assertWritable(operation)`：特权上下文放行，否则抛 `WriteBlockedError`（`code = 'MIGRATION_IN_PROGRESS'`）
   - `onReleased(fn)`：迁移结束回调，供录制器主动补 flush
   - `isLocked()` / `getHolder()` / `inMigrationContext()` / `_resetForTests()`

2. **`electron/storageManager.js` 接入 15 个写方法**（§2.13 表格逐条对齐）
   `saveActivity`、`appendActivityRecords`、`deleteActivity`、`updateDisplayRecord`、
   `deleteDisplayRange`、`replaceDisplayRanges`、`recategorizeAppForDay`、`deleteDisplayRecord`、
   `clearActivities`、`saveSummary`、`deleteSummary`、`saveScreenshot`、`cleanupOldData`、
   `migrateDataTo`、`setDataDir`
   - `_writeJsonFile` 按规范**不单独加锁**（内部工具，由调用方负责）
   - **关键实现细节**：`assertWritable` 一律放在 `try` 块**之外**。这些方法内部 `catch` 会把异常吞成 `return false`，若把断言放进 `try`，阻断语义就退化成静默失败，调用方无法区分「迁移中」和「写失败」。

3. **`electron/activityRecorder.js` 缓冲处理**
   - `flush()` 捕获到 `MIGRATION_IN_PROGRESS` 时：片段**原样放回、不截断**（规范明确禁止迁移分支走 `slice(-200)`），返回 0，只提示一次（`_gateNoticeShown` 防刷屏）
   - 普通写失败仍保持原有 `slice(-200)` 行为，**未改变既有语义**
   - 订阅 `writeGate.onReleased`：迁移一结束立即补 flush，不等 15 秒周期；`stop()` 时取消订阅

### 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `electron/writeGate.js` | 新增 | 统一写入闸门 |
| `electron/storageManager.js` | 修改 | 15 个写方法首行加断言（+23 行） |
| `electron/activityRecorder.js` | 修改 | 缓冲不截断 + 释放后自动 flush（+32 行） |
| `tests/writeGate.test.cjs` | 新增 | 12 个用例 |

### 测试结果

`node --test tests/writeGate.test.cjs` → **12 pass / 0 fail**

覆盖条目：T-M09（部分，锁层）、T-M10、T-M16、T-M17、T-M18、T-M19、T-M20、T-M21、T-M22，另加「非持有者不能释放」「迁移上下文可写」「非锁错误仍截断 200」三个补充用例。

**T-M18 的验证方式**：15 个方法逐个调用，断言 `error.code === ERR`，且 `dataDir` 下没有新建 `elsewhere` 目录；每个用例都比对 `activities/` 全目录 SHA 前后一致，而不是只看有没有抛错。

### Git Commit

`见下方提交记录`

### 未完成 / 已知边界

- 加锁前若不释放（进程被强杀），锁是内存态的，重启即失效——这是设计如此，不需要持久化
- 应用内锁**防不住** iCloud / OneDrive / 杀毒软件 / 手工编辑器（§2.13 明确的能力边界），外部修改只能靠 SHA256 检测

---

## 环境备注（重要，会影响「测试失败数」的口径）

- 接手时 `node_modules` **完全未安装**，`npm test` 的 5 个失败**全部是 `Cannot find module 'axios'` 等缺依赖导致**，与代码无关
- 已执行 `npm install`，之后基线失败从 5 降到 1
- 剩余 1 个失败：`tests/focusEditing.test.cjs` → `Electron failed to install correctly`，是 Electron 二进制未下载的环境问题，**与 V0.10.2a 改动无关**（本阶段未触碰 focus 相关代码）
- `npm run lint` 在依赖未装时输出 `'eslint' 不是内部或外部命令`，安装后待复验

---
