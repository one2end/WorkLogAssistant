# WorkLog 1.0 第二轮独立工程审查报告

> 审查对象：分支 `worklog-1.0-dev`，提交 `f4b0dad21945976dceb3ff1a38a7b1f44faa83ee`
> 对照文档：`docs/WORKLOG_1.0_AUDIT.md`（第一轮）
> 审查日期：2026-11-12
> 性质：**只读审查 + 文档修订**。本轮不修改任何生产代码、不改数据格式、不删功能、不清洗历史数据、不开始 V0.10.2。

> ## ✅ 本报告已通过审查，四项决策已确认（2026-11-12）
>
> 用户确认了 D-01 至 D-04 四项决策，并推翻了本报告的两处建议。**实施以 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` 为准**，本报告保留作为审查记录。
>
> ### 决策确认结果
>
> | 决策 | 用户结论 | 与本报告建议的关系 |
> |---|---|---|
> | **D-01** | 取消危险的覆盖导入入口；保留合并导入；普通导入不得清空原始记录；**恢复备份单独立项**，需含快照/校验/暂存/原子替换/回滚/二次确认 | 采用报告建议 A，并补充「不要认为切换数据目录等价于导入备份」 |
> | **D-02** | 起止**分别就近吸附**，时长 = 吸附后结束 − 开始，**不再单独取整**；最短 15 分钟；重叠需提示不得静默覆盖 | 采用报告建议，并给出明确样例 `09:07—10:42 → 09:00—10:45 = 105 分钟` |
> | **D-03** | 新记录 UUID `rid` 落盘；不批量改写历史；旧数据文件名+行号**仅作兼容定位，不宣称永久稳定**；只有确认同一副本才去重 | 采用报告方向，但**推翻了 `importBatchId` 与「稳定指纹」两处设计**，见下方更正 |
> | **D-04** | 拆成 V0.10.2a（迁移幂等）与 V0.10.2b（导入安全），独立提交/测试/验收；迁移**不能只靠 pending/completed 状态文件**，需可恢复流程 | 采用报告建议 B，并要求更强的迁移设计 |
>
> ### 本报告需要更正的两处
>
> **更正 A：`importBatchId` 方案作废（4.4 节）**
>
> 原文建议「导入引入 `importBatchId`，同批次内去重」。用户指出：每次重新导入都会生成新 ID，**无法阻止用户重复导入同一个文件**。批评正确。改为**基于导入文件内容的指纹**（`sha256(归一化内容)`），实现整文件粒度的幂等提示，同时保留同一文件内部的合法重复。详见实施计划 4.4。
>
> **更正 B：「文件名+行号」不能称为稳定指纹（P0-03）**
>
> 原文写「旧记录用『文件名+行号』推导稳定指纹」。措辞过强 —— 行号在文件被任何一次重写后都会变（`replaceDisplayRanges` 就是整文件重写）。正确定位：**仅用于同一次读取过程中的兼容定位**，不是持久身份，不可用于跨读取的去重判断。详见实施计划 4.3。
>
> ### 本次审查附带发现的额外问题（已并入实施计划）
>
> `_activityFilesOfDay` 的副本匹配用 `name.startsWith(dateStr) && name.endsWith('.jsonl')`，范围过宽。实测会命中用户手工备份文件 `2026-11-08-backup.jsonl`、`2026-11-08.old.jsonl`，导致当天工时虚高。已给出严格正则并验证，列入 V0.10.3。

> ## ✅ v2 修订（2026-11-12 00:55，第二轮意见）
>
> 实施计划 v1 经审查后又收到七项修订意见，**全部成立**。本报告与第一轮报告已同步更正，实施细节以 `docs/WORKLOG_1.0_IMPLEMENTATION_PLAN.md` **v2** 为准。
>
> ### 七项修订与本报告的关联
>
> | # | 意见 | 本报告受影响处 |
> |---|---|---|
> | 1 | 摘要迁移也需保护 | P0-02 原文只提 `activities.json`，**遗漏了 `summaries.json`**。核实：`storageManager.js:261` 同样是 `existing.concat(items)`，风险完全相同 |
> | 2 | rename 与 status 之间的崩溃窗口；F7 不能直接建新 workspace；回滚不能删目录 | P0-02 的恢复方案需从「状态文件」升级为「SHA256 比对」；F7 与回滚描述需重写 |
> | 3 | D-02 短时间选 B 拒绝；区分跨午夜；不能宣称消除失真 | §一 D-02 相关描述、第一轮 5.4 节的「完全消除失真」说法需**作废** |
> | 4 | 重叠处理分级 | §P1-03 需补：自动记录可覆盖（写展示层）、人工记录阻断、记录层永不变 |
> | 5 | RID 补齐限制 | P0-03 需补：只给被编辑那一条补，其他逐字节不变 |
> | 6 | 导入快照扩至三目录；逐条统计；指纹覆盖全部数据 | P1-01 需补：`summaries_md/`、`succeeded/failed/skipped`、指纹含摘要 |
> | 7 | 版本拆分确认 | §五 路线图拆 0.10.2a / 0.10.2b |
>
> ### 本报告需要再更正的一处
>
> **P0-02 遗漏摘要迁移。** 原文只分析 `activities.json` 的重复累计，实际 `summaries.json`（`storageManager.js:248-270`）有一模一样的问题。虽然摘要条数少、影响面小，但**两套必须同等保护**，否则修了活动漏了摘要。
>
> ### 对「完全消除失真」的自我更正
>
> 第一轮报告 5.4 节曾写「D-02 从根上消除了『填 22 分钟存 15 分钟』的失真」。**这句话是错的。**
>
> D-02 只取消了「独立的时长取整」环节，但**吸附本身仍会改变时长**：`09:00 + 22min` 吸附为 `09:00—09:15`，实际仍存 15 分钟。已在该处作废并更正，同时明确「保存前显示吸附结果」是必需措施而非可选优化。

---

## 零、总体判断

外部审查提出的四个问题，**四个全部成立**，其中两个比外部意见描述的更严重。

| # | 外部意见 | 核实结论 | 严重度 |
|---|---|---|---|
| 1 | 覆盖导入可能破坏原始记录 | **成立，且更严重**：不止覆盖导入，`clearActivities()` 直接 `unlinkSync` 且**没有任何备份** | **P0** |
| 2 | 迁移幂等性存疑 | **成立**：实测 `1 1 1` → 重启后 `2 2 2` | **P0** |
| 3 | 安全结论描述不准确 | **成立，我上一轮错了**：`enableRemoteModule` 在 Electron 28 已移除，是无效选项，不是风险点 | P1（降级） |
| 4 | 不能用 `t+app+dur` 去重 | **成立，且更严重**：实测会把 4 条合法记录合并成 1 条 | **P0**（设计层） |

同时，外部审查对测试质量的四条质疑**全部成立**。我上一轮的测试存在实质缺陷，必须如实修正，不能掩饰。

第一轮报告中有 3 处结论需要更正，2 处需要补充，见第三节。

---

## 一、问题清单（可直接转化为开发任务）

### 问题 P0-01：覆盖导入永久删除原始自动采集记录

**严重程度**：P0
**涉及文件与位置**：

| 文件 | 位置 | 行为 |
|---|---|---|
| `src/views/SettingsView.vue` | 277 行 | 「覆盖」按钮 → `$emit('import-overwrite')` |
| `src/views/SettingsView.vue` | 279 行 | 提示文字：「『覆盖』仅对单文件导入生效」 |
| `src/App.vue` | 172-173 行 | 事件绑定 `@import-overwrite="importData('overwrite')"` |
| `src/App.vue` | 1175 行 | `importData(mode)` → `ipcRenderer.invoke('import-data', mode)` |
| `electron/main.js` | 1514-1516 行 | `if (mode === 'overwrite') { storageManager.clearActivities(); }` |
| `electron/storageManager.js` | 663-678 行 | `clearActivities()` 遍历 `activitiesDir` 删所有 `.json` 和 `.jsonl` |

**代码实证**（`storageManager.js:663-678`）：

```js
clearActivities() {
  try {
    const removed = new Set();
    for (const dir of [this.activitiesDir]) {
      if (!fs.existsSync(dir)) continue;
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
        .forEach(f => removed.add(path.join(dir, f)));
    }
    removed.forEach(p => fs.unlinkSync(p));   // ← 直接删除，不进回收站
    return true;
  } catch (error) { /* 仅 console.error */ }
}
```

**实测复现**（临时目录，未触碰真实数据）：

```
清空前文件: [ '2026-11-07.json', '2026-11-08.jsonl' ]
清空前 11-08 记录数: 1     ← 原始自动采集记录（source 缺省 = 记录层）
清空前 11-07 记录数: 1     ← 旧版 JSON
clearActivities 返回: true
清空后文件: []
清空后 11-08 记录数: 0
清空后 11-07 记录数: 0
数据目录全部内容: [ 'activities', 'screenshots', 'summaries' ]   ← 无任何备份残留
```

**影响范围**：

1. 删除的是 `activities/` 下**全部** `.json` 与 `.jsonl`，不分层，**记录层与展示层一起删**
2. 使用 `fs.unlinkSync`，不进系统回收站，**不可恢复**
3. 删除发生在 `if (!data.activities && !data.summaries) return` 的**格式校验之后**、写入之前。若后续 `saveActivity` 抛错，结果是：**旧数据已删光，新数据没写进去**
4. 数据目录里没有任何 `.bak`、`.pre-import` 或时间戳快照
5. 没有二次确认弹窗（`SettingsView.vue:277` 直接 emit，无 `confirm`）

**这直接违反总控规范**：

- 第 3 条 P0 第 1 项「数据安全与可靠性」
- 第 4 条「原始记录只读」「历史数据不批量取整、不随意迁移」
- 第 9 条「所有删除必须有依据，删除前检查历史数据依赖」

**这不是「保护机制不足」，而是「根本没有保护机制」。**

**修复建议**（三层，缺一不可）：

**第一层：导入前强制快照**

```js
// 新增 storageManager.snapshotBeforeImport(reason)
// 把整个 activities/ 复制到 Data/snapshots/YYYYMMDD-HHmmss-before-import/
// 返回快照路径，写入 import 结果供 UI 展示
```

**第二层：改成「先写入临时区 → 校验 → 替换」，而不是「先删 → 再写」**

```
1. 建 Data/import-staging/<uuid>/
2. 把导入内容完整写入 staging，校验条数与格式
3. 校验通过 → 把 activities/ 改名为 activities.old-<ts>/
4. 把 staging 改名为 activities/
5. 成功后才删 activities.old-<ts>/（或保留 N 天）
任一步失败 → 回滚：删 staging，把 activities.old-<ts>/ 改回 activities/
```

**第三层：UI 与语义修正**

- 「覆盖」按钮加二次确认，明确列出「将删除 N 个日期文件、M 条原始记录」
- 确认框里给出快照保存位置
- 修正 `SettingsView.vue:279` 的误导文案
- **考虑直接取消覆盖导入**（见决策项 D-01）

**验收标准**：

1. 执行覆盖导入后，`Data/snapshots/` 下存在完整快照，条数与导入前一致
2. 模拟写入失败（staging 写入时抛错）→ `activities/` 内容与导入前**完全一致**（用 SHA 比对文件）
3. 覆盖导入前必须有二次确认，且确认文案包含待删文件数
4. 新增测试 `tests/importOverwrite.test.cjs` 覆盖：正常覆盖、写入失败回滚、快照完整性

**是否涉及历史数据**：是。修复后不会改变既有数据，但**修复本身必须用户手动确认才执行**（不能自动跑迁移）。

---

### 问题 P0-02：历史数据迁移不幂等

**严重程度**：P0
**涉及文件与位置**：`electron/storageManager.js:220-271`（`_migrateIfNeeded`）

> **【v2 修订】本问题最初只分析了 `activities.json`，遗漏了 `summaries.json`。**
>
> 实测确认 `storageManager.js` 里有两段结构完全相同的迁移：
>
> | 段 | 行号 | 源 → 目标 | 重复风险 |
> |---|---|---|---|
> | 活动 | 222-245 | `Data/activities.json` → `Data/activities/<date>.json` | 有（235 行 `existing.concat`） |
> | **摘要** | **248-270** | `Data/summaries.json` → `Data/summaries/<date>.json` | **有（261 行 `existing.concat`）** |
>
> 两段必须**各自独立**保护：独立 manifest、源快照、staging、完成状态、故障注入测试。只修活动不修摘要 = 修了一半。

**代码实证**（关键三行）：

```js
for (const [dateStr, items] of Object.entries(grouped)) {
  const filePath = this._activityFile(dateStr);
  const existing = this._readJsonFile(filePath);
  this._writeJsonFile(filePath, existing.concat(items));   // 235 行：逐日追加
}
// ...
fs.renameSync(this._legacyActivitiesFile,                 // 240 行：全部写完后才改名
  this._legacyActivitiesFile + '.migrated');
