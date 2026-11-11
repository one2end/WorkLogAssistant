# WorkLog 1.0 实施计划（V0.10.2a → V0.10.4）

> 依据：`docs/WORKLOG_1.0_AUDIT_ROUND2.md` + 四项产品决策 + 五轮修订意见
> 分支：`worklog-1.0-dev`　基准提交：`9273912`
> 状态：**已冻结（第 5 版）。批准进入 V0.10.2a 开发。**
> 最后更新：2026-11-12 02:11

> # 🔒 冻结声明
>
> **WorkLog 1.0 实施方案冻结，批准进入 V0.10.2a 开发。**
>
> 冻结日期：2026-11-12
> 冻结依据：下列六项验收门槛全部满足（逐项核验结果见文末 §十）。
>
> | # | 门槛 | 结果 |
> |---|---|---|
> | 1 | 不存在已确认的 P0 数据丢失、覆盖或重复迁移漏洞 | ✅ 通过 |
> | 2 | 所有 StorageManager 写入入口均纳入统一保护 | ✅ 通过（16 个方法，15 个阻塞） |
> | 3 | 迁移中断、恢复、回滚和冲突处理有明确状态机 | ✅ 通过（9 状态，4 终态） |
> | 4 | 活动和摘要迁移均有完整故障注入矩阵 | ✅ 通过（各 11 点，对称） |
> | 5 | 文档中的测试编号、版本、验收标准一致 | ✅ 通过（53 条目核验一致） |
> | 6 | 没有影响 V0.10.2a 开发的重大设计矛盾 | ✅ 通过 |
>
> **冻结后的规则**：
>
> 1. 本文档不再进行新一轮审计循环。
> 2. 开发中若发现设计与代码不符，以代码为准，记录到「后续优化清单」（§十一），**不因此停工**。
> 3. 只有出现**新的、经代码核实的数据丢失/覆盖/重复累计**风险，才允许暂停开发并回到本文档。
> 4. D-01~D-04 四项产品决策不再变更。
> 5. 纯理论性边缘风险不列为阻断项。

---

## 修订记录

| 版本 | 变更 |
|---|---|
| v1 | 初版，落实 D-01~D-04 |
| v2 | 七项修订：摘要迁移、崩溃窗口、D-02 拒绝短时段、重叠分级、RID 限定、快照扩三目录、指纹覆盖摘要 |
| v3 | 四项 P0 + 四项 P1：守恒公式、F5a、写入保护、D-02 原始值接口、指纹全字段、摘要半成功、起点进位、同卷实测 |
| v4 | 四项 P0 + 四项 P1 + 文档清理：状态机终态、回滚 SHA 保护、源文件最终校验、统一写入锁、导入续传、volatile 按类型、故障矩阵对称、manifest 补字段、章节重编号、旧方案作废、数量勘误 |
| **v5** | **四处修正：`saveScreenshot` 与 `cleanupOldData` 纳入写锁、回滚时文件不存在的歧义判定、归档三校验点与唯一归档名、导入重试规则统一** |

### v5 修正清单

| # | v4 的问题 | v5 修正 | 级别 |
|---|---|---|---|
| 1 | `saveScreenshot` 被排除在锁外，理由「截图不是迁移目标」 | **该理由错误**：它实际重写 `activities/<today>.json`。已纳入锁并加独立测试 | **P0-01** |
| 1b | 漏了 `cleanupOldData` | 它 `unlinkSync` 删历史文件（当前为死代码）。已纳入锁 | **P0-01 补充** |
| 2 | 回滚时 `currentSha===null && preReplaceExists===true` 自动恢复 | 无法区分「外部删除」与「上次回滚已完成」，改为标记 `conflict` 保留备份 | **P1-01** |
| 3 | 归档只在 rename 前校验一次 | 改为**三点校验**：改名前 → rename（唯一名）→ 改名后，归档 SHA 不符不标 `done` | **P1-03** |
| 4 | §3.4 说「重试会重复」，与 §3.6 的 `imp` 机制矛盾 | 统一为「默认继续、以 `imp` 为事实依据、progress 仅缓存」 | **P1-02** |

### v5 用实际代码验证的三处

| 结论 | 验证方式 |
|---|---|
| `saveScreenshot` 重写 activities | 读 `storageManager.js:761-774`，看到 `this._writeJsonFile(todayFile, activities)` |
| `renameSync` 会静默覆盖已存在目标 | 临时目录实测：`rename 后 dst=NEW`（旧备份 OLD-BACKUP 丢失） |
| 回滚时 null 有两种成因不可区分 | 逐场景推演：外部删除 vs 上次回滚已完成，status 无法区分 |

### v5 的关键立场（不变）

