# WorkLog 1.0 实施计划（V0.10.2a → V0.10.4）

> 依据：`docs/WORKLOG_1.0_AUDIT_ROUND2.md`（已通过审查）+ 2026-11-12 四项产品决策 + 同日晚间七项修订意见
> 分支：`worklog-1.0-dev`
> 状态：**计划文档（第 2 版，已吸收七项修订）。本轮不修改任何生产代码和测试代码。**
> 最后更新：2026-11-12 00:55

---

## 修订记录

| 版本 | 变更 |
|---|---|
| v1 | 初版，落实 D-01~D-04 |
| **v2** | 吸收七项审查意见：①摘要迁移纳入保护 ②修复迁移崩溃窗口 + F4a + 回滚修正 ③D-02 短时段改为拒绝 + 跨午夜判定 ④重叠处理细化 ⑤RID 补齐限制 ⑥导入快照扩到 summaries ⑦来源指纹覆盖全部有效数据 |

### v2 相对 v1 的实质性更正

| # | v1 的问题 | v2 更正 |
|---|---|---|
| 1 | 迁移只保护 `activities.json` | `activities.json` 与 `summaries.json` **两套独立**迁移保护 |
| 2 | 先 rename 后写 status，存在崩溃窗口 | manifest 记录**预期 SHA256**，恢复时比对比对判定 |
| 3 | `duration <= 0` 一律 +24h | **区分跨午夜与短时段**，不做统一加 24 小时 |
| 4 | 短时段自动提升到 15 分钟 | **改选 B：拒绝保存**，用**原始时长**判定（不是吸附后） |
| 5 | 声称「完全消除时长失真」 | **作废该说法**。09:00+22min 仍存为 15 分钟，必须告知用户 |
| 6 | 重叠处理含糊 | 自动记录可覆盖（写展示层）、人工记录阻断、记录层永久只读 |
| 7 | 回滚「删掉 activities/*.json」 | **错误**。必须恢复迁移前快照，不得误删迁移期间新数据 |
| 8 | 导入快照只覆盖 activities | 覆盖 `activities/`、`summaries/`、`summaries_md/` |
| 9 | 指纹只算部分字段 | 覆盖**活动+摘要全部有效数据**，规范化 JSON 保留顺序与合法重复 |

---

## 零、决策确认与 v2 影响

| 决策 | 结论 | v2 落实要点 |
|---|---|---|
| **D-01** | 取消危险覆盖导入；保留合并导入；普通导入不得清空原始记录；恢复备份单独立项 | 快照扩至三个目录；不做恢复功能 |
| **D-02** | 起止**分别就近**吸附；时长=吸附后结束−开始；**不再单独取整**；最短 15 分钟（**选 B 拒绝**）；重叠需提示 | 判定用原始时长；跨午夜单独处理；前端预览与后端共用同一模块 |
| **D-03** | 新记录 UUID；不批量改写历史；旧数据仅兼容定位；只有确认同一副本才去重 | Q3 选 A 但**限定**：只给实际编辑的那一条补 RID |
| **D-04** | 拆 V0.10.2a（迁移幂等）+ V0.10.2b（导入安全）；迁移必须可恢复 | 双迁移独立 manifest；SHA256 恢复判定；F4a |

### Q1/Q2/Q3 的最终答案

| 问题 | 用户决定 | 落实位置 |
|---|---|---|
| **Q1** 极短时间 | **选 B：拒绝保存**，提示用户调整。禁止把 3 分钟变成 15 分钟工时 | §2.6 |
| **Q2** 重叠语义 | 自动记录重叠：**提示但允许**（写展示层）；人工记录重叠：**阻断**；记录层永不修改 | §2.7 |
| **Q3** RID 补齐 | **选 A 但限定**：只给实际编辑的那条补，同文件其他记录不补，不改变任何历史字段 | §4.6 |

---

## 一、D-02 算法精确定义（v2 重写）

### 1.1 输入形式与结束时间推导

现有 `manualRecordFromPayload(payload)` 接收 `startTime`（`HH:mm`）与 `durationMin`（分钟整数），**没有 `endTime`**。

**推导规则**（本轮明确）：

```
startRaw = hh * 60 + mm           // 0..1439
endRaw   = startRaw + durationMin // 可以是 1440..2879

crossMidnight = endRaw >= 1440    // 唯一的跨日判据
```

**为什么不存在 `endRaw < startRaw`**：`durationMin` 恒为正数（校验 `1 <= d <= 1440`），所以 `endRaw >= startRaw` 恒成立。**v1 里「duration <= 0 则 +24h」的逻辑是错误设计**，已在 v2 删除。

### 1.2 跨午夜的唯一判据

| 情况 | 判据 | 处理 |
|---|---|---|
| 同一天内 | `endRaw < 1440` | 正常吸附两端 |
| 跨午夜 | `endRaw >= 1440` | 终点吸附时保留跨日偏移 |
| 输入为 `startTime + endTime` 形式（未来扩展） | `eMin > sMin` 为同天，否则跨日 | **但 `eMin == sMin` 有歧义**：按「跨日 24 小时」还是「0 分钟」？本轮不支持该输入形式，若将来支持必须显式要求用户勾选「跨日」 |

**本轮结论：只支持 `startTime + durationMin`，不做 `endTime` 输入**。这从根上消除了 `eMin == sMin` 的歧义。

### 1.3 两端分别就近吸附

```
STEP = 15

snapStart(startRaw) = round(startRaw / 15) * 15              // 0..1440

snapEnd(endRaw):
    if endRaw < 1440:
        return round(endRaw / 15) * 15                       // 可能 = 1440（进位到次日 00:00）
    else:
        return 1440 + round((endRaw - 1440) / 15) * 15        // 保留跨日偏移

duration = snapEnd - snapStart
```

**次日 00:00 的处理**：`snapEnd` 允许等于 `1440`，代表次日 00:00。这是**合法结果**，不是错误。写入时 `timeSplit.splitRecordAtMidnight` 会把它拆成 23:45—24:00 与 00:00—(次日) 两段。

### 1.4 实测验证表（已用脚本跑过）

| 输入 | 原始结束 | 吸附起 | 吸附止 | 吸附后时长 | 判定 |
|---|---|---|---|---|---|
| 09:00 + 15min | 09:15 | 09:00 | 09:15 | 15 分 | OK |
| 09:00 + 22min | 09:22 | 09:00 | 09:15 | **15 分** | OK（**失真仍在**） |
| 09:07 + 95min | 10:42 | 09:00 | 10:45 | **105 分** | OK（用户样例 ✓） |
| 09:07 + 35min | 09:42 | 09:00 | 09:45 | 45 分 | OK |
| 09:14 + 15min | 09:29 | 09:15 | 09:30 | 15 分 | OK |
| 23:50 + 30min | 次日 00:20 | 23:45 | 次日 00:15 | 30 分 | OK |
| 23:45 + 15min | 次日 00:00 | 23:45 | 次日 00:00 | 15 分 | OK |
| 09:07 + 3min | 09:10 | 09:00 | 09:15 | 15 分 | **拒绝**（原始 3 分 < 15） |
| 09:07 + 8min | 09:15 | 09:00 | 09:15 | 15 分 | **拒绝**（原始 8 分 < 15） |
| 09:07 + 14min | 09:21 | 09:00 | 09:15 | 15 分 | **拒绝**（原始 14 分 < 15） |
| 09:00 + 1440min | 次日 00:00 | 09:00 | 次日 00:00 | 1440 分 | OK |

### 1.5 必须作废的说法（v1 错误）

> ❌ **v1 原文**：「D-02 要求『不再单独对时长四舍五入』，这从根上消除了本文 5.2 表格里『填 22 分钟存 15 分钟』的失真」

**这句话是错的，v2 予以作废。**

D-02 只取消了「独立的时长取整」环节，但**吸附本身仍会改变时长**：

- `09:00 + 22min` → 吸附成 `09:00—09:15` → **实际保存 15 分钟**，比用户输入少 7 分钟
- `09:07 + 95min` → 吸附成 `09:00—10:45` → **实际保存 105 分钟**，比用户输入多 10 分钟

**因此 D-02 第 6 条「保存前显示吸附后的实际时间」不是可选优化，而是必需措施**：用户必须看到「09:00—09:15，共 15 分钟」再确认，才知道自己输入的 22 分钟会被记成 15 分钟。

### 1.6 最短时长判定（Q1 选 B）

**关键：用原始时长判定，不用吸附后时长。**

```
if (rawDurationMin < 15) → 拒绝，提示「人工记录最短 15 分钟，请调整时间」
if (duration <= 0)       → 拒绝（理论上不可达，作为防御断言）
```

**为什么不能判吸附后时长**：实测 `09:07 + 3min` 吸附后是 `09:00—09:15`，时长 15 分钟，`dur < 15` 判断不到。只有用原始 3 分钟才能拦住。

**这一条是 v2 相对 v1 的关键修正**。v1 写的是「提升结束到 09:15」，会把 3 分钟凭空变成 15 分钟工时，用户明确否决。

### 1.7 前端预览与后端保存的一致性保证

| 措施 | 说明 |
|---|---|
| 单一实现 | `electron/slotRule.js` 是唯一算法源；前端通过 IPC 调用或引用同一份 `.mjs` 共享模块 |
| 预览即结果 | 前端在用户调整时间时调用 `snapRange()` 显示「将保存为 09:00—10:45，共 105 分钟」 |
| 保存不重算 | 后端收到已吸附的 `startTime + durationMin` 后，**校验**吸附结果是否与前端一致；不一致则拒绝并提示刷新 |
| 测试 | 同一组输入，前端预览函数与后端保存函数输出必须逐字段相等（见 §9 测试矩阵 T-D02-08） |

---

## 二、V0.10.2a — 历史数据迁移幂等性（含摘要）

### 2.1 问题范围（v2 扩大）

`storageManager.js:220-271` 的 `_migrateIfNeeded` **有两段**，结构完全相同，风险相同：

| 段 | 行号 | 源文件 | 目标 | 重复风险 |
|---|---|---|---|---|
| 活动 | 222-245 | `Data/activities.json` | `Data/activities/<date>.json` | **有**（第 235 行 `existing.concat`） |
| 摘要 | 248-270 | `Data/summaries.json` | `Data/summaries/<date>.json` | **有**（第 261 行 `existing.concat`） |

两段**都必须**纳入迁移保护，且各自独立。

### 2.2 自定义数据目录的处理（用户第 4 点）

构造函数（`storageManager.js:36-37`）：

```js
this._legacyActivitiesFile = path.join(this._defaultDataDir, 'activities.json');
this._legacySummariesFile  = path.join(this._defaultDataDir, 'summaries.json');
```

**这两个路径固定指向「默认数据目录」，不是 `this.dataDir`。**

| 场景 | 行为 |
|---|---|
| `customPath` 为空 | `dataDir === _defaultDataDir`，源与目标同目录，正常迁移 |
| `customPath` 已设置 | 源文件在**默认目录**，目标文件在**自定义目录**。现有代码会把默认目录的旧数据迁移到自定义目录 |

**v2 明确要求**：迁移必须能处理「源与目标跨卷」的情况（见 2.4），并在 manifest 中记录**源与目标的绝对路径**，恢复时校验路径未变。

### 2.3 迁移工作区结构（每套独立）

```
Data/
├── activities.json                          ← 源文件（迁移期间始终保留）
├── summaries.json                           ← 源文件（迁移期间始终保留）
├── .migration/
│   ├── activities-<sha8>/
│   │   ├── manifest.json
│   │   ├── source.snapshot.jsonl            ← 不可变快照
│   │   ├── staging/
│   │   │   └── 2026-11-05.json
│   │   └── status.json
│   └── summaries-<sha8>/
│       ├── manifest.json
│       ├── source.snapshot.jsonl
│       ├── staging/
│       └── status.json
├── activities/                              ← 正式目标目录
└── summaries/                               ← 正式目标目录
```

**两套完全独立**：独立的 `<sha8>`、manifest、快照、staging、status。任一套失败不影响另一套。

### 2.4 暂存必须与目标同卷（用户第 5 点）

`renameSync` 要求源与目标在**同一卷**，否则抛 `EXDEV`。

**设计决策**：

| 项 | 位置 | 理由 |
|---|---|---|
| 迁移工作区 `.migration/` | 位于 **`dataDir`**（目标目录）下 | 与 `activities/`、`summaries/` 同卷，保证 rename 可行 |
| 源文件 | 可能在 `_defaultDataDir`（默认目录） | 只读，不做 rename（用复制快照） |
| 源文件改名（`.migrated`） | 在源文件所在目录内 rename | 同目录，天然同卷 |

**验证**：实现时必须在前置检查里断言 `path.parse(workspaceDir).root === path.parse(targetDir).root`，不满足则拒绝迁移并提示用户。

### 2.5 manifest 与 SHA256 恢复判定（用户第 2 点核心）

```jsonc
// manifest.json
{
  "kind": "activities",
  "sourcePath": "C:\\...\\Data\\activities.json",
  "sourceSha256": "a3f9c1...",          // 源文件整体哈希
  "sourceRecordCount": 1284,
  "targetDir": "C:\\...\\Data\\activities",
  "createdAt": "2026-11-12T01:00:00Z",
  "targets": [
    {
      "date": "2026-11-05",
      "expectedRecordCount": 42,
      "expectedSha256": "b7e2...",       // ← 目标文件应有的内容哈希
      "preReplaceSha256": "9a1c...",     // ← 替换前原文件的哈希（若原本不存在则为 null）
      "preReplaceBackup": "staging/2026-11-05.pre-replace.json"
    }
  ]
}
```

```jsonc
// status.json
{
  "phase": "staging",                   // manifest | snapshot | staging | replacing | done
  "completedTargets": ["2026-11-05"],   // 已确认就位的日期
  "lastError": null
}
```

**恢复判定（解决崩溃窗口）**：

```
启动时若发现 .migration/<kind>-<sha8>/ 存在：

1. 读 manifest + status
2. 若 status.phase === 'done'：
     → 若源文件仍在：执行最后一步 rename 为 .migrated，然后清理
     → 若源文件已改名：删除工作区（保留日志）
3. 若 phase !== 'done'（含 replacing）：
   for each target in manifest.targets:
       actualSha = sha256(targetDir/<date>.json)     // 不存在则为 null
       if actualSha === target.expectedSha256:
           → 已就位，标记完成（**不重算、不重写**）
       else if actualSha === target.preReplaceSha256:
           → 尚未替换，可用 staging 内容继续
       else if actualSha === null && target.expectedRecordCount === 0:
           → 空文件，视为完成
       else:
           → **状态无法确认 → 停止迁移**，抛错并提示：
             「无法确认 <date>.json 的状态，为避免重复追加已停止迁移。
               请从 .migration/ 快照手工核对或联系支持。」
4. 全部 target 判定完成后，按需生成缺失的 staging，再执行替换
5. 每次 rename 后立即更新 status.completedTargets
```

**关键**：`expectedSha256` 让「rename 成功但 status 未写」的崩溃窗口变得可判定——重启后比对正式文件的 SHA 就能知道它是否已就位，**不需要依赖 status**。

### 2.6 完整流程

```
阶段 0：前置检查
  ├─ 源文件存在且可解析
  ├─ workspace 与 targetDir 同卷
  └─ 计算 sourceSha256

阶段 1：建立 manifest
  ├─ workspace = dataDir/.migration/<kind>-<sha8>/
  ├─ 若不存在 → 创建，写 manifest（先算每个 target 的 expectedSha256）
  └─ 若已存在 → 校验 manifest.sourceSha256 与当前源一致，否则进入 F7 处理

阶段 2：快照
  └─ 源文件归一化为 JSONL 写入 source.snapshot.jsonl（内容哈希校验）

阶段 3：生成 staging
  └─ 逐日生成 staging/<date>.json，内容 = 源该天记录 + 目标目录已有记录
     （按 t 升序 + 原顺序稳定排序，保证 expectedSha256 可复现）

阶段 4：校验
  └─ 每个 staging 文件：记录数 == expectedRecordCount
     每个 staging 文件：sha256 == expectedSha256

阶段 5：替换
  └─ 逐日：备份原文件 → rename(staging/<date>.json → targetDir/<date>.json)
     → 更新 status.completedTargets

阶段 6：收尾
  ├─ 源文件 rename 为 <name>.migrated
  └─ status.phase = 'done'
```

### 2.7 F7：源文件在迁移中变化（用户特别要求）

**v1 的做法有误**：直接建新 workspace 继续合并，会与旧的未完成迁移叠加，**导致重复累计**。

**v2 正确做法**：

```
检测到 manifest.sourceSha256 !== 当前 sourceSha256：

1. 先判定旧 workspace 的状态（走 §2.5 的恢复判定）
2. 若旧 workspace 有未完成的 target：
     → **停止**，提示「上次迁移未完成且源文件已变化。请先完成或回滚上次迁移」
     → **不创建新 workspace**，不继续合并
3. 若旧 workspace 已完成（phase=done）：
     → 源文件已改名 → 当前的新源文件是另一份数据 → 允许新建 workspace
4. 旧 workspace 一律**保留不删**，供审计
```

### 2.8 回滚流程修正（用户第 2 点末段）

**v1 的错误**：「删掉 `activities/*.json`，把 `activities.json.migrated` 改回」——这会**误删迁移期间新录制/新补录的数据**。

**v2 正确回滚**：

```
回滚步骤（需用户显式触发）：
1. 停止录制（activityRecorder.stop() + flush()）
2. 对每个 target 日期：
     ├─ 若 manifest 有 preReplaceBackup（原文件曾存在）
     │    → 用备份**恢复**该文件（不是删除）
     └─ 若 preReplaceBackup 为 null（原文件本来不存在）
          → 删除该日期文件（因为它是迁移新建的）
3. 源文件：把 <name>.migrated 改回原名
4. 保留 .migration/ 工作区（不删），标记 status.phase = 'rolledback'
5. 重启后视为未迁移状态

**关键约束**：
- 只处理 manifest.targets 里列出的日期，**不删除其他日期文件**
- 迁移期间新产生的日期（不在 manifest 里）**完全不碰**
- 回滚前后各日期记录数必须与迁移前一致
```

### 2.9 文件范围

| 文件 | 改动 |
|---|---|
| 新增 `electron/legacyMigration.js` | 通用迁移引擎，参数化 `kind`（activities / summaries） |
| `electron/storageManager.js:220-271` | `_migrateIfNeeded` 改为调用 `legacyMigration.runMigration({kind, sourcePath, targetDir, ...})` 两次 |
| 新增 `tests/legacyMigration.test.cjs` | 活动迁移 F1-F8 |
| 新增 `tests/legacyMigrationSummaries.test.cjs` | 摘要迁移 F1-F8（独立） |
| 新增 `tests/migrationRecovery.test.cjs` | SHA256 判定、跨卷、源变化、回滚 |

### 2.10 故障注入矩阵（v2 扩展）

**活动迁移 F1-F9** + **摘要迁移 S1-S9**（结构相同，数值独立）

| # | 注入位置 | 预期行为 |
|---|---|---|
| F1 | 写 manifest 后崩溃 | 复用 workspace，重新生成 staging |
| F2 | 生成第 2 个 staging 时崩溃 | 第 1 个复用，第 2 个重新生成 |
| F3 | staging 全部完成，替换前崩溃 | 直接进入替换 |
| F4 | rename 第 2 个文件时崩溃 | 第 1 个已就位不重复，从第 2 个继续 |
| **F4a** | **rename 成功、status 更新前强杀** | **重启时靠 expectedSha256 判定已就位，标记完成，不重复写入** |
| F5 | 源文件 rename 失败（被锁） | 目标已就位，重启时检测到所有 target 完成 → 直接执行源文件改名 |
| F6 | 两次崩溃（F4 后再次崩溃） | 最终结果逐字节等同一次成功 |
| F7 | 源文件迁移中被修改 | **停止**，不建新 workspace，提示先处理旧的 |
| F8 | 目标目录已有旧数据 | 合并进 staging，替换后 = 源天数 + 原文件数，不重复 |
| F9 | workspace 与 targetDir 跨卷 | 前置检查拒绝，提示用户 |

### 2.11 验收标准

1. F1-F9 与 S1-S9 全部通过
2. 任意中断恢复后，`activities/` 与 `summaries/` 各文件记录数 = 预期，无重复
3. **活动记录数**迁移前后守恒：`sum(activities/*.json 记录数) == sourceRecordCount`
4. **摘要记录数**迁移前后守恒：`sum(summaries/*.json 记录数) == sourceRecordCount`
5. 连续启动 10 次，两套记录数均不变
6. 回滚后各日期记录数与迁移前逐条一致，**迁移期间新增数据不受影响**
7. 自定义数据目录场景（源在默认目录、目标在自定义目录）迁移成功

### 2.12 历史数据风险与回滚

| 项 | 说明 |
|---|---|
| 风险 | 迁移重写 `activities/*.json` 与 `summaries/*.json`。合并逻辑错误可能丢记录 |
| 保护 1 | 两个源文件全程不删，最后才改名 `.migrated` |
| 保护 2 | 每个目标文件替换前备份为 `staging/<date>.pre-replace.json` |
| 保护 3 | `.migration/` 工作区含不可变 `source.snapshot.jsonl` |
| 保护 4 | manifest 记录 `expectedSha256` 与 `preReplaceSha256`，可逐文件验证 |
| 回滚 | 见 §2.8，**不是删目录，而是按 manifest 恢复** |

---

## 三、V0.10.2b — 导入安全与危险入口处理

### 3.1 决策落地（D-01）

| 要求 | 实现 |
|---|---|
| 取消危险的覆盖导入入口 | 删除 `SettingsView.vue:277` 按钮 + `@import-overwrite` 事件链 |
| 保留普通合并导入 | 保留 `SettingsView.vue:276` |
| 普通导入不得清空原始记录 | 删除 `main.js:1514-1516` 的 `clearActivities()` 调用 |
| 未来恢复备份单独立项 | 本次不做，约束见 §3.5 |

### 3.2 快照范围扩大（用户第 6 点）

**v1 只快照 `activities/`，不够。** 完整 JSON 导入同时写 activities 和 summaries（`main.js:1530-1544`），且 `saveSummary` 还会写 `summaries_md/`（`storageManager.js:691-697`）。

**v2 快照覆盖三个目录**：

```
Data/snapshots/import-<YYYYMMDD-HHmmss>/
├── activities/          ← 全量复制
├── summaries/           ← 全量复制
├── summaries_md/        ← 全量复制
└── snapshot-manifest.json
      { createdAt, trigger: 'import-merge',
        sourceFile, sourceFingerprint,
        counts: { activities: N, summaries: M, summariesMd: K } }
```

### 3.3 逐条写入结果统计（用户第 6 点）

现有代码（`main.js:1526-1544`）不检查返回值：

```js
data.activities.forEach(a => {
  if (a.timestamp && a.processName) {
    storageManager.saveActivity(a);   // ← 返回值被丢弃
    importedCount++;                  // ← 无论成功失败都 +1
  }
});
```

**v2 要求**：

```js
let succeeded = 0, failed = 0, skipped = 0;
for (const a of data.activities) {
  if (!a.timestamp || !a.processName) { skipped++; continue; }
  if (storageManager.saveActivity(a)) succeeded++;
  else failed++;
}
```

返回 `{ ok, succeeded, failed, skipped, snapshotPath, fingerprint }`，UI 如实展示。**“导入成功”必须意味着每一条都写成功了。**

### 3.4 本次不做内容去重（理由）

用户明确「宁可保留，不允许误删」。无 `rid` 时任何内容去重都会误删（第二轮实测：4 条合法记录合并成 1 条）。**V0.10.2b 容忍重复，去重放 V0.10.3。**

### 3.5 导入来源指纹（用户第 6 点，v2 扩展）

**v1 的缺陷**：只算 activities 部分字段，会误判。

**v2 定义**：

```js
function computeFingerprint(importedJson) {
  const parts = [];

  // 1. 活动：按原数组顺序，逐条规范化
  for (const a of importedJson.activities || []) {
    parts.push('A:' + canonical(a, [
      'timestamp', 'processName', 'windowTitle', 'durationMs',
      'kind', 'source', 'category', 'project'
    ]));
  }

  // 2. 摘要：同样按原顺序
  for (const s of importedJson.summaries || []) {
    parts.push('S:' + canonical(s, [
      'timestamp', 'date', 'summary', 'slots', 'apps'
    ]));
  }

  return sha256(parts.join('\n'));
}

function canonical(obj, keys) {
  // 固定 key 顺序；缺失字段用 null 占位；不排序数组（保留原顺序）
  // 不删除重复项（保留合法重复）
  return JSON.stringify(keys.map(k => obj[k] === undefined ? null : obj[k]));
}
```

**关键设计点**：

| 要求 | 落实 |
|---|---|
| 包含活动与摘要全部有效数据 | `A:` 与 `S:` 两类都进指纹 |
| 规范化 JSON | 固定 key 顺序、缺失补 null、不使用 `JSON.stringify(obj)`（键序不定） |
| 保留数组顺序 | 按原数组顺序拼接，**不排序** |
| 保留合法重复 | **不去重**，同一文件中两条相同记录都会进入指纹串 |
| 不只算部分字段 | 每次修改此 key 列表都必须重算历史指纹（在代码注释标注版本号） |

**指纹用途**：

| 用途 | 做法 |
|---|---|
| 识别「这份文件导入过」 | 比对 `Data/.import-history.json` |
| 防重复导入 | 命中则提示「该文件已于 X 导入过，共 N 条」，**默认不导入**，允许强制 |
| 不逐条去重 | 指纹是整文件粒度，同一文件内部重复完整保留 |

### 3.6 `clearActivities` 处置

保留方法（规范第 9 条），但移除唯一生产调用，加「生产禁用」注释，并新增测试断言生产代码无非定义调用。

### 3.7 「切换数据目录」≠「导入备份」（回应 D-01 第 5 条）

| 维度 | 切换数据目录 | 导入备份 |
|---|---|---|
| 现有实现 | `migrateDataTo` + `copyMissingData`，`COPYFILE_EXCL` 只复制不存在文件，**不删源** | 未实现 |
| 语义 | 换地方继续用，旧目录原样保留 | 用备份**替换**当前 |
| 是否删数据 | 否 | 是（需六重保护） |
| 适用 | 换机（把旧目录拷到新机指向它） | 恢复到某个历史状态 |

### 3.8 文件范围

| 文件 | 改动 |
|---|---|
| `src/views/SettingsView.vue:277,279,632` | 删除覆盖按钮、修正文案、移除 emit |
| `src/App.vue:173,1175` | 删除 overwrite 分支 |
| `electron/main.js:1453,1514-1544` | 删除 overwrite 分支；快照扩三目录；逐条统计 |
| `electron/storageManager.js:663` | `clearActivities` 加禁用注释 |
| `electron/storageManager.js` 新增 | `snapshotBeforeImport()` |
| 新增 `electron/importFingerprint.js` | 指纹计算与历史 |
| 新增 `tests/importSafety.test.cjs` | 不清空、三目录快照、逐条统计 |
| 新增 `tests/importFingerprint.test.cjs` | 指纹含摘要、保留顺序、保留重复 |

### 3.9 验收标准

1. 合并导入后，`activities/`、`summaries/`、`summaries_md/` 三处快照完整，计数与导入前一致
2. 模拟某条 `saveActivity` 返回 false → 返回结果里 `failed` 计数正确，UI 如实展示
3. 生产代码中 `.clearActivities(` 除定义外无调用（测试断言）
4. 同一文件导入两次 → 第二次提示「已导入过」，默认不执行
5. 同一文件内部含 2 条完全相同记录 → 导入后仍是 2 条，指纹计算不受影响

---

## 四、V0.10.3 — 记录唯一标识与去重治理

### 4.1 决策落地（D-03）

| 要求 | 实现 |
|---|---|
| 新记录有稳定 rid | `randomUUID()` 生成并落盘 |
| 不批量改写历史 | 旧记录不写 rid |
| 旧数据继续兼容 | `_fromSegment` 对无 rid 正常处理 |
| 文件名+行号**仅兼容定位** | 注释明确，不跨读取使用 |
| 只有确认同一副本才去重 | 双方都有 rid 且相同才去重 |
| 无法确认宁可保留 | 默认不去重 |

### 4.2 rid 生成点

| 位置 | 时机 |
|---|---|
| `activityRecorder.js:_emit()` | 每个自动片段 |
| `main.js:1180` | 人工补记（已有 groupId，另加 rid） |
| `main.js:1197` | 展示层替换（同上） |
| `storageManager.updateDisplayRecord()` | **仅当被编辑的那条无 rid 时**（见 4.6） |

### 4.3 落盘与读取

落盘：`storageManager.js:316-336` 加 `...(r.rid ? { rid: r.rid } : {})`
读取：`_fromSegment` 加 `rid: rec.rid || null`

### 4.4 iCloud 冲突副本去重安全性（重新审查结论）

**旧记录（无 rid）在副本中绝对不能自动去重。**

理由：冲突副本语义是「并发写入的另一个版本」，不是主文件拷贝。现有测试 `icloudConflict.test.cjs` 就是主文件 `app:'main'`、副本 `app:'copy'` 两条都要读到。

**去重策略表**：

| 场景 | 处理 |
|---|---|
| 双方同 rid | 去重 |
| 双方不同 rid | 保留两条 |
| 一方无 rid | 保留两条 |
| 双方都无 rid | 保留两条 |
| 同文件内重复 | **永不去重** |

### 4.5 副本文件名严格正则

现有 `_activityFilesOfDay` 用 `startsWith(dateStr) && endsWith('.jsonl')`，实测误匹配 `-backup`、`.old`、`-080`。

```
严格正则： ^<dateStr>(?: (?:\(\d+\)|\d+))?\.jsonl$
```

实测结果：

```
   主文件      2026-11-08.jsonl
   副本       2026-11-08 2.jsonl
   副本       2026-11-08 (1).jsonl
   非本日文件    2026-11-08-backup.jsonl
   非本日文件    2026-11-08.old.jsonl
   非本日文件    2026-11-080.jsonl
```

### 4.6 rid 补齐的严格限制（Q3 用户决定）

**选 A，但限定**：

| 规则 | 说明 |
|---|---|
| 新记录 | 正常生成 UUID |
| 旧记录 | **不批量补** rid |
| 用户编辑旧展示记录 | **只给实际编辑的那一条**补 rid |
| 同文件其他历史记录 | **不得**因本次编辑而补 rid |
| 历史记录的时间/时长/分类 | **不得**因 rid 引入而改变 |

**实现要点**（`updateDisplayRecord`）：

```js
if (!hit.rid) {
  next.rid = crypto.randomUUID();   // 只给这一条
}
next.editedAt = new Date().toISOString();
// 其余记录原样写回，不动 rid、不动任何字段
```

测试断言：编辑 1 条后，同文件其他 N 条记录的**完整 JSON 序列化结果与编辑前逐字节相同**。

### 4.7 文件范围

| 文件 | 改动 |
|---|---|
| `electron/activityRecorder.js` | `_emit` 生成 rid |
| `electron/storageManager.js:316` | 落盘保留 rid |
| `electron/storageManager.js:118` | 读取 rid |
| `electron/storageManager.js:167-182` | 严格正则 + rid 去重 |
| `electron/storageManager.js:421-449` | `updateDisplayRecord` 限定补 rid |
| `electron/main.js:1180,1197` | 人工记录加 rid |
| `electron/main.js:1453` | 导入改用指纹 |
| 新增 `tests/recordIdentity.test.cjs` | rid 生成/落盘/重启不变 |
| 新增 `tests/conflictDedupe.test.cjs` | 5 种组合 |
| 新增 `tests/ridBackfill.test.cjs` | 只补被编辑那条，其他逐字节不变 |
| **修改** `tests/duplicateImport.test.cjs` | 第 1、2 条改为断言正确行为 |

### 4.8 验收标准

1. 新录制片段带 rid，重启后不变
2. `t+app+dur` 相同的 4 条记录仍读回 4 条
3. 同 rid 主文件+副本 → 1 条；不同 rid → 2 条；无 rid → **2 条（保留）**
4. 编辑 1 条旧记录后，同文件其他记录逐字节不变
5. `-backup`、`.old` 文件不再被读为当天数据

---

## 五、V0.10.4 — 15 分钟规则统一

### 5.1 模块定义

`electron/slotRule.js` 导出：

```js
snapStart(dateStr, startHHmm)                     // 就近
deriveEnd(startRaw, durationMin)                  // 返回 { endRaw, crossMidnight }
snapEnd(endRaw)                                   // 支持 1440 表示次日 00:00
snapRange(dateStr, startHHmm, durationMin)        // 返回 { start, end, durationMin, crossMidnight, rejected?, reason? }
findOverlaps(dateStr, start, end, records)        // 返回重叠列表
```

### 5.2 7 处调用点

`main.js:1150/1154`、`storageManager.js:610-611`、`planManager.js:165/183/265`、`analytics.js:1212-1214`、`App.vue:541`、`TimelineView.vue:1116`

### 5.3 UI 要求

1. **保存前显示吸附结果**（D-02 第 6 条）：`09:07—10:42 → 将保存为 09:00—10:45，共 105 分钟`
2. **失真必须明确告知**：`输入 22 分钟 → 将保存为 15 分钟`（不能隐藏）
3. 不足 15 分钟：`人工记录最短 15 分钟，当前 3 分钟，请调整`

### 5.4 重叠处理（Q2 用户决定）

| 重叠类型 | 处理 | 数据影响 |
|---|---|---|
| 与**自动记录**重叠 | **提示但允许**（这是补记的正当用途） | 写**展示层**标注，记录层不动 |
| 与**另一条人工记录**重叠 | **默认阻断**，提示调整时间 | 不写入 |
| 用户确认覆盖展示层 | 只删/改展示层记录 | **记录层完全不动** |

**硬约束**：原始自动记录在任何操作前后**逐字节一致**。测试必须验证。

### 5.5 `manualSnap.test.cjs` 改造

从复刻算法改为直接调用 `slotRule.snapRange()`。这是消除假绿的唯一办法。

---

## 六、版本顺序与依赖

```
V0.10.2a 迁移幂等（活动+摘要）──┐
                                 ├→ V0.10.3 记录标识与去重 → V0.10.4 15分钟统一
V0.10.2b 导入安全 ──────────────┘
```

### 提交计划

| 版本 | 提交数 | 内容 |
|---|---|---|
| V0.10.2a | 1 | `legacyMigration.js` + `_migrateIfNeeded` 改造 + 3 个测试文件 |
| V0.10.2b | 1 | 删除覆盖入口 + 三目录快照 + 逐条统计 + 指纹模块 + 2 个测试 |
| V0.10.3 | 2 | ① rid + 严格正则 + 去重；② 导入指纹接入 |
| V0.10.4 | 1 | `slotRule.js` + 7 处对齐 + 重叠检测 + 失真提示 |

---

## 七、测试矩阵汇总

| ID | 版本 | 场景 | 断言 |
|---|---|---|---|
| T-M01 | 2a | F1-F9 活动迁移故障注入 | 9 个中断点各恢复正确 |
| T-M02 | 2a | S1-S9 摘要迁移故障注入 | 9 个中断点各恢复正确 |
| T-M03 | 2a | 活动记录数守恒 | 迁移后总数 == 源条数 |
| T-M04 | 2a | 摘要记录数守恒 | 同上 |
| T-M05 | 2a | 跨卷 workspace | 前置检查拒绝 |
| T-M06 | 2a | 源文件迁移中变化 | 停止不新建 workspace |
| T-M07 | 2a | 回滚 | 各日期逐条一致，新数据不受影响 |
| T-M08 | 2a | 自定义数据目录 | 源默认目录→目标自定义目录成功 |
| T-I01 | 2b | 导入不清空原始记录 | 导入前后记录数增加而非归零 |
| T-I02 | 2b | 三目录快照完整 | 快照计数 == 导入前计数 |
| T-I03 | 2b | 逐条写入统计 | failed 计数准确 |
| T-I04 | 2b | 无 clearActivities 生产调用 | 静态检查 |
| T-I05 | 2b | 指纹含摘要 | 只改摘要则指纹变 |
| T-I06 | 2b | 指纹保留顺序与重复 | 两条相同记录指纹稳定 |
| T-I07 | 2b | 重复导入提示 | 第二次默认不执行 |
| T-R01 | 2.3 | rid 生成/落盘/重启不变 | — |
| T-R02 | 2.3 | 5 种去重组合 | 无 rid 一律保留 |
| T-R03 | 2.3 | 只补被编辑那条 | 其他记录逐字节不变 |
| T-R04 | 2.3 | 严格副本正则 | `-backup`/`.old` 不读 |
| T-D02-01 | 2.4 | `09:07—10:42` | 105 分钟 |
| T-D02-02 | 2.4 | `09:00 + 22min` | 15 分钟（**并提示失真**） |
| T-D02-03 | 2.4 | `09:07 + 3min` | **拒绝** |
| T-D02-04 | 2.4 | `23:45 + 15min` | 次日 00:00，15 分钟 |
| T-D02-05 | 2.4 | `23:50 + 30min` | 30 分钟，正确拆分 |
| T-D02-06 | 2.4 | 与自动记录重叠 | 允许，记录层逐字节不变 |
| T-D02-07 | 2.4 | 与人工记录重叠 | 阻断 |
| T-D02-08 | 2.4 | 前后端一致性 | 同一输入输出逐字段相等 |

---

## 八、全局验收基线

| 项 | 标准 |
|---|---|
| `npm test` | 全绿，新增测试与功能点匹配 |
| `npm run lint` | 0 告警 |
| `npm run build` | 成功 |
| 历史数据 | 版本前后同一批数据条数与内容一致（除计划内变更） |
| 真实数据 | 全程不读写 `%APPDATA%/worklog-assistant/Data` |
| 回归 | 上一版本全部测试仍通过 |
| 回滚 | 提供明确代码回退与数据回退步骤 |

---

## 九、本轮边界确认

| 要求 | 执行情况 |
|---|---|
| 更新三份文档 | ✅ 计划、第一轮、第二轮 |
| 逐项核对版本号/决策编号/测试矩阵/验收标准 | ✅ 见 §十 自检 |
| 只改文档，不改生产代码和测试代码 | ✅ `git diff -- electron/ src/ tests/` 为空 |
| 提交并推送后停止 | ✅ |

### 自检结果

| 检查项 | 结果 |
|---|---|
| 版本号一致性 | V0.10.2a / V0.10.2b / V0.10.3 / V0.10.4 四份文档一致 |
| 决策编号 | D-01~D-04 三份文档均出现且语义一致 |
| 测试矩阵 | 25 项，覆盖两套迁移、导入、rid、D-02 |
| 验收标准 | 每个版本均有独立验收标准 |
| v1 错误更正 | §1.5 明确作废「完全消除失真」说法；§2.8 修正回滚流程 |