```

**失败窗口分析**：

| 中断时机 | 结果 |
|---|---|
| 第 1 天写完后崩溃 | 第 1 天已写入，legacy 未改名 → 重启后**第 1 天变 2 倍** |
| 第 2 天写完后崩溃 | 前 2 天各 2 倍 |
| `renameSync` 前崩溃 | 全部天数 2 倍 |
| `renameSync` 本身失败（被锁） | 全部天数每次启动都翻倍 |

**实测复现**：

```
=== 第一次启动 ===
  11-05/06/07 记录数: 1 1 1
  legacy 还在: false | .migrated: true

=== 模拟：已写入新文件但 legacy 未改名（重启后重跑迁移）===
已迁移 3 条活动记录到按天存储
  11-05/06/07 记录数: 2 2 2
  >>> 重复累计确认 <<<
```

**为什么不能简单去重**：

迁移的源是旧版 `activities.json`，里面可能本身就含有合法的重复记录（同一秒内多次采样、旧版记录粒度粗）。用 `t+app+dur` 去重会误删这些合法数据 —— 见问题 P0-04。

**修复建议：用「迁移凭证」而非「去重」保证幂等**

```js
// Data/.migration-state.json
{
  "activities.json": {
    "status": "completed",              // pending | completed
    "sourceSha256": "a3f9...",          // 源文件哈希，内容没变才跳过
    "migratedAt": "2026-11-12T00:10:00Z",
    "recordCount": 1284,
    "datesWritten": ["2026-11-05", "..."]
  }
}
```

流程：

1. **迁移前**：把 `activities.json` 复制为 `activities.json.pre-migrate.bak`（复制而非改名，保证中断时源仍在）
2. **迁移中**：先写 `.migration-state.json`，`status: "pending"`，记录 `sourceSha256`
3. **逐日写入**：使用 `writeFileAtomic`（已有），保持现状
4. **全部成功后**：改 `.migration-state.json` 为 `status: "completed"`，再 `renameSync` 源文件为 `.migrated`
5. **启动时**：若 state 为 `pending` 且源文件仍在 → **不重跑迁移**，而是提示「上次迁移未完成，请从 `.pre-migrate.bak` 恢复或重试」，并把选择权交给用户

关键点：**关键在于「状态先落盘再动手」和「源文件始终保留副本」，这并不依赖去重**。

> **【v2 修订】上述「状态文件」方案不足，需升级为 SHA256 比对判定。**
>
> 原方案「先 rename staging，再写 status」存在崩溃窗口：**rename 成功后、status 写入前崩溃**，重启时 status 仍显示未完成，但 staging 文件已不存在，导致无法判断该文件究竟是否已就位。
>
> **v2 方案**：manifest 为每个目标文件记录两个哈希——
> - `expectedSha256`：该文件应有的内容哈希
> - `preReplaceSha256`：替换前原文件的哈希（原本不存在则为 null）
>
> 恢复时**直接比对正式文件的 SHA256**：
> - 等于 `expectedSha256` → 已就位，标记完成，**不重算不重写**
> - 等于 `preReplaceSha256` → 尚未替换，用 staging 继续
> - 两者都不等 → **状态无法确认，停止迁移**，提示用户手工核对，**绝不重新追加**
>
> 这样即使 status 文件陈旧，也能靠文件本身的哈希判定状态。对应测试编号 **F4a**。

> **【v2 修订】F7（源文件迁移中变化）不能直接新建 workspace。**
>
> 原方案「源变了就建新 workspace 继续合并」会与旧的未完成迁移叠加，**造成重复累计**。
>
> 正确做法：先判定旧 workspace 状态 → 若有未完成 target，**停止并提示**「上次迁移未完成且源文件已变化，请先完成或回滚」→ 只有旧 workspace 已 `done` 时才允许新建。旧 workspace 一律保留供审计。

> **【v2 修订】回滚流程修正。**
>
> 原方案「删掉 `activities/` 下所有文件」是**错的**，会误删迁移期间新录制/补录的数据。
>
> 正确做法：按 manifest 的 `preReplaceBackup` **逐文件恢复**（原文件曾存在则恢复备份，原本不存在才删除）；**只处理 manifest 列出的日期**；迁移期间新增的日期**完全不动**。

**验收标准**：

1. 正常迁移后，`.migration-state.json` 为 `completed`，`.pre-migrate.bak` 存在
2. 模拟第 2 天写入失败 → 重启后**不自动重跑**，UI 提示上次未完成，数据无重复
3. 手工把 state 改回 `pending` 并保留源文件 → 重启不产生重复
4. **活动记录数与摘要记录数分别守恒**（源条数 = 各天之和）×2
5. **F4a**：rename 成功后、status 更新前强制终止 → 重启靠 `expectedSha256` 判定已就位，不重复写入
6. **F7**：源文件迁移中被修改 → 停止迁移，不新建 workspace
7. **回滚**：各日期记录数与迁移前逐条一致，迁移期间新增数据不受影响
8. 新增测试 `tests/migrationIdempotency.test.cjs`（活动 F1-F9）、`tests/migrationSummaries.test.cjs`（摘要 S1-S9）、`tests/migrationRecovery.test.cjs`（SHA256 判定、跨卷、回滚）

**是否涉及历史数据**：是。修复后，已迁移的数据不受影响；未迁移的数据需要用户确认后重跑。

---

### 问题 P0-03：记录缺少稳定唯一标识，无法可靠去重

**严重程度**：P0（设计层缺陷，阻塞 P0-02 与 P1-01 的修复）
**涉及文件与位置**：

- `storageManager.js:120` — `id: \`${rec.t}#${index}\``
- `storageManager.js:299-344` — 落盘字段全集不含稳定 id
- `main.js:1510-1524` — 导入无去重键
- `storageManager.js:167-182` — 跨文件读取合并