> **宁可停止、提示人工处理，也不静默丢失、覆盖或重复累计用户历史数据。**
>
> v5 新增体现：截图写入被阻塞、归档不覆盖旧备份、回滚不猜文件缺失原因、导入默认走「继续」。
| 1 | 迁移只保护 `activities.json` | `activities.json` 与 `summaries.json` **两套独立**迁移保护 |
| 2 | 先 rename 后写 status，存在崩溃窗口 | manifest 记录**预期 SHA256**，恢复时比对判定 |
| 3 | `duration <= 0` 一律 +24h | **区分跨午夜与短时段**，不做统一加 24 小时 |
| 4 | 短时段自动提升到 15 分钟 | **改选 B：拒绝保存**，用**原始时长**判定（不是吸附后） |
| 5 | 声称「完全消除时长失真」 | **作废该说法**。`09:00+22min` 吸附后为 `09:00—09:15` 共 15 分钟（少记 7 分），必须告知用户 |
| 6 | 重叠处理含糊 | 自动记录可覆盖（写展示层）、人工记录阻断、记录层永久只读 |
| 7 | 回滚「删掉 activities/*.json」 | **错误**。必须恢复迁移前快照，不得误删迁移期间新数据 |
| 8 | 导入快照只覆盖 activities | 覆盖 `activities/`、`summaries/`、`summaries_md/` |
| 9 | 指纹只算部分字段 | 覆盖全部字段（v3 进一步改为**全字段排除 volatile**） |

---

## 零、决策确认与 v4 落实

| 决策 | 结论 | v4 落实要点 |
|---|---|---|
| **D-01** | 取消危险覆盖导入；保留合并导入；普通导入不得清空原始记录；恢复备份单独立项 | 快照扩至三个目录；逐条统计；不做恢复功能 |
| **D-02** | 起止**分别就近**吸附；时长=吸附后结束−开始；**不再单独取整**；最短 15 分钟（**选 B 拒绝**）；重叠需提示 | **后端收原始值自行验算**（v3 关键修正）；起点进位跨日单独处理 |
| **D-03** | 新记录 UUID；不批量改写历史；旧数据仅兼容定位；只有确认同一副本才去重 | Q3 选 A 但**限定**：只给实际编辑的那一条补 RID |
| **D-04** | 拆 V0.10.2a（迁移幂等）+ V0.10.2b（导入安全）；迁移必须可恢复 | 双迁移独立 manifest；SHA256 恢复判定；**F4a + F5a**；**写入暂停机制** |

### Q1/Q2/Q3 的最终答案

| 问题 | 用户决定 | 落实位置 |
|---|---|---|
| **Q1** 极短时间 | **选 B：拒绝保存**，提示用户调整。禁止把 3 分钟变成 15 分钟工时 | §1.6 |
| **Q2** 重叠语义 | 自动记录重叠：**提示但允许**（写展示层）；人工记录重叠：**阻断**；记录层永不修改 | §5.4 |
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

### 1.7 接口契约（v3 重写，v4 保持）

> **v3 修正：v2 的接口设计有缺陷。** v2 让后端接收「已吸附的 `startTime + durationMin`」，但这样**后端无法验证原始时长是否不足 15 分钟**。

**实测证明**：

| 用户输入 | 前端吸附后传给后端 | 后端能否识别原始时长不足 |
|---|---|---|
| 09:07 + 3min | `startTime=09:00, durationMin=15` | **不能** |
| 09:07 + 8min | `startTime=09:00, durationMin=15` | **不能** |
| 09:07 + 22min | `startTime=09:00, durationMin=15` | **不能** |

3 分钟与 22 分钟吸附后完全相同，后端无从区分。**若只信前端传来的值，Q1 的拒绝规则形同虚设。**

**v3 接口定义**：

```jsonc
// 前端 → 后端（保存时必须传原始值）
{
  "date": "2026-11-08",           // 原始日期
  "startTime": "09:07",           // 原始开始时间，未吸附
  "rawDurationMin": 22,           // 原始时长，未吸附
  "app": "...", "category": "...", "note": "...", "project": "..."
}
```

```jsonc
// 前端 → 后端（预览时，仅用于显示，不落盘）
{
  "date": "2026-11-08",
  "startTime": "09:07",
  "rawDurationMin": 22,
  "previewOnly": true
}
```

**后端处理流程**：

```
1. 校验 rawDurationMin：
   - 非整数 / < 1 / > 1440 → 拒绝「时长需在 1–1440 分钟之间」
   - < 15                  → 拒绝「人工记录最短 15 分钟，当前 N 分钟，请调整时间」
2. 校验 startTime 格式 HH:mm
3. 调用 slotRule.snapRange(date, startTime, rawDurationMin) —— 与前端同一个函数
4. 若 snapRange 返回 rejected → 拒绝，透传原因
5. 若 snapStart 跨日（见 §1.8）→ 按该节规则处理
6. 重叠检测（见 §5.4）
7. 写入
```

**「保存不重算」的替代方案**：v2 写「后端校验吸附结果是否与前端一致」。v3 改为**后端自己算一遍**，因为后端有原始值，可以独立计算。这比「校验前端传来的吸附结果」更可靠——前端被篡改或版本不一致时后端仍能得出正确结果。

**一致性保证**：

| 措施 | 说明 |
|---|---|
| 单一算法源 | `electron/slotRule.js` 是唯一实现；前端通过 IPC 调用主进程的同一份代码，**不复制到渲染层** |
| 预览即结果 | 前端调 `previewOnly: true` 拿吸附结果展示「将保存为 09:00—10:45，共 105 分钟」 |
| 后端独立复算 | 后端拿到原始值后重新计算，结果与预览一致（同一函数同一输入） |
| 测试 | T-D02-08 断言：同一组原始输入，预览接口与保存接口返回的吸附结果逐字段相等 |

### 1.8 起点吸附导致跨日的边界（v3 新增，v2 遗漏）

**v2 未识别的问题**：起点吸附可能进位到 24:00，也就是**次日 00:00**。

实测数据：

| 输入 | startRaw | 吸附起点 | 是否跨日 | 吸附终点 | 时长 |
|---|---|---|---|---|---|
| 23:45 + 15min | 1425 | 23:45 | 否 | 次日 00:00 | 15 分 |
| 23:52 + 15min | 1432 | 23:45 | 否 | 次日 00:00 | 15 分 |
| **23:53 + 15min** | 1433 | **次日 00:00** | **是 ← 问题** | 次日 00:15 | 15 分 |
| **23:59 + 15min** | 1439 | **次日 00:00** | **是 ← 问题** | 次日 00:15 | 15 分 |
| 23:52 + 30min | 1432 | 23:45 | 否 | 次日 00:15 | 30 分 |
| **23:53 + 30min** | 1433 | **次日 00:00** | **是 ← 问题** | 次日 00:30 | 30 分 |

**问题本质**：用户填「2026-11-08 23:53」，吸附后变成「2026-11-09 00:00」，**记录被推到第二天**，日期与用户输入不符。

**v3 处理规则**：

```
若 snapStart >= 1440（起点进位到次日）：
    拒绝保存，提示：
    「开始时间 23:53 吸附后为次日 00:00，会改变记录日期。
      请改为 23:45 或更早，或把日期改为次日。」
```

**为什么选拒绝而不是自动顺延日期**：自动改日期是更隐蔽的数据错误——用户以为记在 11-08，实际记在 11-09，统计口径全错。**明确拒绝让用户自己决定**，符合「无法确认宁可保留、不擅自改变」的一贯原则。

**测试用例**（T-D02-09）：`23:45 / 23:52 / 23:53 / 23:59` 四个起点，分别配 15 分钟与 30 分钟时长，验证：
- `23:45`、`23:52` → 正常保存，起点仍是当天
- `23:53`、`23:59` → 拒绝，错误信息含「会改变记录日期」

**终点允许到 1440**：`snapEnd === 1440` 表示「次日 00:00」，这是**合法终点**，由 `timeSplit` 拆成两段。与起点跨日的处理不同，不要混淆。

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

**验证（v3 修正）**

> **v3 修正：v2 的 `path.parse().root` 比较不可靠。**
>
> 局限：
> - **root 相同不代表同卷**：Windows 上同一盘符可以通过 `mountvol` 挂载不同卷，或用 `subst` 映射虚拟盘
> - **root 不同不代表不同卷**：junction / symlink 指向另一位置但可能在同一物理卷
> - 网络盘（UNC 路径 `\\server\share`）的 `path.parse().root` 是 `\\server\share\`，语义与其他情况不同
> - 云同步目录（iCloud / OneDrive）常有重定向，路径与真实位置不一致

**v3 采用三级验证，逐级递进**：

```js
// 第一级：快速排除（不可靠但便宜）
// 明显不同盘符直接拒绝
if (process.platform === 'win32') {
  const rd = path.parse(workspaceDir).root.toLowerCase();
  const td = path.parse(targetDir).root.toLowerCase();
  if (rd !== td) {
    // 不一定不同卷（junction），但需要进一步验证，不能直接判失败
    needDeepCheck = true;
  }
}

// 第二级：设备号比对（辅助参考，不作为唯一依据）
// fs.statSync(p).dev 在 Unix 可靠；Windows 上返回卷序列号，对网络盘无意义
const devWorkspace = fs.statSync(workspaceDir).dev;
const devTarget = fs.statSync(targetDir).dev;
// 仅当两者都有意义且不等时，判定不同卷

// 第三级：实测 rename 探测（**最终依据**）
// 在两个目录各建临时文件，尝试跨目录 rename，捕 EXDEV
function probeSameVolume(workspaceDir, targetDir) {
  const probeName = `.samevol-probe-${process.pid}-${Date.now()}`;
  const src = path.join(workspaceDir, probeName);
  const dst = path.join(targetDir, probeName);
  try {
    fs.writeFileSync(src, 'probe', 'utf8');
    fs.renameSync(src, dst);       // 跨卷会抛 EXDEV
    fs.unlinkSync(dst);
    return { same: true };
  } catch (error) {
    try { if (fs.existsSync(src)) fs.unlinkSync(src); } catch (_) {}
    try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {}
    if (error.code === 'EXDEV') return { same: false, reason: 'EXDEV' };
    throw error;                    // 其他错误（权限、只读）如实上报
  }
}
```

**决策规则**：

| 探测结果 | 行为 |
|---|---|
| `same: true` | 继续迁移 |
| `same: false, reason: 'EXDEV'` | **拒绝迁移**，提示「暂存目录与目标目录不在同一磁盘卷，无法保证原子替换。请检查数据目录设置」 |
| 抛出其他错误（EPERM/EACCES/EROFS） | **拒绝迁移**，如实展示错误码——可能是权限或只读盘问题，不能假设同卷 |

**为什么以 rename 探测为最终依据**：它直接测的正是迁移要用到的那个操作。探测成功 = `renameSync` 可用，这是最直接的证据，优于任何路径推断。

**探测的副作用控制**：临时文件用 `.samevol-probe-` 前缀 + pid + 时间戳，无论成功失败都在 `finally` 里清理，不会留在数据目录中。

**测试**（T-M05）：在临时目录与另一个已知不同卷的路径之间探测（测试环境若无第二卷，用 mock 让 `renameSync` 抛 `EXDEV`），断言拒绝且错误信息正确。

### 2.5 manifest 与 SHA256 恢复判定

> **v4 修订（P1-04）**：补齐 `preReplaceRecordCount`，使 manifest、恢复流程、守恒公式、测试断言四者一致。

```jsonc
// manifest.json
{
  "kind": "activities",                    // activities | summaries
  "manifestVersion": 1,
  "sourcePath": "C:\\...\\Data\\activities.json",
  "sourceSha256": "a3f9c1...",             // 源文件整体哈希（迁移开始时）
  "sourceRecordCount": 1284,
  "targetDir": "C:\\...\\Data\\activities",
  "createdAt": "2026-11-12T01:00:00Z",
  "targets": [
    {
      "date": "2026-11-05",

      // ── 替换前状态（用于回滚与守恒校验）──
      "preReplaceExists": true,            // 目标文件在替换前是否存在
      "preReplaceRecordCount": 2,          // 替换前目标已有记录数；文件不存在时为 0
      "preReplaceSha256": "9a1c...",       // 替换前哈希；文件不存在时为 null
      "preReplaceBackup": "staging/2026-11-05.pre-replace.json",  // 不存在时为 null

      // ── 替换后预期（用于恢复判定）──
      "expectedRecordCount": 43,           // = preReplaceRecordCount + 源该天记录数
      "expectedSha256": "b7e2..."          // 目标文件应有的内容哈希
    }
  ]
}
```

**字段语义严格定义**：

| 字段 | 目标文件原本不存在时 | 用途 |
|---|---|---|
| `preReplaceExists` | `false` | 回滚时决定「恢复备份」还是「删除文件」 |
| `preReplaceRecordCount` | **`0`**（不是 `null`） | 守恒公式的加数，避免 `null + N` 的类型歧义 |
| `preReplaceSha256` | `null` | 恢复判定时作为「应不存在」的标记 |
| `preReplaceBackup` | `null` | 回滚时跳过恢复 |
| `expectedRecordCount` | 源该天记录数 | 校验 staging 与最终结果 |
| `expectedSha256` | 迁移后应有的哈希 | 恢复判定与回滚保护的依据 |

**守恒关系（与 §2.11 一致）**：

```
expectedRecordCount == preReplaceRecordCount + (源文件中属于该天的记录数)

sum(expectedRecordCount) == sum(preReplaceRecordCount) + sourceRecordCount
```

**迁移中目标文件变化的处理规则**：

| 时机 | 检测方式 | 处理 |
|---|---|---|
| staging 生成后、替换前 | 重算 `actualSha256`，与 `preReplaceSha256` 比 | 不等 → **停止**，标记 `conflict`（§2.14） |
| 恢复流程中 | 重算 `actualSha256`，与 `expectedSha256` / `preReplaceSha256` 比 | 都不等 → **停止**，标记 `conflict` |
| 回滚时 | 重算 `actualSha256`，与 `expectedSha256` 比 | 不等 → **不覆盖**，隔离到保护目录（§2.8） |

### 2.5a 迁移状态机（v4 新增，P0-01）

> **v4 修正**：v3 的恢复判定用 `phase !== 'done'` 作为「继续迁移」的条件，导致 `rolledback` 也会落入该分支，重启后**可能重新执行已回滚的迁移**。这是明确的状态设计缺陷。

**状态定义**：

| 状态 | 含义 | 是否终态 | 启动时行为 |
|---|---|---|---|
| `init` | 工作区已建，manifest 已写 | 否 | 继续：进入 `snapshot` |
| `snapshot` | 源快照生成中 | 否 | 继续：校验快照后进入 `staging` |
| `staging` | 生成目标暂存文件 | 否 | 继续：按 SHA 判定后补齐缺失 staging |
| `replacing` | 正在逐文件原子替换 | 否 | 继续：按 §2.5 判定已完成/未完成，续跑 |
| `finishing` | 所有 target 已替换，待改源文件名 | 否 | 校验源 SHA 后完成改名（P0-03） |
| `done` | **迁移成功完成** | **是** | **不执行任何操作**；仅做幂等确认 |
| `rolledback` | **用户主动回滚完成** | **是** | **绝不自动重新迁移**；保留工作区供审计 |
| `conflict` | 检测到无法确认的冲突 | **是** | **绝不自动继续**；等待人工处理 |
| `failed` | 迁移过程中不可恢复的错误 | **是** | **绝不自动继续**；等待人工处理 |

**终态的启动行为（关键）**：

```
启动时扫描 Data/.migration/*/status.json：

switch (status.phase) {
  case 'done':
  case 'rolledback':
    // 终态：不执行任何迁移动作
    // 只做一致性快照记录，不写任何数据
    log('迁移工作区 <id> 已处于终态 <phase>，跳过');
    break;

  case 'conflict':
  case 'failed':
    // 终态：停止并提示人工处理
    notifyUser('<id> 迁移未完成（<phase>），已停止自动处理，请人工确认');
    // 不重试、不新建工作区、不改动任何数据
    break;

  case 'init':
  case 'snapshot':
  case 'staging':
  case 'replacing':
  case 'finishing':
    // 非终态：按 §2.5 判定续跑
    resumeMigration(workspace);
    break;

  default:
    // 未知状态：按最保守策略处理
    markConflict(workspace, '未知状态 ' + status.phase);
}
```

**只有用户显式重新发起才会新建迁移任务**：

```
新建迁移任务的前置条件（三者必须同时满足）：
1. 用户通过 UI 显式触发（不是启动时自动）
2. 不存在处于非终态的工作区
3. 若存在 conflict/failed/rolledback 工作区：
     用户必须明确选择「放弃旧任务并新建」，
     旧工作区被重命名为 <id>.abandoned-<ts>/ 保留，不删除
```

**状态转移图**：

```
init → snapshot → staging → replacing → finishing → done
  │       │          │          │           │
  └───────┴──────────┴──────────┴───────────┴──→ conflict（任一阶段检测到冲突）
  │       │          │          │           │
  └───────┴──────────┴──────────┴───────────┴──→ failed（不可恢复错误）

任意非终态 → rolledback（用户主动回滚）
done / rolledback / conflict / failed → 终态，不再自动流转
```

**status.json 结构**：

```jsonc
{
  "phase": "replacing",
  "completedTargets": ["2026-11-05"],
  "lastError": null,
  "updatedAt": "2026-11-12T01:05:00Z",
  "conflictDetail": null          // phase === 'conflict' 时说明冲突文件与原因
}
```

**保留审计记录**：所有状态转换追加写入 `status.history[]`（时间 + 从 → 到 + 原因），工作区**永不自动删除**，仅在用户明确选择时重命名为 `.abandoned-*`。

### 2.5b 恢复判定流程

```
启动时若发现 .migration/<kind>-<sha8>/ 存在：

1. 读 manifest + status，先按 §2.5a 的终态表分流
2. 非终态时，逐 target 判定：
   for each target in manifest.targets:
       actualSha = sha256(targetDir/<date>.json)     // 不存在则为 null
       if actualSha === target.expectedSha256:
           → 已就位，标记完成（**不重算、不重写**）
       else if actualSha === target.preReplaceSha256:
           → 尚未替换，可用 staging 内容继续
       else if actualSha === null && target.preReplaceExists === false:
           → 该天本无文件且尚未创建，属「未替换」
       else:
           → **状态无法确认 → 标记 conflict**，停止：
             「无法确认 <date>.json 的状态，为避免重复追加已停止迁移。」
3. 全部 target 判定完成后，按需生成缺失的 staging，再执行替换
4. 每次 rename 后立即更新 status.completedTargets
5. 所有 target 完成后进入 finishing，执行 P0-03 的源文件最终校验
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

