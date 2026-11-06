# 架构说明

面向「三个月后的自己」写的。目的是：看到某个字段或某段逻辑时，
能立刻知道它属于哪一层、能不能改、改了会影响什么。

---

## 1. 进程与目录

```
Electron 主进程 (electron/)
├── main.js            窗口 / 托盘 / IPC 注册 / 自动启动
├── storageManager.js  活动记录的读写与分层（记录层 vs 标注层）
├── analytics.js       分析管线：原始记录 → 会话 → 15 分钟格
├── configManager.js   配置读写（含旧配置迁移）
├── arhatManager.js    专注会话（arhat = 罗汉模式）
├── summarizer.js      AI 回顾（可选，关闭时完全不调用）
├── logManager.js      运行日志
└── recorder*.js       前台窗口采样

渲染进程 (src/)
├── App.vue            视图切换 / 全局状态 / IPC 事件
├── views/
│   ├── TodayView.vue    今日概览（结论层）
│   ├── TimelineView.vue 时间轴 + 日历（过程层）
│   └── SettingsView.vue 设置（记录 / 外观 / AI / 关于）
└── components/
    ├── SegmentEditor.vue 统一的分段编辑器（贴着块弹出的浮层）
    ├── AiPanel.vue       AI 回顾卡片（三态：未启用/缺 Key/可用）
    └── NavRail.vue       只有 今日 / 时间线 / 设置 三项
```

数据目录（**注意是 `worklog-assistant`，代码里钉死的**）：

```
%APPDATA%/worklog-assistant/
├── config.json          非敏感配置
├── config.local.json    仅 API Key（不进 git）
└── Data/                实际数据（可指向 iCloud 目录）
    ├── activities/      2026-11-07.jsonl  ← 一天一个文件
    ├── summaries/       AI 回顾
    ├── screenshots/
    ├── logs/
    └── arhat/sessions/  专注会话
```

> 用户常把 `Data/` 指向 iCloud/OneDrive 实现跨设备同步；
> 改路径在设置里即时生效，不需要重启。

---

## 2. 一条记录长什么样

```jsonc
// activities/2026-11-07.jsonl，一行一条
{
  "t": "2026-11-06T17:45:00.000Z",  // UTC，展示时转本地
  "dur": 8100000,                   // 毫秒
  "kind": "active",                 // active | idle
  "app": "chrome",                  // 应用名；人工补记时是事项名
  "title": "写材料",                 // 窗口标题或备注
  "cat": "文档写作",                 // 可以是细分分类，也可以是 7 组之一
  "platform": "manual",             // 来源平台
  "source": "manual"                // ★ 决定分层：manual / dida / uptimer / 空(=录制)
}
```

`source` 是分层的关键：

| source | 层 | 可改 | 优先级 |
| --- | --- | --- | --- |
| 空 / `recorded` | 记录层 | ❌ | 1（auto） |
| `dida` / `uptimer` | 标注层 | ✅ | 3（imported） |
| `manual` | 标注层 | ✅ | 4（manual） |
| （专注） | 标注层 | ✅ | 2（focus） |

**记录层不能改，是在 `storageManager.updateDisplayRecord / deleteDisplayRecord`
里硬拒绝的，前端绕不过去。**

---

## 3. 分析管线（analytics.js）

```
readDayRaw(date)                读当天 jsonl + 旧格式 json，统一成 item
        │                       顺手把 source 归成 manual / imported / auto
        ▼
normalizeRaw(items)             分类 + 归一，得到 atoms（原子事件）
        │
        ▼
inferDurations(atoms)           没有精确时长的旧数据，用「到下一条的间隔」推算
        │
        ▼
resolveByPriority(atoms)        ★ 手动 > 导入 > 专注 > 录制，重叠部分裁掉
        │                       专注会话在这里变成原子事件参与裁剪
        ▼
foldSessions(atoms)             合并相邻同应用 → sessions（会话，用于统计）
        │
        ▼
buildSlots(atoms, date)         15 分钟一格，每格取主导分类 + purity
        │
        ▼
buildDayReport()                输出 { stats, categories, categoriesGrouped,
                                       slots, layers, sessions, focus }
```

要点：