**核心问题**：`id` 由 `timestamp + 读取时数组下标` 拼成。**下标每次读文件都会变**——删掉一行，后面所有 id 全部漂移。所以现有 `id` 完全不能作为持久标识。

**落盘字段全集**（`storageManager.js:316-336`）：`t`、`dur`、`kind`、`app`、`title`、`platform`、`source`、`src`、`cat`、`project`、`origin`、`planKey`、`groupId`。**没有一个是唯一标识**。`groupId` 最接近，但只有 `add-manual-record` 和 `replace-display-ranges` 会写（`main.js:1180`、`1197`），自动录制的片段没有。

**实测证明 `t+app+dur` 不可用**：

```
落盘 4 条，读回 4 条
  kind=active source=auto   title="A"  dur=900000
  kind=idle   source=auto   title=""   dur=900000
  kind=active source=manual title="B"  dur=900000
  kind=active source=auto   title="A"  dur=900000   ← 与第 1 条完全相同

>>> 若用 t+app+dur 做键，这 4 条会被合并成 1 条，误删 3 条合法记录 <<<
```

第 1 条与第 4 条**完全相同但仍然合法**（可能是一次 checkpoint 后重开了同应用的段，两次采样恰好落在同一毫秒）。这证明：**任何基于内容的去重键都会误删。**