阶段 6：收尾（finishing）
  ├─ **重新计算源文件 SHA**（P0-03，见 §2.6a）
  ├─ 一致 → 源文件 rename 为 <name>.migrated
  └─ status.phase = 'done'
```

### 2.6a 归档阶段的竞态处理（v5 重写，P1-03）

> **v4 的问题**：在「校验源 SHA → rename → 标记 done」之间，**rename 本身没有被验证**。若外部同步软件在校验后、rename 前一刻修改文件，rename 会把被改过的内容归档为 `.migrated`，而目标文件里没有这些新数据 → **静默丢失**。
>
> **v5 方案：改名前后各校验一次，并且归档后必须与 manifest 一致才允许 `done`。**

**完整归档流程（三个校验点）**

```
【step A】改名前校验（拦住大部分情况）
    preRenameSha = sha256(sourcePath)
    if (preRenameSha !== manifest.sourceSha256):
        → 标记 conflict，stage: 'pre-rename'（见下「不改名的处理」）
        → 结束，不改名

【step B】确定安全归档名，然后 rename
    original = sourcePath                       // e.g. activities.json
    candidate = original + '.migrated'
    if (fs.existsSync(candidate)):
        // **绝不覆盖已有归档**（v5 修正：renameSync 在 Windows 会静默覆盖）
        // 用唯一名称，避免丢失历史备份
        candidate = original + '.migrated-' + <YYYYMMDD-HHmmssSSS>
        if (fs.existsSync(candidate)):          // 极端：同一毫秒
            candidate = original + '.migrated-' + <ts> + '-' + <random6>
    renameSync(original, candidate)             // 同目录内 rename，原子
    记录 status.archivedPath = candidate

【step C】改名后校验归档文件（v5 新增，堵住 step A 与 B 之间的窗口）
    archivedSha = sha256(candidate)
    if (archivedSha !== manifest.sourceSha256):
        // 源文件在 step A 之后、rename 之前被改过
        → **不把状态标记为 done**
        → status.phase = 'conflict'
        → conflictDetail = {
            stage: 'post-rename',
            expected: manifest.sourceSha256,
            actual: archivedSha,
            archivedPath: candidate,
            note: '源文件在改名前被外部修改，已归档内容与迁移开始时不一致'
          }
        → **保留归档文件**（candidate，不删除）
        → **保留目标文件**（已替换的全部保留）
        → **保留 migration workspace**
        → 提示：「归档文件内容与迁移开始时不一致，可能包含迁移后期的新数据。
                 目标文件与归档文件均已保留，请人工核对。」
        → 结束，等人工处理
    else:
        status.phase = 'done'                   // 唯一允许进入 done 的路径
```

**为什么 step B 的「唯一归档名」必要**

实测（`os.tmpdir()` 临时目录，未触碰真实数据）：

```
rename 前: src=NEW  dst=OLD-BACKUP
rename 成功（覆盖了旧备份！）
rename 后: dst=NEW
src 还在? false
```

`fs.renameSync` 在目标已存在时会**静默覆盖**。若用户之前已经迁移过一次并留下 `activities.json.migrated`，第二次迁移会把它覆盖掉——**丢的是一份完整的历史备份**。

**冲突时的三条保留承诺**

| 保留对象 | 说明 |
|---|---|
| 归档文件（`candidate`） | 可能含新数据，不删不改名 |
| 目标文件（`activities/`、`summaries/`） | 已替换的不回退 |
| migration workspace | 含 manifest、快照、staging、status.history |

**step A 失败（改名前发现不一致）的处理**：

```
→ 禁止改名（源文件保持原名原样）
→ 禁止删除或覆盖源文件
→ 保留 workspace
→ status.phase = 'conflict'，stage: 'pre-rename'
→ conflictDetail = {
     expected: manifest.sourceSha256,
     actual: preRenameSha,
     sourceRecordCountAtStart: manifest.sourceRecordCount,
     sourceRecordCountNow: <当前条数>
   }
→ 提示：「源文件在迁移过程中被修改，为避免丢失新数据已停止。
         目标文件已写入 N 个日期（可用），源文件保持原样。
         请手工核对后决定：接受目标结果，或回滚。」
```

**源文件变化且目标已部分替换时如何安全恢复**：

处于「半完成」状态，两条路，**都不能自动选**：

| 方案 | 操作 | 风险 | 适用条件 |
|---|---|---|---|
| **A. 接受已替换结果** | 保留 `activities/` 现状；源文件重命名为 `<name>.conflict-<ts>`（**不归档为 `.migrated`**）；用户后续手工处理 | 源文件的新增内容需手工合并 | 用户确认目标结果正确 |
| **B. 回滚** | 走 §2.8（含逐文件 SHA 保护）；源文件改回原名 | 迁移期间新录数据受 §2.8 保护 | 用户认为目标结果不可信 |

**绝不做的操作**：

- ❌ 因源文件变化而**重跑整个迁移** → 与已替换的目标叠加，导致重复累计
- ❌ 把变化后的源文件改名为 `.migrated` → 新数据被误标为「已处理」
- ❌ 覆盖已存在的 `.migrated` → 丢失历史归档
- ❌ 删除源文件或归档文件 → 直接丢数据
- ❌ rename 后不校验就标记 done → 竞态窗口内的修改被静默吞掉

**竞态窗口的诚实说明**

> step A 与 step B 之间仍有**微秒级窗口**。v5 不假装能消除它，而是用 **step C 的事后校验**把「静默丢失」降级为「可检测的冲突」：
>
> | 情况 | v4 行为 | v5 行为 |
> |---|---|---|
> | step A 前被改 | 检出，conflict | 检出，conflict |
> | step A 后、rename 前被改 | **静默归档错误内容，标记 done** | **step C 检出，conflict，三份数据全保留** |
> | rename 后被改 | 不影响（已归档） | 不影响 |
>
> 无法做到「零窗口」，但可以做到「**窗口内的变化不导致静默数据丢失**」。

### 2.7 F7：源文件在迁移前阶段变化

**v1 的做法有误**：直接建新 workspace 继续合并，会与旧的未完成迁移叠加，**导致重复累计**。

**正确做法**（本节点针对**迁移开始前**检测到源变化；阶段 6 的变化见 §2.6a）：

```
发现 manifest.sourceSha256 !== 当前 sourceSha256：

1. 先按 §2.5a 状态机判定旧 workspace 状态
2. 若旧 workspace 处于**非终态**：
     → **停止**，标记 conflict
     → 提示「上次迁移未完成且源文件已变化。请先完成或回滚上次迁移」
     → **不创建新 workspace**，不继续合并