- **`resolveByPriority` 是唯一一次「谁是这段时间的主人」的判断**，
  之后所有计算都基于它的结果，不允许别处再做一次相加
- `slots` 是展示层口径，UI 和 AI 都读它；`sessions` 是统计口径
- `categories` 是 13 个细分分类（给规则和统计），
  `categoriesGrouped` 是 7 个展示分组（给「时间构成」）

---

## 4. 展示层怎么从 slots 长出来

```
slots(96 格)  ──相邻同分组合并──▶  blocks（时间轴卡片 / 日历色块）
                                      │
                                      ├─ 时长 = 格宽（15 分钟整数倍）
                                      ├─ 标题 = 备注 > 应用名 > 分组
                                      └─ note = 该格最具代表性的标题
```

- 时间轴的「段数」用的是合并后的块数，不是原始采样条数
- 日历的列数由窗口宽度决定：< 700px 一天，< 1420px 三天，否则七天

---

## 5. 交互约定（UI）

| 场景 | 行为 |
| --- | --- |
| 时间轴点卡片 | 打开浮层编辑器（标题 / 分类 / 备注） |
| 日历点色块 | 同上 |
| 日历空白处单击 | **什么都不发生**（不新建） |
| 日历空白处拖动 | 划出时间段 → 松手后打开编辑器 → 保存才落库 |
| 拖动色块 / 拖底边 | 全程显示虚线预览块，松手才落库，15 分钟吸附 |
| 右键色块 | 编辑 / 复制这一段时间 / 删除这一段 |
| 记录层的块 | 可看、可编辑（编辑即生成标注）、不可拖动、不可删除 |

统一编辑器是 `SegmentEditor.vue`，**不要再用「在某张卡片里塞几个按钮」的做法**——
那种实现会随卡片布局漂移，而且没法在日历里复用。

---

## 6. IPC 一览（主进程 ↔ 渲染进程）

```
get-config / save-config            配置
get-day-analytics                   当天报告（含 slots / layers）
get-activities                      原始活动（记录层视图用）
add-manual-record                   写一条标注（自动 15 分钟对齐）
update-display-record               改一条标注（记录层拒绝）
delete-display-record               删一条标注（记录层拒绝）
delete-display-range                删一段区间内的标注
delete-focus-session                删一条专注
import-data                         导入（支持选目录）
toggle-snap / minimize-window       窗口
```

---

## 7. 导入脚本（scripts/）

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| `import-dida-csv.js` | 滴答清单 CSV 全量导入（**推荐**） | `node scripts/import-dida-csv.js <csv> [--write] [--rebuild]` |
| `import-dida.js` | 早期按 MCP 结果导入 | `node scripts/import-dida.js <dir> [--write]` |
| `reclassify-dida.js` | 只重算导入记录的分类，不增删 | `node scripts/reclassify-dida.js [--write]` |
| `import-uptimer.py` | UpTimer（Couchbase Lite）导入 | `python scripts/import-uptimer.py <db.sqlite3> [--write]` |

约定：导入前**先备份** `activities/`；`--rebuild` 会先清掉上一次导入的行再重导
（因为原始 CSV 还在，重导不丢信息）。

---

## 8. 已知限制（不是 bug，是权衡）

1. **旧格式（2026-02~03）没有时长**，只能用相邻间隔推算，单条精度有限。
2. **点记录**（开始=结束，如「食堂吃饭 12:05」）存成 `dur: 0, point: true`，
   参与展示但不参与时长统计——不猜时长，避免造假。
3. **专注与录制重叠时以专注为准**，所以「专注期间的真实窗口活动」在展示层看不到
   （记录层还在，切到记录层能看到）。
4. **同一天既要有屏幕录制又要有滴答记录时，只保留屏幕录制**，
   否则工时翻倍（两边都是完整一天）。
5. **AI 回顾不做跨天对比**，因为 prompt 里没有历史上下文；要做对比得在分析层先算好。

---

## 9. 改代码前要记住的三件事

1. 改 `electron/*.js` 必须**重启** Electron；只改 `.vue` 才会热更新。
2. 任何写操作都要用**块自己的日期**，不能用「当前选中日期」——日历会同时显示好几天。
3. `teleport` 到 body 的组件拿不到 `.app-root` 上的主题变量，浮层请不要 teleport 出去。