**修复建议：引入 `rid`（record id），只对新记录生效，旧记录用「只读推导」兼容**

**阶段一（新增字段，不动旧数据）**

录制器落盘时生成 `rid`：

```js
// activityRecorder._emit()
record.rid = crypto.randomUUID();
```

`appendActivityRecords` 落盘时保留：

```js
...(r.rid ? { rid: r.rid } : {}),
```

**阶段二（旧记录的兼容定位，**不是**稳定身份）**

> **【v2 修订】原文称其为「稳定指纹」，措辞过强，用户已指出。**
>
> 行号在文件被任何一次重写后都会变（`replaceDisplayRanges` 就是整文件重写）。正确定位是：**仅用于同一次读取过程中的兼容定位，不宣称是持久身份，不可用于跨读取的去重判断。**
>
> **去重的唯一可靠依据是 `rid`**。无 `rid` 的记录一律**不去重、宁可保留**。

```js
// 兼容定位 = 文件名 + 行号，仅限单次读取内使用
// "2026-11-08.jsonl:42"
// 不用于：跨读取比较、跨文件去重、持久化存储
```

配合「写入即保留 `rid`」，记录被任何一次重写后会自动带上 `rid`，此后以 `rid` 为准。

**阶段二补充（v2）：RID 补齐的严格限制（Q3 用户决定）**

| 规则 | 说明 |
|---|---|
| 新记录 | 正常生成 UUID |
| 旧记录 | **不批量补** rid |
| 用户编辑旧展示记录 | **只给实际编辑的那一条**补 rid |
| 同文件其他历史记录 | **不得**因本次编辑而补 rid |
| 历史记录的时间/时长/分类 | **不得**因 rid 引入而改变 |

测试断言：编辑 1 条后，同文件其余记录**完整 JSON 序列化结果逐字节不变**。

**阶段三（去重仅用于「同一来源的同一份数据」）**

> **【决策后更正】下表中「JSON 重复导入」一行已作废。** `importBatchId` 每次导入都生成新 ID，无法阻止重复导入同一文件。改为「导入来源指纹」：`sha256(归一化内容)` 作为整文件指纹，命中则提示用户「该文件已于 X 时间导入过」，默认不导入但允许强制。指纹是**整文件粒度**，不逐条去重，因此同一文件内部的合法重复会被完整保留。详见实施计划 4.4。

| 场景 | 去重依据 | 安全性 |
|---|---|---|
| iCloud 冲突副本 | 同一天主文件 vs 副本，**比较 `rid`**；无 `rid` 一律**保留不去重** | 安全 |
| JSON 重复导入 | ~~每次导入生成 `importBatchId`~~ → **导入来源指纹（整文件 sha256）** | 安全 |
| 迁移幂等 | **不用去重**，用 P0-02 的迁移凭证 | — |

关键设计：**去重只在「已知是同一份数据」的范围内进行**（同批次、同主文件的副本），绝不跨批次、跨来源做内容去重。

**验收标准**：

1. 新录制的自动片段带 `rid`，且重启后 `rid` 不变
2. `t+app+dur` 完全相同的 4 条记录读回仍是 4 条（回归测试，防止有人改回去重）
3. 主文件 + 副本含同一 `rid` 的记录 → 读回 1 条；含不同 `rid` → 读回 2 条
4. 旧记录（无 `rid`）读取不报错，指纹稳定
5. 新增测试 `tests/recordIdentity.test.cjs`

**是否涉及历史数据**：**否**。`rid` 只加在新记录上，旧数据不改、不迁移。

---

### 问题 P1-01：重复累计的三条路径（修订第一轮 D3/D4）

**严重程度**：P1（P0-03 修复后降为 P1，因为有了正确工具）
**涉及文件与位置**：

1. `main.js:1510-1524` — JSON 导入无去重
2. `storageManager.js:167-182` — 冲突副本不去重
3. `storageManager.js:220-271` — 迁移不去重（已单列为 P0-02）