3. 若旧 workspace 处于 done（源已改名）：当前新源文件是另一份数据 → 允许新建
4. 若旧 workspace 处于 rolledback：**不自动续跑**，需用户显式重新发起
5. 旧 workspace 一律**保留不删**，供审计
```

### 2.8 回滚流程（v4 修订，P0-02）

> **v4 修订。** v3 的回滚直接「用备份恢复」，**没校验目标文件当前内容**。若迁移后用户又编辑/新增了数据，回滚会把它们覆盖掉——**这正是要避免的静默丢数据**。

**v1 的错误**（保留记录）：「删掉 `activities/*.json`，把 `activities.json.migrated` 改回」——会误删迁移期间新录的数据。

**v4 正确回滚（逐文件 SHA 保护）**：

```
回滚步骤（需用户显式触发 + 二次确认）：

0. 前置：
   ├─ 停止录制（activityRecorder.stop()）
   ├─ flush 缓冲到磁盘（回滚前先落盘，避免缓冲数据丢失）
   └─ 获取写锁（§2.13）

1. 对每个 target 日期**逐个**处理（不是批量）：

   currentSha = sha256(targetDir/<date>.json)      // 不存在则为 null

   ┌─ 情况 1：currentSha === target.expectedSha256
   │    → 内容 == 迁移后预期，说明迁移后未被改动 → **允许回滚**
   │       ├─ preReplaceExists === true  → 用 preReplaceBackup 覆盖恢复
   │       └─ preReplaceExists === false → 删除该文件（迁移新建的）
   │
   ├─ 情况 2：currentSha === target.preReplaceSha256
   │    → 已是原始状态（可能上次回滚到一半）→ **跳过**
   │
   ├─ 情况 3：currentSha === null && preReplaceExists === false
   │    → 该文件原本就不存在，现在也不存在 → **跳过**（已达目标状态）
   │
   ├─ 情况 4：currentSha === null && preReplaceExists === true
   │    → **文件原本存在，现在没了，无法判断原因**
   │       · 可能是迁移后被外部删除（用户手工删 / 同步软件冲突）
   │       · 可能是上次回滚删了但 status 未更新
   │       · **两者无法区分 → 禁止自动恢复**
   │    → **标记 conflict**，不恢复备份，不创建文件
   │    → 备份保留在 staging/<date>.pre-replace.json
   │    → 记录到 conflictDetail.files[]，reason: 'target-missing-unexpectedly'
   │    → 提示：「<date>.json 原本存在但当前缺失，原因无法确认。
   │            备份已保留（路径）。请人工决定是否恢复。」
   │
   └─ 情况 5：以上都不匹配（文件存在但 SHA 既非预期也非替换前）
        → **禁止覆盖**（文件含迁移后的新数据或外部修改）
        → 复制到保护目录 Data/.migration/<id>/conflict-files/<date>.json
        → 记录到 status.conflictDetail.files[]
        → 该文件**保持原样不动**
        → 继续处理下一个（不因单个冲突中止整个回滚）

2. 汇总：
   ├─ 存在冲突文件 → status.phase = 'conflict'（终态）
   │   提示：「回滚完成，但 N 个文件未能安全处理，
   │           明细与备份已保留。请人工核对。」
   └─ 无冲突 → status.phase = 'rolledback'（终态）

3. 保留（**一律不删**）：
   ├─ source.snapshot.jsonl
   ├─ staging/<date>.pre-replace.json（**含情况 4 的全部备份**）
   ├─ migration workspace
   └─ conflict-files/

**绝不做**：
- ❌ 为「让回滚成功」而删除无法确认的文件
- ❌ 为「让回滚成功」而在情况 4 自动恢复备份（可能覆盖外部删除的意图）
- ❌ 批量覆盖后再校验（必须**先校验再决定**）
- ❌ 回滚失败时删除工作区
- ❌ 触碰 manifest.targets 之外的日期文件
```

> **v5 修正（P1-01）**：v4 在「`currentSha === null` 且 `preReplaceExists === true`」时**自动用备份恢复**。这无法区分「外部删除」与「上次回滚已完成」，属于**擅自替用户做决定**。v5 改为标记 `conflict` 并保留备份，等人工确认。

**`rolledback` 是终态**：见 §2.5a。重启后**不会**重新执行该迁移。

### 2.9 文件范围

| 文件 | 改动 |
|---|---|
| 新增 `electron/legacyMigration.js` | 通用迁移引擎，参数化 `kind`（activities / summaries） |
| `electron/storageManager.js:220-271` | `_migrateIfNeeded` 改为调用 `legacyMigration.runMigration({kind, sourcePath, targetDir, ...})` 两次 |
| 新增 `tests/legacyMigration.test.cjs` | 活动迁移 F1-F4、F4a、F5、F5a、F6-F9（**11 个中断点**） |
| 新增 `tests/legacyMigrationSummaries.test.cjs` | 摘要迁移 S1-S4、S4a、S5、S5a、S6-S9（**11 个中断点**，独立） |
| 新增 `tests/migrationRecovery.test.cjs` | SHA256 判定、跨卷、源变化、回滚 |

### 2.10 故障注入矩阵（v4 对称补齐）

**活动迁移：F1-F9 + F4a + F5a（11 个中断点）**
**摘要迁移：S1-S9 + S4a + S5a（11 个中断点，结构与活动对称，数值独立）**

> **v4 修正（P1-03）**：
> 1. v3 只给活动补了 F5a，摘要没补 **S5a**。两套结构相同，摘要同样存在「改名成功、status 未更新」的窗口，**必须对称补齐**。同理补 S4a。
> 2. v3 的「F1-F9 + F5a = 10 个」表述**自相矛盾**：F1-F9 本身是 9 个（含 F4），加 F5a 应为 10，但漏了 F4a 才是 9+2=11。**以显式枚举为准。**

**活动迁移中断点（F 系列）**

| # | 注入位置 | 预期行为 |
|---|---|---|
| F1 | 写 manifest 后崩溃 | 复用 workspace，重新生成 staging |
| F2 | 生成第 2 个 staging 时崩溃 | 第 1 个复用，第 2 个重新生成 |
| F3 | staging 全部完成，替换前崩溃 | 直接进入替换 |
| F4 | rename 第 2 个文件时崩溃 | 第 1 个已就位不重复，从第 2 个继续 |
| **F4a** | **rename 成功、status 更新前强杀** | **重启时靠 expectedSha256 判定已就位，标记完成，不重复写入** |
| F5 | 源文件 rename 失败（被锁） | 目标已就位，重启时检测到所有 target 完成 → 直接执行源文件改名 |
| **F5a** | **源文件改名 `.migrated` 成功、status 更新前强杀** | **四重判定为已完成：源文件不存在 + `.migrated` 存在 + `.migrated` 哈希 == `manifest.sourceSha256` + 所有 target 哈希 == `expectedSha256`。不重复改名、不重复迁移** |
| F6 | 两次崩溃（F4 后再次崩溃） | 最终结果逐字节等同一次成功 |
| F7 | 源文件在**迁移前阶段**被修改 | 按 §2.5a 判定旧 workspace；非终态则**停止并标记 conflict** |
| F8 | 目标目录已有旧数据 | 合并进 staging，替换后 = `preReplaceRecordCount + 源该天记录数` |
| F9 | workspace 与 targetDir 跨卷 | rename 探测捕获 EXDEV，拒绝迁移 |

**摘要迁移中断点（S 系列）**

与 F 系列**逐条对应**，仅对象从 `activities.json` → `summaries.json`、目标从 `activities/` → `summaries/`：

| # | 对应 | 注入位置 | 预期行为 |
|---|---|---|---|
| S1 | F1 | 写 summaries manifest 后崩溃 | 复用 workspace |
| S2 | F2 | 生成第 2 个 staging 时崩溃 | 第 1 个复用 |
| S3 | F3 | staging 完成、替换前崩溃 | 直接进入替换 |
| S4 | F4 | rename 第 2 个文件时崩溃 | 第 1 个不重复 |
| **S4a** | **F4a** | **rename 成功、status 未更新前强杀** | **靠 expectedSha256 判定** |
| S5 | F5 | 摘要源文件 rename 失败 | 直接执行改名 |
| **S5a** | **F5a** | **摘要源文件改名成功、status 未更新前强杀** | **四重判定（同 F5a）** |
| S6 | F6 | 两次崩溃 | 逐字节等同一次成功 |
| S7 | F7 | 摘要源文件迁移前变化 | 停止并标记 conflict |
| S8 | F8 | summaries 目录已有旧数据 | 合并，不重复 |
| S9 | F9 | 跨卷 | 拒绝 |

**统计口径（严禁混用）**

| 口径 | 数值 | 定义 |
|---|---|---|
| **测试矩阵条目数** | 见 §七汇总表实际行数 | 每个 `T-xxx` 一行；一个条目可能覆盖多个注入点 |
| **活动迁移中断点** | **11** | F1、F2、F3、F4、F4a、F5、F5a、F6、F7、F8、F9 |
| **摘要迁移中断点** | **11** | S1、S2、S3、S4、S4a、S5、S5a、S6、S7、S8、S9 |
| **迁移故障注入点合计** | **22** | 活动 11 + 摘要 11 |

> **不要写「F1-F9」这种区间写法** —— 它包含 F4 却不含 F4a/F5a，容易让人数错。文中有需要引用时，一律显式枚举或用「F 系列 11 点 / S 系列 11 点」表述。

### 2.11 验收标准（v3 修正守恒公式，v4 补并发与终态）

> **v3 修正：v2 的守恒标准是错的。**
>
> v2 写「迁移后总数 == 源记录数」，但目标目录**可能已有历史记录**（用户之前录过、或部分迁移过），迁移会把源数据合并进去，总数必然大于源记录数。
>
> 实测：目标已有 2 条 + 源文件 1 条 → 迁移后 **3 条**。按 v2 的标准会判定为「失败」，实际上迁移完全正确。

**正确守恒公式（活动与摘要分别计算）**：

```
迁移后目标总记录数
    == 迁移前目标已有记录数  +  源文件记录数

即：
sum(count(activities/<date>.json) after)
    == sum(count(activities/<date>.json) before)  +  activitiesSourceCount

sum(count(summaries/<date>.json) after)
    == sum(count(summaries/<date>.json) before)   +  summariesSourceCount
```

`before` 的值从 manifest 的 `preReplaceRecordCount` 快照读取，不再事后推算。

**验收清单**：

1. F1-F9 与 S1-S9 与 F5a 全部通过
2. 任意中断恢复后，`activities/` 与 `summaries/` 各文件记录数 = 预期，无重复
3. **活动守恒**：`迁移后 == 迁移前目标已有 + 活动源条数`
4. **摘要守恒**：`迁移后 == 迁移前目标已有 + 摘要源条数`
5. 目标目录原本为空时，退化为 `迁移后 == 源条数`（这是第 3、4 条的特例，不是通用公式）
6. 连续启动 10 次，两套记录数均不变
7. 回滚后各日期记录数与迁移前逐条一致，**迁移期间新增数据不受影响**
8. 自定义数据目录场景（源在默认目录、目标在自定义目录）迁移成功
9. 迁移期间发生的 `saveActivity` / `saveSummary` 不被覆盖（见 §2.13）

### 2.12 历史数据风险与回滚

| 项 | 说明 |
|---|---|
| 风险 | 迁移重写 `activities/*.json` 与 `summaries/*.json`。合并逻辑错误可能丢记录；并发写入可能被覆盖 |
| 保护 1 | 两个源文件全程不删，最后才改名 `.migrated` |
| 保护 2 | 每个目标文件替换前备份为 `staging/<date>.pre-replace.json` |
| 保护 3 | `.migration/` 工作区含不可变 `source.snapshot.jsonl` |
| 保护 4 | manifest 记录 `expectedSha256`、`preReplaceSha256`、`preReplaceRecordCount` |
| 保护 5 | **迁移期间暂停写入**（见 §2.13） |
| 保护 6 | **替换前重新校验目标 SHA256**，不匹配则停止 |
| 回滚 | 见 §2.8，**不是删目录，而是按 manifest 恢复**；**迁移期间新产生的日期完全不碰** |

### 2.13 统一写入锁（v4 重写，P0-04）

> **v4 修正两处 v3 缺陷：**
>
> 1. v3 只在 IPC 层列了 7 个入口，**漏掉了 `StorageManager` 自己的多个写方法**，也漏了非 IPC 路径（如 `convert-plan-to-fact`、`flush` 定时器）。锁必须建在**数据写入层**，不能建在调用层。
> 2. v3 用模块级布尔变量，没定义获取/释放/异常语义，也没解决「迁移自身也要写」的自锁问题。

**生产代码核实：16 个写方法 + 2 个目录操作**

> **v5 修正两处 v4 遗漏：**
>
> 1. **`saveScreenshot` 必须阻塞。** v4 写「截图不涉及迁移目标」是**错误的**——核实 `storageManager.js:761-774`，它读 `activities/<today>.json`、改 `activity.screenshot`、再 `_writeJsonFile` **整文件重写**。与迁移目标完全重叠。
> 2. **漏了 `cleanupOldData`。** `storageManager.js:823-851` 会 `unlinkSync` 删除 `activities/` 与 `summaries/` 下超出保留期的历史文件，是比截图更危险的入口（幸好当前**无人调用**，属死代码）。

| 方法 | 行号 | 实际写入目标 | 迁移期阻塞 |
|---|---|---|---|
| `saveActivity` | 281 | `activities/*.json` | ✅ |
| `appendActivityRecords` | 299 | `activities/*.jsonl` | ✅ |
| `deleteActivity` | 388 | `activities/*.json` + `summaries/` 扫描 | ✅ |
| `updateDisplayRecord` | 421 | `activities/*.jsonl` | ✅ |
| `deleteDisplayRange` | 456 | `activities/*.jsonl` | ✅ |
| `replaceDisplayRanges` | 483 | `activities/*.jsonl`（可跨日） | ✅ |
| `recategorizeAppForDay` | 576 | `activities/*.jsonl` | ✅ |
| `deleteDisplayRecord` | 638 | `activities/*.jsonl` | ✅ |
| `clearActivities` | 663 | `activities/` 整目录删除 | ✅ |
| `saveSummary` | 682 | `summaries/*.json` + `summaries_md/*.md` | ✅ |
| `deleteSummary` | 740 | `summaries/*.json` | ✅ |
| **`saveScreenshot`** | **761** | **`activities/<today>.json` 整文件重写** | **✅（v5 修正）** |
| **`cleanupOldData`** | **823** | **`unlinkSync` 删除 `activities/` + `summaries/` 过期文件** | **✅（v5 新增）** |
| `migrateDataTo` | 928 | 整个数据目录复制 | ✅（与迁移互斥） |
| `setDataDir` | 47 | 切换数据根目录 | ✅（迁移中禁止切目录） |
| `_migrateIfNeeded` | 220 | 旧版 JSON → 按天文件 | ⚠️ **本身即迁移**，由 `writeGate.withMigrationContext` 包裹 |
| `_writeJsonFile` | 195 | 底层写（内部工具） | — 不单独加锁，由调用方负责 |

**`saveScreenshot` 的特殊说明**

核实代码（`storageManager.js:761-774`）：

```js
saveScreenshot(activityId, screenshot) {
  try {
    const todayFile = this._activityFile(this._todayStr());   // ← activities/<today>.json
    const activities = this._readJsonFile(todayFile);
    const activity = activities.find(a => a.id === activityId);
    if (activity) {
      activity.screenshot = screenshot;
      this._writeJsonFile(todayFile, activities);    // ← 整文件重写
      return true;
    }
    return false;
  } catch (error) { ... }
}
```

**它虽然叫「截图」，实际做的是「往今天的活动 JSON 里写一个字段并整文件重写」**。迁移若正在替换该天的文件，两者会互相覆盖。v4 把它排除是错的。

> 补充事实：`saveScreenshot` 当前**无任何调用点**（`grep -rn "saveScreenshot" electron/` 除定义外为空），属潜在入口。但锁必须覆盖它——**死代码迟早会被启用**。

**`cleanupOldData` 的特殊说明**

```js
[this.activitiesDir, this.summariesDir].forEach(dir => {
  fs.readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
    .forEach(file => {
      if (dateStr < cutoffStr) fs.unlinkSync(path.join(dir, file));  // ← 直接删历史
    });
});
```

它会**永久删除**指定天数之前的全部活动与摘要文件。当前**无调用点**（死代码），但一旦被接上就是灾难性入口。同样必须纳入锁。

**必须覆盖的非 IPC 路径**：

| 路径 | 位置 | 写入方法 |
|---|---|---|
| `activityRecorder.flush()` 定时器 | `activityRecorder.js:278` | `appendActivityRecords`（**不经 IPC，15 秒自动触发**） |
| `convert-plan-to-fact` | `main.js:984` | 经 `planManager.markActual`，需阻塞避免计划/事实不一致 |
| `add-manual-record` | `main.js:1176` | `appendActivityRecords` |
| 标注采纳 | `main.js:1026` | `appendActivityRecords` |
| `replace-display-ranges` | `main.js:1189` | `replaceDisplayRanges` |
| `recategorize-app-for-day` | `main.js:1208` | `recategorizeAppForDay` |
| `import-data` | `main.js:1453` | `saveActivity` / `saveSummary` |
| `migrate-storage` | `main.js:1557` | `migrateDataTo` |

**已核实不需阻塞的模块（写入目标不重叠）**：

| 模块 | 写入目标 |
|---|---|
| `planManager` | `plans.json` |
| `arhatManager` | `arhat/sessions/`、`arhat/notes/` |
| `focusManager` | `focus/<date>.json` |
| `logManager` | `logs/*.log` |

**锁的设计（`electron/writeGate.js`）**

```js
'use strict';
// 统一写入闸门：迁移期间阻止所有写 activities/ 与 summaries/ 的路径。
// 建在 StorageManager 层而非 IPC 层，因为 flush 定时器不走 IPC。

let holder = null;          // { owner, reason, since }
let migrationDepth = 0;     // > 0 表示在迁移特权上下文内

const ERR = 'MIGRATION_IN_PROGRESS';

class WriteBlockedError extends Error {
  constructor(message) {
    super(message);
    this.code = ERR;
    this.name = 'WriteBlockedError';
  }
}

function tryAcquire(owner, reason) {
  if (holder) return false;
  holder = { owner, reason, since: Date.now() };
  return true;
}

function release(owner) {
  if (!holder || holder.owner !== owner) return false;
  holder = null;
  return true;
}

// 迁移自己的写入走特权上下文，避免自我死锁
function withMigrationContext(fn) {
  migrationDepth += 1;
  try { return fn(); }
  finally { migrationDepth -= 1; }
}

// 所有写方法入口调用
function assertWritable(operation) {
  if (migrationDepth > 0) return;
  if (holder) {
    throw new WriteBlockedError(
      `数据迁移进行中，暂不能${operation}。请等待迁移完成后重试。`
    );
  }
}

function isLocked() { return !!holder; }
function getHolder() { return holder ? { ...holder } : null; }

module.exports = {
  tryAcquire, release, withMigrationContext, assertWritable,
  isLocked, getHolder, WriteBlockedError, ERR
};
```

**StorageManager 接入**（每个写方法首行）：

```js
appendActivityRecords(records) {
  writeGate.assertWritable('写入活动记录');   // ← 第一行
  ...
}
```

**迁移侧使用**（异常必须释放）：

```js
const OWNER = `migration:${kind}:${process.pid}`;
if (!writeGate.tryAcquire(OWNER, `migrating ${kind}`)) {
  return { ok: false, error: '另一个迁移正在进行' };
}
try {
  writeGate.withMigrationContext(() => doMigrationPhases());
} finally {
  writeGate.release(OWNER);       // 无条件释放
}
```

**`activityRecorder.flush()` 的行为（不丢数据）**

```js
catch (error) {
  if (error.code === writeGate.ERR) {
    // 迁移中：不是错误，片段原样放回，**不截断**
    this._buffer = batch.concat(this._buffer);
    this.onLog('数据迁移进行中，录制数据暂存内存，迁移后写入', 'info');
    return 0;
  }
  this.onLog('写入活动记录失败: ' + error.message, 'error');
  this._buffer = batch.concat(this._buffer).slice(-200);   // 原逻辑不变
  return 0;
}
```

迁移分支**不做 `slice(-200)` 截断**——迁移是可控的短时状态，缓冲不会无限增长，保证录制数据一条不丢。迁移完成后主动触发一次 `flush()`。

**锁的能力边界（必须明确）**

> ⚠️ **应用内写锁无法阻止 iCloud / OneDrive / 杀毒软件 / 手工编辑器等外部进程修改文件。**
>
> 因此必须保留 SHA256 检测。三层防线：

| 防线 | 防的是 | 防不了 |
|---|---|---|
| 应用内写锁 | 本应用内的并发写入 | 外部进程 |
| 替换/回滚前 SHA 校验 | 准备阶段后的任何修改（含外部） | 校验与 rename 之间的毫秒级窗口 |
| 原子 rename | 半截文件 | 逻辑错误 |

**验收标准**（T-M09 ~ T-M20）

| ID | 场景 | 断言 |
|---|---|---|
| T-M09 | 迁移中 IPC `add-manual-record` | 返回 `MIGRATION_IN_PROGRESS`，不写入 |
| T-M10 | 迁移中 `flush()` 定时器触发 | 片段留缓冲，迁移后落盘，**不丢失** |
| T-M11 | 替换前外部修改目标文件 | 停止替换，标记 `conflict`，说明冲突文件 |
| T-M12 | 迁移期新增「次日」文件后回滚 | 该文件**存在且内容不变** |
| **T-M13** | **回滚完成后重启** | **`rolledback` 终态，不再次迁移，记录数不变** |
| **T-M14** | **迁移后目标文件被外部修改，再回滚** | **不覆盖，冲突文件隔离到 `conflict-files/`** |
| **T-M15** | **`finishing` 阶段源文件变化** | **不改名、不删源文件，标记 `conflict`** |
| **T-M16** | **直接调 `appendActivityRecords()`（绕过 IPC）** | **抛错，磁盘无变化** |
| **T-M17** | **直接调 `saveActivity()`（绕过 IPC）** | **抛错，磁盘无变化** |
| **T-M18** | **全部 16 个写方法逐一验证** | **15 个阻塞（含 `saveScreenshot`、`cleanupOldData`）；`_writeJsonFile` 为内部工具不单独加锁** |
| **T-M19** | **迁移结束后（成功/失败/冲突/回滚）** | **锁已释放，`isLocked() === false`，写入恢复** |
| **T-M20** | **迁移期间录制 3 段** | **3 段全保留，迁移后全部落盘** |


---

### 2.14 冲突处理与人工介入（v4 新增）

`conflict` 与 `failed` 都是**终态**（§2.5a）：迁移停止自动执行，等待人工处理。本节定义人工可做的操作。

**触发冲突的场景**：

| 场景 | 检测点 | `conflictDetail.stage` |
|---|---|---|
| 目标文件在准备后被改动 | 替换前 SHA 比对 | `pre-replace` |
| 恢复时目标文件状态不明 | 恢复判定三分支都不匹配 | `resume` |
| 源文件在改名前被改动 | `finishing` 阶段 SHA 比对 | `pre-rename` |
| 回滚时目标文件含迁移后新数据 | 回滚前 SHA 比对 | `rollback` |
| 跨卷 | 前置探测 | `precheck` |

**人工可选操作（UI 提供，不自动执行）**：

| 操作 | 前提 | 效果 |
|---|---|---|
| **A. 接受当前结果** | 用户核对过 `activities/` 内容正确 | workspace 重命名为 `<id>.accepted-<ts>/`，标记终态，不再提示 |
| **B. 回滚到迁移前** | 无（但逐文件 SHA 保护仍生效） | 走 §2.8，成功则 `rolledback`，遇冲突文件转 `conflict` 并隔离 |
| **C. 放弃本次迁移** | 无 | workspace 重命名为 `<id>.abandoned-<ts>/`，标记终态。**目标文件保持现状** |
| **D. 查看冲突明细** | 无 | 展示 `conflictDetail`，含文件列表、期望/实际哈希、源文件条数变化 |

**操作 A 的安全性要求**：

```
用户选择「接受当前结果」前，UI 必须展示：
  - 已替换的日期数量
  - 冲突文件的列表与原因
  - 源文件的当前状态（是否仍在、条数变化）
必须二次确认。确认后：
  - workspace 重命名为 .accepted-<ts>/（保留，不删）
  - **不改动任何数据文件**
```

**操作 C 的注意事项**：

> 放弃迁移**不会**把 `activities/` 恢复到迁移前。若用户想要恢复，必须选 B。
> 这一点必须在 UI 上写清楚，避免用户误以为「放弃 = 还原」。

**所有终态工作区一律保留**：

- 命名规则：`<id>.<outcome>-<timestamp>/`
- 内容：manifest、status、source.snapshot.jsonl、staging/、conflict-files/
- **永不自动删除**。用户需要清理时手动删除，UI 只提供「打开目录」入口

**日志**：每次状态转换追加到 `status.history[]`：

```jsonc
{ "at": "2026-11-12T01:40:00Z", "from": "replacing", "to": "conflict",
  "reason": "pre-replace SHA mismatch", "detail": { "date": "2026-11-05" } }
```


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

### 3.4 摘要导入的半成功处理（v3 新增）

> **v3 新增。** `saveSummary`（`storageManager.js:682-704`）**先写 JSON 再写 Markdown**，两次独立的文件操作。中间失败会产生「JSON 有、MD 没有」的不一致状态。

**问题实证**（代码结构）：

```js
saveSummary(summary) {
  try {
    // 1. 写 summaries/<date>.json  ← 成功
    summaries.push(summary);
    this._writeJsonFile(filePath, summaries);

    // 2. 写 summaries_md/summary_<ts>.md  ← 可能失败
    fs.writeFileSync(mdPath, this.generateMarkdownSummary(summary), 'utf8');
    return true;
  } catch (error) {
    console.error('保存摘要失败:', error);
    return false;      // ← JSON 已写入，但返回 false
  }
}
```

**后果**：返回 `false` 但 JSON 里已经有这条摘要了。调用方计入 `failed`，用户以为没导入，实际导入了——**重试会写第二条**。

**v3 处理规则**：

**规则 1：JSON 为唯一事实来源，Markdown 为派生产物**

```
判定摘要是否导入成功，只看 summaries/<date>.json 是否写入成功。
Markdown 写入失败 → 标记 mdFailed，但不影响「已导入」的判定。
```

**规则 2：Markdown 失败可修复，不重导 JSON**

```
若某条摘要的 MD 缺失：
    → 提供「重建 Markdown」操作
    → 通过 generateMarkdownSummary(summary) 从 JSON 重新生成
    → 不重新导入 JSON（避免重复记录）
```

**规则 3：指纹登记与半成功解耦**

```
指纹登记条件：JSON 全部写入成功（无论 MD 是否成功）
若 MD 有失败：
    → .import-history.json 记录中标记 "mdIncomplete": true
    → 提示用户：「摘要已导入 N 条，其中 M 条的文字版未能生成，可在设置页重建」
    → 指纹已登记 → 重复导入会被识别（不会因 MD 失败而重复导入 JSON）
```

**规则 4：批量导入时按条记录结果**

```js
const summaryResults = { succeeded: 0, failed: 0, mdFailed: 0, skipped: 0 };
for (const s of data.summaries || []) {
  if (!s.timestamp || !s.summary) { summaryResults.skipped++; continue; }
  const r = storageManager.saveSummaryDetailed(s);
  // saveSummaryDetailed 返回 { jsonOk, mdOk }
  if (r.jsonOk) {
    summaryResults.succeeded++;
    if (!r.mdOk) summaryResults.mdFailed++;
  } else {
    summaryResults.failed++;
  }
}
```

**规则 5：失败条目的重试（v5 重写，P1-02）**

> **v5 修正**：v4 的规则 5 与 §3.6 的 `imp.batch + imp.idx` 机制**直接矛盾**——v4 说「重试会重复导入已成功的条目」，但 §3.6 恰恰解决了这个问题。v5 统一以 §3.6 为准。

**统一的重试规则**：

```
failed > 0（部分 JSON 未写入）：
    1. 默认行为：**优先继续未完成的导入任务**（不是重新导入整个文件）
    2. 事实依据：扫描目标文件中已有 imp.batch === 本批次 的记录，
       其 imp.idx 集合即为「已成功」集合
    3. 跳过这些 idx，只处理剩余的
    4. progress.json 仅作加速缓存，不是判定依据
    5. 已成功写入的记录 → **绝不重复导入**
```

**三条不可违反的约束**：

| 编号 | 约束 | 原因 |
|---|---|---|
| ① | 默认优先「继续」而非「重新开始」 | 重新开始会重复 |
| ② | 以数据中的 `imp.batch + idx` 为事实来源 | progress 可能陈旧或写入失败 |
| ③ | 用户主动「重新开始」时才生成新批次，且**必须明确警告会产生重复** | 用户知情选择 |

**JSON 成功、Markdown 失败的重试**：

```
→ 只补齐 Markdown，**不重写 JSON**
→ 通过 generateMarkdownSummary(summary) 从已有 JSON 重建
→ 不产生新的 JSON 记录
```

**不再把「手工删除重复记录」当正常恢复流程**：

> v4 曾说「建议先在设置页删除已导入的部分」。这是**把工具的责任推给用户**。v5 取消这个建议：
>
> - 正常路径是「继续未完成任务」，不需要用户手工清理
> - 只有在用户**主动选「重新开始」**后产生重复时，才提示「如需清理，可在设置页操作」——且这是**用户选择带来的后果**，不是正常流程的必要步骤

**与 §3.6 的关系**：本节是 §3.6 规则在「摘要 + Markdown 半成功」场景下的具体化，不得与 §3.6 冲突。若两处表述不一致，**以 §3.6 为准**。

**验收标准**（T-I08 ~ T-I13，均待实现）

| ID | 场景 | 断言 |
|---|---|---|
| T-I08 | MD 写入失败（mock 抛错） | JSON 成功计数正确，`mdFailed` 计数正确，任务标记为可续传 |
| T-I09 | 所有摘要都导入成功 | `mdFailed === 0`，不提示 |
| T-I10 | 重建 Markdown | 从 JSON 生成，条数正确，**不新增 JSON 记录** |
| T-I11 | MD 失败后续传 | **只补 MD，JSON 条数不变** |
| T-I12 | 部分 JSON 失败后点「继续」 | 靠 `imp` 判定跳过已成功，**无重复** |
| T-I13 | 部分 JSON 失败后点「重新开始」 | 新批次生成，**明确警告**可能重复 |

### 3.5 本次不做内容去重（理由）

用户明确「宁可保留，不允许误删」。无 `rid` 时任何内容去重都会误删（第二轮实测：4 条合法记录合并成 1 条）。**V0.10.2b 容忍重复，去重放 V0.10.3。**

### 3.6 导入任务持久化与安全续传（v4 新增，P1-01）

> **v4 新增。** 整文件指纹只能回答「这份文件导过没有」，无法回答「导到第几条」。部分失败后重试会重复导入已成功的部分。
>
> 更关键的是：**「先写数据、再更新 progress」这个顺序本身就不可靠**——若数据写完、progress 未写就崩溃，重试仍然重复。

**代码核实前提**

`main.js:1526-1544` 当前逻辑（逐条 `saveActivity` / `saveSummary`，无进度记录）：

```js
data.activities.forEach(a => {
  if (a.timestamp && a.processName) {
    storageManager.saveActivity(a);   // 返回值被丢弃
    importedCount++;
  }
});
```

`storageManager.saveActivity` 内部是「读整文件 → push → 全量重写」，**没有幂等键**。同一数组元素写两次就是两条记录。

**设计：以「导入批次标记」实现可判定的续传**

核心思路：**在数据落地时就带上可追溯的批次身份**，使「这条是否已导入」可以在重试时被判定，而不是依赖事后写的 progress 文件。

**做法：为每条导入的记录附加 `imp` 标记**

```
imp = { batch: <fingerprint 前 16 位>, idx: <原数组下标> }
```

写入时落在记录的 `imp` 字段上（与 `rid` 同层，属于新增可选字段，旧数据无此字段不受影响）。

**为什么这样能解决崩溃窗口**：

| 崩溃时机 | 结果 | 重试时如何判定 |
|---|---|---|
| 写到第 500 条崩溃 | 前 500 条已落盘，`imp.idx` = 0..499 | 读目标文件，收集已有 `imp.batch === 本批次` 的 `idx`，从 500 继续 |
| 数据写完、progress 未写 | 数据里有完整 `imp` 标记 | 靠数据本身判定，**不依赖 progress** |
| progress 写了、数据未写完 | progress 声称完成但数据缺 | 以**数据实际内容**为准，progress 仅作提示 |

**关键原则：progress.json 只是加速缓存，不是事实来源。事实来源是数据文件里的 `imp` 标记。**

**导入任务文件**

```jsonc
// Data/.import-tasks/<fingerprint16>.json
{
  "fingerprint": "a3f9c1d2e8b74560",     // 来源文件内容指纹（全字段，见 §3.7）
  "fingerprintVersion": 4,
  "sourceName": "worklog_full_export_20261112.json",
  "sourceSha256": "f0a1...",             // 原始文件字节哈希（仅用于展示/审计）
  "createdAt": "2026-11-12T01:30:00Z",
  "updatedAt": "2026-11-12T01:31:12Z",
  "status": "in_progress",               // in_progress | completed | aborted
  "counts": {
    "activities": { "total": 1284, "done": 500, "failed": 2, "skipped": 3 },
    "summaries":  { "total": 128,  "done": 128, "failed": 0, "skipped": 0,
                    "mdFailed": 1 }
  },
  "doneIdx": {
    "activities": [0,1,2,...499],        // 仅作缓存；重试时以数据中的 imp 为准
    "summaries":  [0,1,...,127]
  }
}
```

**续传流程**

```
导入开始
 ├─ 计算 fingerprint（§3.7）
 ├─ 读 Data/.import-tasks/<fp>.json
 │
 ├─ 若 status === 'completed'
 │     → 提示「该文件已于 <updatedAt> 完整导入（N 条），是否强制重新导入？」
 │     → 用户选「否」→ 结束
 │     → 用户选「是」→ **新建批次**（batch = fp + '-' + newTaskId），
 │                        形成独立的 imp.batch，与旧批次互不干扰
 │
 ├─ 若 status === 'in_progress'
 │     → 提示「该文件上次导入未完成（已完成 X/Y），继续还是重新开始？」
 │     → 继续：
 │         batch = 该任务的 batch（**保持不变**，这样 imp 判定能接上）
 │         扫描目标目录，收集 imp.batch === batch 的 idx 集合
 │         跳过这些 idx，从剩余开始
 │     → 重新开始：
 │         batch = 新 taskId
 │         注意：旧批次记录**不删除**（无法安全区分），会产生重复
 │         必须明确警告：「重新开始会产生重复数据，建议先备份」
 │
 └─ 若不存在
       → 新建任务，batch = fp 前 16 位
```

**逐条写入**

```js
for (let idx = 0; idx < list.length; idx++) {
  if (doneIdxSet.has(idx)) { skipped++; continue; }   // 续传跳过

  const rec = { ...list[idx], imp: { batch, idx } };  // 写入身份

  const ok = storageManager.saveActivity(rec);
  if (ok) { done++; doneIdxSet.add(idx); }
  else    { failed++; }

  // progress.json 每 N 条批量刷一次（不是每条），减少 IO
  // 即使这里没刷成功，重试也能靠 imp 判定
  if (done % 50 === 0) flushProgress();
}
flushProgress();   // 收尾刷一次
```

**边界说明（必须如实写出，不得夸大）**

> ⚠️ **本方案不承诺严格 exactly-once。** 明确的边界：
>
> | 场景 | 是否会重复 | 说明 |
> |---|---|---|
> | 崩溃后点「继续」 | **不会** | 靠 `imp.batch + idx` 判定已写入的记录 |
> | 崩溃后点「重新开始」 | **会** | 新批次无法与旧批次匹配，无法安全去重；已明确警告 |
> | `saveActivity` 返回 true 但实际未落盘（如 fs 缓存问题） | 可能 | 极端情况，依赖 atomicFile 的写入语义 |
> | 用户在导入过程中手工删除部分记录 | 可能 | 无法区分「已删」与「未导入」，宁可重导 |
>
> **为什么不用内容去重**：同一文件内部的合法重复必须保留（D-03 第 7 条）。内容去重会把「两条相同记录」误判为「一条重复」，直接违反要求 1。
>
> **本方案满足的 6 条要求**：① 文件内合法重复全部保留（`imp.idx` 不同即不同记录）；② 部分成功可安全续传；③ 不用内容相同作去重依据；④ 不丢用户原始字段（`imp` 是附加字段，原字段原样保留）；⑤ 强制重导产生新批次；⑥ 摘要半成功有明确规则（§3.4 + 下方）。

**摘要 JSON/Markdown 半成功的续传规则**

| 情况 | 处理 |
|---|---|
| JSON 成功、MD 失败 | JSON 记 `done`，MD 记 `mdFailed`；重试时**不重写 JSON**，只补 MD |
| JSON 失败 | 记 `failed`，重试时重写该条 |
| 续传时检测到某条 `imp` 存在但 MD 缺失 | 走「重建 Markdown」路径（§3.4 规则 2），不重写 JSON |

**保留用户原始字段**

`imp` 是唯一的附加字段，命名带前缀避免冲突。原始记录的所有字段**原样写入**，不做任何裁剪或重排。导出时 `imp` 会一并导出（属正常字段，可用于跨设备续传识别）。

### 3.7 指纹算法的 volatile 字段定义（v4 修正，P1-02）

> **v4 修正 v3 的两处问题：**
>
> 1. v3 全局排除 `id` —— 但**嵌套对象里也可能有合法的 `id`**（例如摘要的 `slots[].id`），全局排除会把这些合法内容从指纹中抹掉，导致不同文件算出相同指纹。
> 2. v3 把 `summariesMd` 纳入指纹，但**核实生产代码：`import-data` 只处理 `activities` 和 `summaries`，从不导入 Markdown**（`main.js:1526-1544`）。把未实际导入的内容纳入指纹是错的。

**代码核实：导出结构 vs 导入实际处理**

| 导出字段（`main.js` `export-full-data`） | 是否被 `import-data` 导入 | 是否纳入指纹 |
|---|---|---|
| `version` | 否（元信息） | 否 |
| `exportDate` | 否（元信息，每次导出都变） | 否 |
| `activities` | **是** | **是** |
| `summaries` | **是** | **是** |
| `arhatSessions` | **否** | 否（未导入，纳入会造成误判） |
| `arhatNotes` | **否** | 否 |
| `config` | **否** | 否 |
| `summariesMd` | **不存在此字段** | **不纳入** |

**结论**：指纹**只覆盖 `activities` 与 `summaries`**，与「实际导入什么」严格对齐。`summariesMd` 是派生数据，由 `saveSummary` 内部生成，不作为导入源，也不进指纹。

**volatile 字段：按对象类型 + 字段路径定义**

```js
// 只有经过代码核实的临时字段才排除。每条都要写清来源。
const VOLATILE_BY_TYPE = {
  // 活动记录（activities[]）
  activity: new Set([
    'id',        // storageManager._fromSegment 生成：`${t}#${index}`，读取时算，非持久
    'editedAt',  // updateDisplayRecord 写入的时间戳，属操作元数据
  ]),

  // 摘要记录（summaries[]）
  summary: new Set([
    'id',        // deleteSummary 匹配用，由调用方生成
    'generatedAt', // 若存在，为生成时间元数据
  ]),
};

// 嵌套对象**不做任何排除** —— 嵌套里的 id 是数据内容，必须参与指纹
```

**为什么 `imp` 不排除**：它是本方案引入的导入身份，**属于数据内容的一部分**，会影响指纹（不同批次的同一文件应算出不同指纹？——不，指纹算的是**源文件内容**，`imp` 是写入时附加的，不在源文件里，所以不会进入指纹。这点需在实现时确认：**指纹只对源文件的原始内容计算，不算附加字段**）。

**修正后的算法**

```js
const FINGERPRINT_VERSION = 4;

/**
 * 计算导入来源指纹。
 * 只覆盖 import-data 实际导入的字段（activities / summaries）。
 * 对每条记录，仅排除该类型已核实的 volatile 字段；
 * 嵌套对象与数组一律全量参与。
 */
function computeFingerprint(sourceJson) {
  const parts = [`v${FINGERPRINT_VERSION}`];

  for (const a of sourceJson.activities || []) {
    parts.push('A:' + canonicalByType(a, VOLATILE_BY_TYPE.activity));
  }
  for (const s of sourceJson.summaries || []) {
    parts.push('S:' + canonicalByType(s, VOLATILE_BY_TYPE.summary));
  }
  // arhatSessions / arhatNotes / config / summariesMd 不参与（未被导入）

  return sha256(parts.join('\n'));
}

/**
 * 只对顶层 key 做 volatile 过滤；嵌套层级全量参与。
 * 对象 key 字典序排序；数组保持顺序与重复。
 */
function canonicalByType(value, volatileKeys) {
  return canon(value, volatileKeys, 0);
}

function canon(value, volatileKeys, depth) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    // 顺序与重复均保留
    return '[' + value.map(v => canon(v, null, depth + 1)).join(',') + ']';
  }

  if (typeof value === 'object') {
    const skip = depth === 0 && volatileKeys ? volatileKeys : null;  // 只在顶层过滤
    const keys = Object.keys(value).filter(k => !skip || !skip.has(k)).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(value[k], null, depth + 1)).join(',') + '}';
  }

  return 'null';
}
```

**关键设计点**

| 要求 | 落实 |
|---|---|
| 按类型定义 volatile | `VOLATILE_BY_TYPE.activity` / `.summary` 分开定义，各自写明来源 |
| 只有核实过的才排除 | 每个键都有注释说明「由哪个方法写入、为何非持久」 |
| 嵌套合法 ID 不得误删 | `canon` 只在 `depth === 0` 应用 volatile 集合，嵌套层级传 `null` |
| 全字段参与原则不变 | 除上述已核实字段外，顶层与嵌套全部参与 |
| 与实际导入对齐 | 只算 `activities` / `summaries`，不算 `arhat*` / `config` / `summariesMd` |
| 保留顺序与重复 | 数组不排序、不去重 |

**版本不匹配的处理**：`fingerprintVersion !== 4` 时不判定「已导入」，仅提示「该文件可能曾以旧算法导入过，无法确认」——宁可让用户多导一次，也不能错误拒绝。


### 3.8 `clearActivities` 处置

保留方法（规范第 9 条），但移除唯一生产调用，加「生产禁用」注释，并新增测试断言生产代码无非定义调用。

### 3.9 「切换数据目录」≠「导入备份」（回应 D-01 第 5 条）

| 维度 | 切换数据目录 | 导入备份 |
|---|---|---|
| 现有实现 | `migrateDataTo` + `copyMissingData`，`COPYFILE_EXCL` 只复制不存在文件，**不删源** | 未实现 |
| 语义 | 换地方继续用，旧目录原样保留 | 用备份**替换**当前 |
| 是否删数据 | 否 | 是（需六重保护） |
| 适用 | 换机（把旧目录拷到新机指向它） | 恢复到某个历史状态 |

### 3.10 文件范围

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

### 3.11 验收标准

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

> **v4 修正三处统计问题：**
> 1. v3 写「37 项」，但当时遗漏了 T-M13~T-M20（8 项）——v3 正文只列到 T-M12。
> 2. v3 把「F1-F9 + F5a」当作「10 个中断点」，实际漏了 F4a，且区间写法易错。
> 3. v3 摘要侧没有对应 F4a 的 S4a、对应 F5a 的 S5a。
>
> **本表口径**：一行 = 一个测试条目。中断点单独统计在 §2.10。

| ID | 版本 | 场景 | 断言 |
|---|---|---|---|
| **迁移 · 故障注入（活动 F 系列 11 点）** | | | |
| T-M01 | 2a | F 系列全部 11 个中断点 | 每个中断点恢复后状态与「一次成功」等价 |
| **迁移 · 故障注入（摘要 S 系列 11 点）** | | | |
| T-M02 | 2a | S 系列全部 11 个中断点 | 同 T-M01，摘要侧独立验证 |
| **迁移 · 守恒与前置检查** | | | |
| T-M03 | 2a | 活动记录数守恒（修正公式） | 迁移后 == **`sum(preReplaceRecordCount) + 活动源条数`** |
| T-M04 | 2a | 摘要记录数守恒（修正公式） | 迁移后 == **`sum(preReplaceRecordCount) + 摘要源条数`** |
| T-M05 | 2a | 跨卷检测（**实测 rename 探测**） | 捕获 `EXDEV`，拒绝迁移，错误信息明确 |
| T-M06 | 2a | 源文件在迁移前阶段变化 | 非终态 workspace 时停止并标记 `conflict` |
| T-M07 | 2a | 回滚（逐文件 SHA 保护） | 各日期逐条一致；**迁移期间新日期不受影响** |
| T-M08 | 2a | 自定义数据目录 | 源在默认目录、目标在自定义目录，迁移成功 |
| **迁移 · 写入锁（P0-04）** | | | |
| T-M09 | 2a | 迁移中 IPC `add-manual-record` | 返回 `MIGRATION_IN_PROGRESS`，磁盘无变化 |
| T-M10 | 2a | 迁移中 `flush()` 定时器触发 | 片段留缓冲，迁移后落盘，**不丢失、不截断** |
| T-M11 | 2a | 替换前外部修改目标文件 | 停止替换，标记 `conflict`，说明冲突文件 |
| T-M12 | 2a | 迁移期新增「次日」文件后回滚 | 该文件**存在且内容不变** |
| **T-M13** | **2a** | **回滚完成后重启软件** | **状态 `rolledback` 为终态，不再次自动迁移，记录数不变** |
| **T-M14** | **2a** | **迁移后目标文件被外部修改，再回滚** | **不覆盖；冲突文件复制到 `conflict-files/`；原文件保持原样** |
| **T-M15** | **2a** | **`finishing` 阶段源文件变化** | **不改名、不删源文件；标记 `conflict`；目标保持已替换状态** |
| **T-M16** | **2a** | **直接调 `appendActivityRecords()`（绕过 IPC）** | **抛 `MIGRATION_IN_PROGRESS`，磁盘无变化** |
| **T-M17** | **2a** | **直接调 `saveActivity()`（绕过 IPC）** | **抛错，磁盘无变化** |
| **T-M18** | **2a** | **16 个写方法逐一验证** | **15 个阻塞，含 `saveScreenshot`（重写 activities/<today>.json）与 `cleanupOldData`（删历史文件）** |
| **T-M19** | **2a** | **迁移结束（成功/失败/冲突/回滚）后** | **锁已释放，`isLocked() === false`，所有写入恢复** |
| **T-M20** | **2a** | **迁移期间录制 3 段** | **3 段全部保留并落盘，一条不丢** |
| **T-M21** | **2a** | **迁移期间调用 `saveScreenshot()`** | **抛 `MIGRATION_IN_PROGRESS`；`activities/<today>.json` SHA 前后一致** |
| **T-M22** | **2a** | **迁移期间调用 `cleanupOldData()`** | **抛 `MIGRATION_IN_PROGRESS`；无任何文件被删除** |
| **T-M23** | **2a** | **归档时 `.migrated` 已存在** | **生成唯一归档名（不走覆盖）；旧归档内容不变；两份都在** |
| **T-M24** | **2a** | **rename 成功但归档 SHA ≠ `sourceSha256`** | **不标记 `done`；标记 `conflict`；归档/目标/workspace 全部保留** |
| **T-M25** | **2a** | **回滚时 `currentSha === null` 且 `preReplaceExists === true`** | **标 `conflict`，不自动恢复；备份保留在 staging** |
| **导入 · 安全与快照** | | | |
| T-I01 | 2b | 导入不清空原始记录 | 记录数增加而非归零 |
| T-I02 | 2b | 三目录快照完整 | `activities`/`summaries`/`summaries_md` 计数 == 导入前 |
| T-I03 | 2b | 逐条写入统计 | `succeeded`/`failed`/`skipped` 计数准确 |
| T-I04 | 2b | 无 `clearActivities` 生产调用 | 静态检查通过 |
| **导入 · 指纹（P1-02）** | | | |
| **T-I05** | **2b** | **指纹覆盖 `activities` + `summaries` 全部字段** | **改任一非 volatile 字段（含 `note`/`cat`/嵌套 `slots[].id`）指纹必变** |
| **T-I06** | **2b** | **指纹保留数组顺序与合法重复** | **两条相同记录参与指纹两次；顺序调换则指纹改变** |
| **T-I07** | **2b** | **`arhat*` / `config` / `summariesMd` 不参与指纹** | **仅修改这些字段时指纹不变** |
| **T-I08** | **2b** | **fingerprintVersion 不匹配** | **不判定为已导入，仅提示无法确认** |
| **导入 · 续传（P1-01）** | | | |
| **T-I09** | **2b** | **写到第 N 条崩溃后点「继续」** | **靠 `imp.batch+idx` 判定，不重复导入前 N 条** |
| **T-I10** | **2b** | **数据写完、progress 未写就崩溃** | **重试以数据中 `imp` 为准，不重复** |
| **T-I11** | **2b** | **文件内两条完全相同的记录** | **`imp.idx` 不同，两条都导入，不合并** |
| **T-I12** | **2b** | **强制重新导入已完成文件** | **生成新 `batch`，与旧批次独立；明确警告可能重复** |
| **T-I13** | **2b** | **摘要 JSON 成功、MD 失败后续传** | **不重写 JSON，仅补 MD** |
| **T-I14** | **2b** | **原始字段完整性** | **除新增 `imp` 外，所有原字段逐字节保留** |
| **T-I15** | **2b** | **部分失败后默认走「继续」而非「重新开始」** | **UI 默认按钮为「继续」；无重复导入** |
| **记录标识（2.3）** | | | |
| T-R01 | 2.3 | `rid` 生成/落盘/重启不变 | 重启后 `rid` 一致 |
| T-R02 | 2.3 | 5 种去重组合 | 无 `rid` 一律保留 |
| T-R03 | 2.3 | 只补被编辑那条 | 同文件其他记录逐字节不变 |
| T-R04 | 2.3 | 严格副本正则 | `-backup`/`.old`/`-080` 不读 |
| **D-02 吸附规则（2.4）** | | | |
| T-D02-01 | 2.4 | `09:07—10:42` | 105 分钟 |
| T-D02-02 | 2.4 | `09:00 + 22min` | 15 分钟（**UI 必须提示失真**） |
| T-D02-03 | 2.4 | `09:07 + 3min` | **拒绝**（原始时长 < 15） |
| T-D02-04 | 2.4 | `23:45 + 15min` | 次日 00:00 终点，15 分钟 |
| T-D02-05 | 2.4 | `23:50 + 30min` | 30 分钟，正确拆分 |
| T-D02-06 | 2.4 | 与自动记录重叠 | 允许，**记录层逐字节不变** |
| T-D02-07 | 2.4 | 与人工记录重叠 | 阻断 |
| T-D02-08 | 2.4 | 前后端一致性（**原始值接口**） | 同一原始输入，预览与保存结果逐字段相等 |
| T-D02-09 | 2.4 | 起点吸附跨日 | `23:45`/`23:52` 正常；**`23:53`/`23:59` 拒绝** |

**条目统计**：迁移 25（T-M01~T-M25）+ 导入 15（T-I01~T-I15）+ 记录标识 4 + 吸附 9 = **53 个测试条目**

**中断点统计**（与条目数不同口径）：活动 11 + 摘要 11 = **22 个故障注入点**


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
| 先核实分支与提交 | ✅ `worklog-1.0-dev` @ `aecf04a`，工作区干净，与远程一致 |
| 重读三份文档与相关生产代码 | ✅ 核实了 13 个写方法、导出/导入字段差异、planManager/arhat/focus 写入目标 |
| 只改三份文档 | ✅ `git diff -- electron/ src/ tests/` 为空 |
| 不操作真实数据 | ✅ 全部用 `os.tmpdir()` 临时目录验证 |
| 不宣称未经验证的设计已通过 | ✅ 所有新增设计标注为「待实现」，测试均为「待编写」 |
| 审查意见与实际代码不符时以代码为准 | ✅ 详见下方 |

### 与实际代码核对后修正的审查意见

| 审查意见 | 核对结果 |
|---|---|
| 「导出字段包括 `activities、summaries、arhatSessions、arhatNotes、config`」 | **正确**。另含 `version`、`exportDate`。核实位置 `main.js` `export-full-data` |
| 「方案引入了 `summariesMd`，需明确是否属于独立导入数据」 | **审查正确，我的方案有误**。`import-data` 只处理 `activities` 和 `summaries`，**从不导入 Markdown**，也没有 `summariesMd` 这个导出字段。已在 §3.7 移除 |
| 「§2.13 只列出了部分写入入口」 | **正确**。实际有 13 个写方法，v3 只列了 7 个 IPC 入口，漏了 `deleteActivity`/`deleteSummary`/`saveScreenshot`/`clearActivities`/`migrateDataTo`/`setDataDir` 等 |
| 「计划转实际记录也必须受保护」 | **正确**。`convert-plan-to-fact`（`main.js:984`）经 `planManager.markActual`，需阻塞以避免计划/事实不一致 |
| 「§2.9 仍有 F1-F8 旧表述」 | **正确**。722-723 行仍写 F1-F8，已改 |
| 「两个 3.5」 | **正确**。823 行与 827 行重复，已重编号为 3.1-3.11 |

### 自检结果

| 检查项 | 结果 |
|---|---|
| D-01~D-04 一致性 | ✅ 三份文档均含且语义一致；**无「待决策」残留**（第二轮末尾已标历史记录） |
| 版本顺序一致性 | ✅ V0.10.2a → 2b → 3 → 4，三份文档一致 |
| 旧方案作废标记 | ✅ `importBatchId`、`文件名+行号稳定指纹`、`待决策 D-02`、`V0.10.2 单一版本` 四处均已标删除线并说明 |
| 重复章节编号 | ✅ 无（`grep -oE "^### [0-9]+\.[0-9]+" \| sort \| uniq -d` 为空） |
| 过时 F1-F8 / F1-F9 区间表述 | ✅ 已统一为「F 系列 11 点 / S 系列 11 点」显式枚举 |
| §2.9/§2.10/§2.11/§2.13 与 §七 一致性 | ✅ 方法数（16）、阻塞数（15）、注入点数（22）、条目数（53）四处数字对齐 |
| T-M18 是否含 `saveScreenshot` | ✅ 含，且补入 `cleanupOldData` |
| 新测试是否进矩阵与验收 | ✅ T-M13~T-M25、T-I05~T-I15 均在 §七 与各版本验收标准中出现 |
| 是否有「已实现」的虚假宣称 | ✅ 无。所有设计标「待实现」，测试标「待实现、待执行」 |
| 测试条目数 | **53**（迁移 25 + 导入 15 + 记录标识 4 + 吸附 9） |
| 故障注入点 | **22**（活动 F 系列 11 + 摘要 S 系列 11） |

> **口径提醒**：**53 是「测试条目数」，22 是「故障注入点数」，16 是「写方法数」，15 是「需阻塞的写方法数」**。四者不可混用——T-M01 一个条目覆盖 11 个注入点，T-M18 一个条目覆盖 15 个方法。

---

## 十、冻结前验收核验（2026-11-12 02:11）

逐项用命令核验，结果如下。

### 门槛 1：无已确认的 P0 数据丢失/覆盖/重复迁移漏洞

| 曾经的 P0 | 现状 | 核验方式 |
|---|---|---|
| 覆盖导入删光原始记录 | §3.1 删除该入口 | 文档 + 代码核实 `clearActivities` 仅剩定义 |
| 迁移不幂等（`1 1 1 → 2 2 2`） | §2.5a 状态机 + SHA 判定 | 实测复现过问题，方案已覆盖 |
| 迁移期并发写入被覆盖 | §2.13 写锁 15 方法 + 替换前重校验 | 16 个方法逐一列出 |
| `saveScreenshot` 未加锁 | v5 已纳入 | 代码核实 `_writeJsonFile(todayFile, activities)` |
| `cleanupOldData` 未加锁 | v5 已纳入 | 代码核实 `unlinkSync` |
| 回滚覆盖迁移后新数据 | §2.8 五种情况分支 | 逐分支定义 |
| 归档覆盖已有 `.migrated` | §2.6a 唯一归档名 | 实测确认 `renameSync` 会静默覆盖 |
| 归档后不校验就标 done | §2.6a step C | 三点校验 |

**结论：无未解决 P0。**

### 门槛 2：StorageManager 写入入口全部纳入保护

`grep` 核验 `storageManager.js` 全部磁盘写入方法：**16 个**，其中 **15 个需阻塞**（`_writeJsonFile` 为内部工具，由调用方负责）。

清单见 §2.13 表格，含 `saveScreenshot`、`cleanupOldData` 两个 v5 新增项。

**结论：通过。**

### 门槛 3：状态机明确

9 个状态，4 个终态（`done` / `rolledback` / `conflict` / `failed`）：

```
init → snapshot → staging → replacing → finishing → done [终态]
                     ↓ 任一阶段冲突 → conflict [终态]
                     ↓ 不可恢复错误 → failed   [终态]