**第一轮报告的问题**：把「去重」当成一个简单开关，建议用 `t+app+title+dur` 做键。**这个建议是错的**，已被 P0-03 的实测推翻。修正为：先去重键必须基于 `rid`/批次，其次才能谈去重。

**验收标准**：见 P0-03 验收标准第 2、3 条。

**是否涉及历史数据**：否。

---

### 问题 P1-02：Electron 安全结论修正（第一轮 S1 表述有误）

**严重程度**：P1
**第一轮错误**：我把 `enableRemoteModule: true` 列为风险点，暗示它扩大了能力面。**这是错误的。**

**核实结果**：

| 项 | 事实 |
|---|---|
| Electron 版本 | **28.3.3** |
| `enableRemoteModule` 状态 | Electron 14 起移除 `remote` 模块，该选项自那以后**无效** |
| 实际出现次数 | 全仓库 **1 次**，只在主窗口（`main.js:302`） |
| 安全影响 | **零**。它是无效选项，不产生任何行为 |
| 处理建议 | 删除这一行（清理噪音），但**不属于安全修复**，可与其他改动合并 |

**三个窗口的准确配置**：

| 窗口 | 行号 | nodeIntegration | contextIsolation | enableRemoteModule |
|---|---|---|---|---|
| `focusWindow` | 169 | `true` | `false` | 无 |
| `mainWindow` | 300-302 | `true` | `false` | `true`（**无效**） |
| `floatWindow` | 460-461 | `true` | `false` | 无 |

**真实风险点只有两个**：`nodeIntegration: true` + `contextIsolation: false`，以及无 preload。

**前端对 Node/Electron 的真实依赖面**（实测）：

| 文件 | ipc | shell | clipboard | Node 内置模块 |
|---|---|---|---|---|
| `src/App.vue` | 61 | 1 | 1 | 0 |
| `src/views/TimelineView.vue` | 16 | 0 | 0 | 0 |
| `src/components/CompareCard.vue` | 3 | 0 | 0 | 0 |
| `src/components/WeeklyReview.vue` | 3 | 0 | 1 | 0 |
| `src/components/ProductivityOverview.vue` | 2 | 0 | 0 | 0 |
| `src/views/SettingsView.vue` | 2 | 0 | 0 | 0 |
| **合计** | **80** | **1** | **2** | **0** |

**80 个调用中：`invoke` 79 个，`on` 1 个，`send` 0 个。**

这个分布对迁移极其有利：**没有任何渲染进程依赖 `fs`/`path`/`child_process`**，全部通信都走 IPC。因此 preload 只需暴露：

```js
contextBridge.exposeInMainWorld('worklog', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.has(channel)) throw new Error('blocked: ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!ALLOWED_EVENTS.has(channel)) return () => {};
    const h = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  openExternal: url => { /* 校验 https: 后转 IPC */ },
  copyText: text => { /* 转 IPC 调 clipboard */ }
});
```

前端改动量：**6 个文件各改 1 行 require + 全局替换 `ipcRenderer.invoke` → `worklog.invoke`**，另加 1 处 `on`、1 处 `shell`、2 处 `clipboard`。

**渐进迁移方案（六步，每步可独立验证、可独立回滚）**：

| 步骤 | 内容 | 回滚方式 | 验证 |
|---|---|---|---|
| S1 | 新增 `electron/preload.js`，暴露 `worklog` **但不启用**（仍保持 nodeIntegration） | 删文件 | 应用行为无变化 |
| S2 | 前端 6 个文件改用 `window.worklog` 调用，**同时保留 require 作为降级** | 改回 require | 80 个调用全部走 preload，功能不变 |
| S3 | `focusWindow` + `floatWindow` 关闭 nodeIntegration、开启 contextIsolation | 改回配置 | 计时窗/悬浮条功能完整（这两个窗口调用面最小） |
| S4 | `mainWindow` 关闭 nodeIntegration、开启 contextIsolation | 改回配置 | 全功能回归 |
| S5 | 移除前端所有 `require('electron')` | 恢复 | 构建通过、无引用残留 |
| S6 | 73 个 IPC handler 加 `senderFrame` 校验（按通道分级） | 逐通道回退 | 危险通道拒绝非主窗口调用 |

**每步的验收标准**：`npm test` 全绿 + 手工验收清单（窗口显示、录制、补录、时间线拖拽、设置保存、导出、导入、专注窗、悬浮条）。**任一步出现功能失效，立即回退该步，不进入下一步。**

**是否涉及历史数据**：否。

---

### 问题 P2-01：`atomicFile` 降级路径可能掩盖真实错误

**严重程度**：P2（第一轮未发现）
**涉及文件与位置**：`electron/atomicFile.js:42-51`

```js
try {
  fs.writeFileSync(file, content, 'utf8');   // 非原子覆盖写
  ...
} catch (directError) {
  throw lastError || directError;            // 抛出的是 rename 的错误，不是 directError
}
```

直接覆盖写失败时，抛出的是 `lastError`（rename 的错误），而真正原因在 `directError` 里。调试时会看到误导性的错误码。

**影响**：仅影响错误诊断，不影响数据正确性。
**修复建议**：改为 `throw directError`，把 rename 的 `lastError` 放进 `directError.cause`。
**是否涉及历史数据**：否。

---

## 二、测试质量重新审查

外部审查的四条质疑**全部成立**。逐条核实如下。

### 2.1 `manualSnap.test.cjs`：复刻算法，未调用生产代码 —— 成立

**证据**：

```
== require 列表 ==
1-6: node 内置 + ../electron/timeSplit
96:  require('../electron/storageManager')      ← 只用于第 5 条（写入读回）

== 自建算法 ==
30: function snapCurrent(dateStr, startTime, rawDurationMin) {
32:   const durationMin = Math.max(15, Math.round(rawDurationMin / 15) * 15);
33:   const snappedMinute = Math.floor(parseInt(m[2], 10) / 15) * 15;
```

**问题**：`manualRecordFromPayload` 定义在 `main.js:1133` 内部、未导出，`main.js` 依赖 Electron 运行时（`app.whenReady` 等），`node --test` 无法 require。所以测试只能复刻。

**后果**：生产代码改了取整逻辑，**测试不会失败**，因为它测的是测试文件里的那份拷贝。这是**假绿**。

**修正方案**：
1. **短期（本轮不改代码）**：在测试文件头部如实标注「这是行为快照，非契约测试」，避免误信
2. **V0.10.4 修复**：`manualRecordFromPayload` 迁出到 `electron/slotRule.js` 并导出，测试改为直接调用生产函数
3. **在此之前**，所有涉及 15 分钟规则的结论都标注置信度：**基于源码阅读 + 独立复刻验证，非生产函数直接验证**

### 2.2 `recordImmutability.test.cjs`：require.cache 未清理 —— 成立，且已实际污染

**证据**：4 处 `withStorage()` 调用（35/50/61/101 行），`withStorage` 内部**没有** `delete require.cache`。

**实测污染**：

```
第1个实例 dataDir: C:\Users\...\Temp\cache-a-KG9tIU\Data
第2个实例 dataDir: C:\Users\...\Temp\cache-a-KG9tIU\Data   ← 同一个！
a.root: C:\Users\...\Temp\cache-a-KG9tIU
b.root: C:\Users\...\Temp\cache-b-wUA3Mz
>>> 第2个复用了第1个的类（闭包里的 root），测试互相污染 <<<
```

**后果**：
- 4 个测试共用第 1 个临时目录
- 第 1 个测试的 `t.after` 把该目录删掉后，后续测试在**已删除的目录**上操作
- 测试**当前能过**，是因为 `StorageManager` 会重新 `ensureDataDir()` 创建目录 —— 恰好掩盖了问题
- 如果某个测试依赖「目录为空」的前置条件，会**静默通过或静默失败**

**修正方案**（下一轮改测试，本轮只在报告记录）：
```js
const key = require.resolve('../electron/storageManager');
delete require.cache[key];
```
`duplicateImport.test.cjs` 里我**已经**这么写了（第 30-31 行），但 `recordImmutability.test.cjs` 漏了。这是我的疏漏。

### 2.3 `duplicateImport.test.cjs`：只锁定当前错误，未验证正确行为 —— 成立

**证据**：

```
52: assert.equal(second, 4, 'KNOWN ISSUE: 无去重键，重复导入会翻倍累计');
65: assert.equal(items.length, 2, 'KNOWN ISSUE: 同一条记录存在于主文件与副本时会被读成两条');
```

**问题**：这两条是**「错误行为快照」**，断言的是「现在是错的」。它们有价值（防止有人无意改变行为却以为修好了），但**不能让任何人误以为问题已解决**。

**修正方案**：
1. 文件头部已写明「锁定当前已知风险」，保留
2. **V0.10.x 修复后，这两条必须改成断言正确行为**（`second === 2`、`items.length === 1`），并且**新建一条测试验证 `rid` 不同时仍读回 2 条**
3. 在报告里明确标注：**这 2 条测试当前状态是「已知缺陷回归测试」，不是「业务正确性测试」**

### 2.4 缺失的测试 —— 全部确认缺失

| 场景 | 是否已有测试 | 说明 |
|---|---|---|
| 覆盖导入（`clearActivities`） | **无** | 全仓库 `tests/` 检索 `clearActivities` 命中 0 |
| 导入失败回滚 | **无** | `importData` 无测试 |
| 迁移中断 | **无** | `_migrateIfNeeded` 无测试 |
| 迁移幂等 | **无** | 本报告 P0-02 才有手动复现 |
| 数据恢复 | **无** | 无任何恢复流程 |
| 云盘冲突副本去重 | **部分** | `icloudConflict.test.cjs` 只测「能读到」，不测「去重」 |
| 记录唯一标识 | **无** | `rid` 尚未存在 |

### 2.5 测试分类（诚实标注）

| 分类 | 数量 | 文件 |
|---|---|---|
| **真正验证业务正确性** | 约 95 | 原有测试（`storageReplace`、`slotOccupancy`、`timeSplit`、`atomicFile`、`focusEditing` 等） |
| **仅验证当前行为（行为快照）** | 5 | `manualSnap.test.cjs` 全部 5 条（复刻算法） |
| **已知问题的回归测试** | 2 | `duplicateImport` 第 1、2 条 |
| **锁定设计约束（有效）** | 5 | `recordImmutability.test.cjs`（虽然 cache 有缺陷，断言方向是对的） |
| **缺失** | 7 类 | 见 2.4 |

**结论**：109 条测试中，**真正有契约价值的大约 100 条**，其余 9 条需要按上述修正。测试数量看起来不错，但**覆盖的结构性风险（导入、迁移、恢复）几乎为零** —— 这正好是最容易丢数据的地方。

---

## 三、第一轮报告需要修正的内容

### 修正 1：安全结论（第三节 S1）

**原文**：
> `webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: true }`
> **影响**：渲染进程拥有完整 Node 权限。任何能注入到渲染层的 XSS 都会升级为任意代码执行。

**问题**：把 `enableRemoteModule` 与风险并列，读者会以为它开启了额外能力。

**修正**：
- `enableRemoteModule` 在 Electron 14+ **已移除**，在 28.3.3 中为**无效选项**，安全影响为零
- 真实风险只有 `nodeIntegration: true` + `contextIsolation: false`
- 删除该行属于**代码清理**，不属于安全修复

### 修正 2：去重建议（第四节 D3）

**原文**：
> **建议**：导入前建立去重键 `timestamp + processName + windowTitle + durationMs`，跳过已存在记录

**问题**：**这个建议是错的。** 实测证明 4 条合法记录在该键下会合并成 1 条。

**修正**：
- 任何基于内容的键都会误删合法重复
- 正确做法是先引入 `rid`（P0-03），去重只用于「同一来源的同一份数据」
- 迁移幂等**不靠去重**，靠迁移凭证（P0-02）