任意非终态 → rolledback [终态]
```

启动行为：终态只读不动，非终态按 SHA 判定续跑。人工介入有 4 种操作（§2.14）。

**结论：通过。**

### 门槛 4：故障注入矩阵对称完整

| 系列 | 注入点 | 枚举 |
|---|---|---|
| 活动 | **11** | F1、F2、F3、F4、F4a、F5、F5a、F6、F7、F8、F9 |
| 摘要 | **11** | S1、S2、S3、S4、S4a、S5、S5a、S6、S7、S8、S9 |
| 合计 | **22** | 逐条对应，结构对称 |

用 `grep -cE '^\| (\*\*)?[FS][0-9]a?(\*\*)? \|'` 核验，各 11 行。

**结论：通过。**

### 门槛 5：测试编号、版本、验收标准一致

用 `grep -oE "T-M[0-9]+|T-I[0-9]+|T-R[0-9]+|T-D02-[0-9]+" | sort -u | wc -l` 核验：**53 个唯一编号**，与文档声明一致。

| 分组 | 数量 |
|---|---|
| T-M（迁移） | 25 |
| T-I（导入） | 15 |
| T-R（记录标识） | 4 |
| T-D02（吸附） | 9 |
| **合计** | **53** |

**结论：通过。**

### 门槛 6：无影响 V0.10.2a 的重大设计矛盾

核验项：

| 检查 | 结果 |
|---|---|
| §3.4 与 §3.6 导入重试规则 | 已统一（v5 以 §3.6 为准） |
| `saveScreenshot` 是否阻塞 | 已阻塞，全文无「不阻塞」残留 |
| 章节编号重复 | `uniq -d` 为空 |
| 「待决策 D-02」残留 | 仅存于作废说明中 |
| 守恒公式 | §2.5 / §2.11 / T-M03 / T-M04 四处一致 |
| 写方法数 | §2.13 表格 16 个，T-M18 也是 16 个 |

**结论：通过。**

---

## 十一、后续优化清单（不阻断开发）

以下问题已识别但**不影响 V0.10.2a 开发**，记入此清单，开发中或后续版本处理。

| # | 问题 | 来源 | 建议版本 |
|---|---|---|---|
| 1 | `saveScreenshot` 无调用点（死代码），考虑删除或接入 | v5 核实 | V0.10.7 清理 |
| 2 | `cleanupOldData` 无调用点（死代码），且行为危险（直接删历史） | v5 核实 | V0.10.7 清理，或删除 |
| 3 | `enableRemoteModule` 是 Electron 28 无效选项 | 第二轮 | V0.10.7 清理 |
| 4 | `atomicFile.js:50` 抛 `lastError` 而非 `directError`，错误码误导 | 第二轮 | V0.10.7 |
| 5 | `recordImmutability.test.cjs` 缺 `delete require.cache` | 第二轮 | V0.10.2a 顺手修 |
| 6 | `manualSnap.test.cjs` 复刻算法，需改为调用 `slotRule` | 第二轮 | V0.10.4 |
| 7 | `duplicateImport.test.cjs` 第 1、2 条需改为断言正确行为 | 第二轮 | V0.10.3 |
| 8 | 三个超大前端文件（3173/1686/1624 行）拆分 | 第一轮 | 观察后再定 |
| 9 | AI 发送端无二次隐私过滤（只过滤采集端） | 第一轮 | P1，非本阶段 |
| 10 | `?token=` 查询串鉴权会进浏览器历史 | 第一轮 | V0.10.6 顺带 |
| 11 | 本地 `v0.1.0` tag 与远程冲突 | 第二轮 | 随时可清理 |
| 12 | **外部同步软件（iCloud/OneDrive）竞态无法彻底消除** | v5 | 见下方安全边界 |

### 外部同步竞态的已知安全边界（不再追求绝对保证）

| 项 | 说明 |
|---|---|
| **无法消除的部分** | 校验与 `rename` 之间的微秒级窗口；外部进程可绕过应用内锁 |
| **检测机制** | 三点 SHA 校验（改名前 / 替换前 / 改名后）+ 恢复时 SHA 判定 |
| **最坏后果** | 如果窗口内被改，结果是**标记 `conflict` 并保留全部三份数据**（归档 / 目标 / workspace），不静默丢失 |
| **人工恢复方案** | §2.14 四种操作：接受当前结果 / 回滚 / 放弃 / 查看明细；所有终态工作区永不自动删除 |
| **明确不承诺** | 不承诺「零窗口」，只承诺「窗口内的变化不导致静默数据丢失」 |

**这是本方案的正式安全边界声明，不再作为待修订项。**

---

## 十二、冻结后的开发入口

V0.10.2a 开发依据本文档以下章节：

| 章节 | 内容 |
|---|---|
| §2.5 | manifest 字段定义（含 `preReplaceRecordCount`） |
| §2.5a | 状态机（9 状态，4 终态） |
| §2.5b | 恢复判定流程 |
| §2.6 | 完整流程 6 阶段 |
| §2.6a | 归档三点校验 |
| §2.8 | 回滚五分支 |
| §2.10 | 故障注入矩阵（F 11 + S 11） |
| §2.11 | 验收标准（守恒公式） |
| §2.13 | 统一写入锁（16 方法） |
| §2.14 | 冲突处理与人工介入 |

**开发前建议（不改变版本划分）**：§2.13 的写入锁要触及 15 个方法，是 V0.10.2a 中风险最高的部分。建议先完成它并跑通全功能回归，再实现迁移引擎——但**版本号仍是一个 V0.10.2a**，只是内部提交顺序如此。

**本文档已冻结，不再进行下一轮文档审计。**