### 修正 3：迁移风险等级（第四节 D7）

**原文**：
> **建议**：迁移前把原文件复制为 `*.pre-migrate.bak`，迁移成功后再删除（或保留一个版本）。

**问题**：只说了备份，**没说清「不幂等」这个更严重的问题**，且把它归在 P1「数据安全」里，实际应该是 P0。

**修正**：
- 升级为 **P0-02**
- 核心问题不是「没备份」，而是「中途失败后重启会重复累计」，已实测 `1 1 1 → 2 2 2`
- 修复靠迁移状态凭证，不是靠备份

### 修正 4（补充）：第一轮漏掉的最大问题

第一轮第四节列了 D1-D8 八个数据风险，**但完全没有提到覆盖导入会删掉全部原始记录**。这是本次审查发现的**最严重问题**。

**为什么漏了**：第一轮我重点看的是 `storageManager` 的写路径，而 `clearActivities()` 是「整目录删除」，不在我逐行审查的五个方法里。**这是审查方法的漏洞：只看了逐行重写，没看批量删除。**

### 修正 5（补充）：测试质量结论过于乐观

**原文**：
> 测试基线：**108/108 通过**（原有 95 + 新增 13）

**问题**：只报了数量，没有区分「契约测试」与「行为快照」。其中 `manualSnap` 5 条是假绿。

**修正**：见第二节 2.5 分类表，并在后续报告中一律按要求区分四类。

---

## 四、更正后的问题严重度总表

| 编号 | 问题 | 原严重度 | 新严重度 | 理由 |
|---|---|---|---|---|
| P0-01 | 覆盖导入删除原始记录 | 未发现 | **P0** | 不可恢复的数据丢失 |
| P0-02 | 迁移不幂等 | P1（D7） | **P0** | 已实测重复累计 |
| P0-03 | 无稳定记录标识 | 未发现 | **P0** | 阻塞所有去重与迁移修复 |
| P1-01 | 三条重复累计路径 | P1（D3/D4） | P1 | 依赖 P0-03 |
| P1-02 | Electron 安全基线 | P1（S1/S2/S3） | P1 | 依赖关系已澄清 |
| P1-03 | 15 分钟规则 7 处不一致 | P0 | **P1** | 影响体验但不丢数据，降级 |
| P1-04 | `slice(-200)` 静默丢弃 | P0 | P1 | 影响小概率场景，降级 |
| P1-05 | 存储目录无预检（卡死） | P0 | P1 | 有明确诱因（用户主动切云盘），降级 |
| P2-01 | atomicFile 错误遮蔽 | 未发现 | P2 | 仅影响诊断 |
| P2-02 | 密钥明文 | P1 | P2 | 需同用户权限才能读，降级 |

**说明**：我给第一轮的 4 个 P0 重新分级了。理由是：只有「不可恢复的数据丢失」和「数据重复累计」够 P0，其余是体验或概率问题。**P0 太多等于没有 P0**，会让优先级失去意义。

---

## 五、开发路线图（重新排布）

原则：**数据安全优先于功能，功能优先于架构**。每版独立提交、独立测试、可独立回滚。

### V0.10.2 — 覆盖导入与迁移不丢数据（P0）

**目标**：堵住两个不可恢复的数据丢失口子。

| 任务 | 文件 |
|---|---|
| 新增 `snapshotBeforeImport()` | `storageManager.js` |
| 覆盖导入改「staging → 校验 → 替换」，失败回滚 | `main.js:1504-1520` |
| 覆盖导入加二次确认 + 修正误导文案 | `SettingsView.vue:277-279` |
| 迁移加 `.migration-state.json` + `.pre-migrate.bak` | `storageManager.js:220-271` |
| 新增测试：`importOverwrite.test.cjs`、`migrationIdempotency.test.cjs` | `tests/` |

**验收**：模拟写入失败后 `activities/` 内容 SHA 与导入前一致；迁移中断后重启不重复。
**可否回滚**：可以，改动集中在两个方法 + 一个 UI 对话框。

### V0.10.3 — 记录唯一标识与去重治理（P0）

**目标**：让「去重」这件事有正确工具，而不是靠猜内容。

| 任务 | 文件 |
|---|---|
| `rid` 生成与落盘 | `activityRecorder.js`、`storageManager.js:316` |
| 旧记录兼容定位（**仅单次读取内有效，非持久身份**） | `storageManager.js:_fromSegment` |
| 冲突副本按 `rid` 去重；无 `rid` 一律保留 | `storageManager.js:167` |
| **副本文件名严格正则**（防止误读 `-backup`/`.old`） | `storageManager.js:174-178` |
| 导入改用**来源指纹**幂等（~~importBatchId~~ 已作废） | `main.js:1510` + 新增 `importFingerprint.js` |
| 新增测试：`recordIdentity.test.cjs` | `tests/` |
| 修正 `duplicateImport` 第 1、2 条断言为正确行为 | `tests/duplicateImport.test.cjs` |

**验收**：`t+app+dur` 相同的 4 条记录仍读回 4 条；同 `rid` 主文件+副本读回 1 条。
**可否回滚**：可以。`rid` 是新增字段，旧数据不读它。

### V0.10.4 — 15 分钟规则统一（P1）

**目标**：把 7 处实现收敛成 1 处，并让规则可测试。

| 任务 | 文件 |
|---|---|
| 新增 `electron/slotRule.js` | 新建 |
| `manualRecordFromPayload` 迁出 `main.js` 并导出 | `main.js:1132-1173` → `slotRule.js` |
| 7 处调用点改为引用 `slotRule` | `main.js`、`storageManager.js:610`、`planManager.js:165/183/265`、`analytics.js:1212`、`App.vue:541`、`TimelineView.vue:1116` |
| 前后端吸附策略统一（**待决策 D-02**） | — |
| `manualSnap.test.cjs` 改为直接调用生产函数 | `tests/` |

**验收**：7 处调用的取整结果完全一致；`manualSnap` 不再复刻算法。
**可否回滚**：可以，但**会改变新写入记录的时间**，需提前告知用户。

### V0.10.5 — 存储目录可靠性与主线程卡死（P1）

**目标**：根治 iCloud/OneDrive 目录导致的 AppHang。

| 任务 | 文件 |
|---|---|
| 切目录前预检（抽样读 + 超时 + `0x400000` 属性检测） | `main.js` save-config / migrate-storage |
| 数据读取迁 `worker_threads`，超时 `terminate()` | `storageManager.js`、`analytics.js` |
| `slice(-200)` 改溢出文件 + UI 提示 | `activityRecorder.js:290` |

**验收**：切到含「仅在线」文件的目录被拒绝并提示；人为制造阻塞文件，主进程不冻结。
**可否回滚**：**风险较高**，涉及全部读路径。建议先只对 `analytics` 做 worker，`storageManager` 保持同步，分两次提交。

### V0.10.6 — Electron 安全改造（P1，六步渐进）

见 P1-02 的 S1-S6。每步独立提交、独立验收。
**可否回滚**：每步都可独立回退。

### V0.10.7 — 代码清理与诊断改进（P2）

`enableRemoteModule` 删除、`atomicFile` 错误链、密钥 `safeStorage` 加密、CORS 收紧、`openExternal` 协议校验、超大文件拆分。

### V0.11.0 — 正式打包发布

在主进程改动稳定后做窄窗/半屏/全屏验收，打安装版与便携版。

**与原路线图的差异**：

| 原规划 | 新规划 | 理由 |
|---|---|---|
| 0.10.2 = 15 分钟规则 | 0.10.2 = 导入/迁移数据保护 | 丢数据比体验差严重得多 |
| 0.10.3 = 数据写入可靠性 | 0.10.3 = 记录标识与去重 | 去重必须先有稳定 id |
| 0.10.4 = 预检+异步 | 0.10.5（后移一位） | 让位给 P0 数据保护 |
| 0.10.5 = 安全 preload | 0.10.6（后移） | 同上 |

---

## 六、需要你确认的决策事项

### D-01：覆盖导入是否直接取消？

现状是「先删光所有原始记录，再写入新数据」，且无备份。

- **选项 A（推荐）**：**取消覆盖导入**，只保留「合并」与「切换数据目录」。理由：覆盖导入的正当需求是「换一台机器恢复」，而这个需求用「切换数据目录」就能满足，不需要删数据。
- **选项 B**：保留但强制快照 + 二次确认 + 失败回滚。

我倾向 A：少一个能删数据的入口，就少一类事故。

### D-02：15 分钟吸附方向（V0.10.4 需要）

- **起始**：向下（09:14→09:00，不侵占前块）还是就近（09:14→09:15，与前端预览一致）？我倾向**就近**。
- **时长**：保持就近（22→15，低估 7 分）还是向上（22→30，高估 8 分）？两种都会失真，我倾向**就近**并**在 UI 上显示真实吸附结果**，让用户看到「22 分钟 → 将记录 15 分钟」后再确认。

### D-03：`rid` 是否接受「只对新记录生效」？

旧数据不写 `rid`，用「文件名+行号」推导指纹。这样**不需要迁移历史数据**，但旧记录在文件被重写后指纹会变（一次性的，之后带上 `rid` 就稳定了）。

- **选项 A（推荐）**：接受。零迁移风险。
- **选项 B**：给所有历史记录补 `rid`。需要一次性全量重写，风险大，违反「不随意迁移历史数据」。

### D-04：V0.10.2 是否允许我动 `main.js` 的导入逻辑？

按规范「不允许一次修改大量无关文件」，V0.10.2 会触碰 `main.js`（导入）、`storageManager.js`（快照+迁移）、`SettingsView.vue`（对话框）、`App.vue`（确认流程）四个文件。这算「一个主要问题」范围内的合理改动，但涉及文件数偏多。

- **选项 A**：按上述范围执行，一次提交。
- **选项 B**：拆成 0.10.2a（仅迁移幂等）和 0.10.2b（仅覆盖导入），两次提交。

我倾向 **B**：迁移和导入是两件事，拆开更符合「一个版本只解决一个主要问题」。

---

## 七、本轮执行边界确认

| 要求 | 执行情况 |
|---|---|
| 只做审计和文档修订 | ✅ 只新增本文档 + 修订第一轮报告 |
| 不修改任何生产代码 | ✅ `git diff` 仅文档 |
| 不改变现有数据格式 | ✅ 未动 |
| 不删除任何功能 | ✅ 未动 |
| 不执行历史数据清洗 | ✅ 仅临时目录复现，真实数据未读写 |
| 不开始 V0.10.2 | ✅ 未开始 |
| 不为让测试通过而改测试预期掩盖问题 | ✅ 反而指出自己的 5 条测试是假绿 |

**本轮所有实测均在 `os.tmpdir()` 临时目录中进行，未读写任何用户真实数据。**

---

## 八、对第一轮审计的自我评价

第一轮做对的部分：记录层只读机制核实准确（`layerOf` 五处全覆盖）、跨午夜逻辑验证扎实、API Server 安全设计认定正确。

第一轮的三类失误：

1. **审查方法漏洞**：只逐行审了「单条记录重写」，没审「整目录批量删除」。于是漏掉了 `clearActivities()` 这个最严重的问题。
2. **建议给得太快**：去重键 `t+app+title+dur` 是拍脑袋给的，没做「合法重复」场景验证。实测一跑就崩。
3. **测试质量把关不严**：`manualSnap` 复刻算法我自己在报告里写了理由（"无法 require"），但**没有把它标成风险**，反而当成有效测试计入 108 条。`recordImmutability` 的 cache 问题在 `duplicateImport` 里我修了，却漏了前一个文件。

三点的共同根因：**把「代码读起来正确」当成「行为已验证」**。第二轮改为「先跑出证据再下结论」——本报告所有 P0 结论都有实测输出支撑。

---

**本轮到此停止，等待你确认 D-01 至 D-04 后再进入 V0.10.2 开发。**
