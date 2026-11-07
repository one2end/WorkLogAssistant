# LifeLog — 本地优先的人生记录器

基于 Electron + Vue。自动记录你在电脑上做了什么，把热度留给「解释」而不是「记录」：
一天 96 个 15 分钟格，每格只需要你点一下确认；剩下的交给机器。

> **它不是一个更好的时间记录器，而是「换了多少软件，东西还在」的那一层。**
> 数据只在本机，随时能全部带走。

**官网 / 下载：https://one2end.github.io/WorkLogAssistant/** · **最新发布：[Releases](https://github.com/one2end/WorkLogAssistant/releases)**

## 文档

| 文档 | 内容 |
| --- | --- |
| [未来发展方向](docs/ROADMAP.md) | 为什么做这个产品、四层架构、下一步优先级、明确不做什么 |
| [架构说明](docs/ARCHITECTURE.md) | 数据分层、分析管线、IPC、导入脚本、已知限制 |
| [变更记录](CHANGELOG.md) | 每个版本改了什么 |

## 它能解决什么问题？

- **忘了今天干了什么**：自动记录你在电脑上的每一次窗口切换，下班前一键生成工作日志
- **专注力涣散**：专注模式提供极简沉浸界面 + 呼吸灯引导，帮你回归当下；冒出的杂念随手记下，不打断心流
- **写博客缺素材**：日志按天存储为 JSON/Markdown，可直接作为博客素材库；配合同步盘，跨设备随时查阅
- **手动记工时太麻烦**：应用使用时长自动统计，支持导出 CSV，对接任何工时系统

## 当前版本

**v0.9.0**（2026-11-07 发布）— 数据分层（记录层只读 / 标注层可改）/ 15 分钟统一原子 / 日历重做（每小时 54px、拖拽带预览）/ AI 降级为能力开关 / 主题拆成「明暗 × 强调色」

- 安装版：[LifeLog Setup 0.9.0.exe](https://github.com/one2end/WorkLogAssistant/releases/download/v0.9.0/LifeLog%20Setup%200.9.0.exe)（约 76 MB）
- 便携版：[LifeLog 0.9.0.exe](https://github.com/one2end/WorkLogAssistant/releases/download/v0.9.0/LifeLog%200.9.0.exe)（免安装，数据同样落在 `%APPDATA%\worklog-assistant`）

已导入 2017–2026 共 **1082 天**历史数据（滴答清单 + UpTimer）。Windows 安装包由 `npm run electron:build` 产出。

## 功能特性

### 核心功能
- **常驻采样**：Windows 下用常驻 PowerShell 进程采样前台窗口，1 秒精度，Add-Type 只编译一次
- **真实工时**：每个片段自带精确时长，不再用"记录条数 × 采样间隔"估算
- **空档检测**：读取系统最后输入时间，连续无操作超过阈值记为「空档」，不计入有效工时
- **分类统计**：展示层只有 7 组（工作/学习/生活/娱乐/睡眠/专注/其他），细分分类由规则自动推断
- **AI 摘要**：多模型支持（DeepSeek / Claude / OpenAI / Gemini / 自定义），输入是带真实时长的会话时间线
- **专注助手**：番茄钟 / 沉浸 / 罗汉三种节奏，桌面悬浮小窗实时显示当前状态
- **手工补记**：录制漏掉的时段可手动补上（开始时间 + 时长 + 分类），计入当日工时
- **按天存储**：活动以 JSONL 追加写入，摘要按天分文件，回溯成本低

### 专注助手

三种模式的差别只在节奏，都是同一个悬浮小窗 + 全屏界面的形态：

| 模式 | 节奏 | 说明 |
| --- | --- | --- |
| 番茄钟 | 25 / 5，四轮一组 | 时长、轮数可在设置里改 |
| 沉浸 | 15 / 15 | 节奏更松，适合写作和深度阅读 |
| 罗汉 | 不计时 | 单任务，一直做当下的事，随时觉察 |

启动后**主窗口自动收起到托盘**，桌面顶部只留一个可拖动的悬浮小窗，实时显示**当前阶段、剩余时间、正在做的事**。小窗自带暂停/继续、记杂念（展开输入行）、结束、返回主窗口四个操作；阶段切换时（工作→休息）会发系统通知，休息阶段小窗整体转绿，提醒你离开屏幕。

入口在**今日概览顶部的「开始专注」按钮**。点「返回主窗口」后全屏界面仍可用：可暂停、跳过本轮、记杂念，`Esc` 结束、空格暂停。每段专注都按模式记录时长，出现在今日概览的「专注与随手记」里；结束或自然结束时主窗口自动恢复。

### 手工补记

时间线上方有「补记」按钮，填开始时间、时长、分类和事项即可。用于：

- 开了免打扰 / 没在电脑前，但确实在工作的时间
- 会议、走访、纸质材料处理这类没有窗口记录的工作

补记条目在时间线里带「手工」标记，和自动录制区分开，但同样计入工时和分类统计。

### 界面
- **四个主视图**：今日概览（工时、时间构成、应用排行）、时间线（会话 / 明细双视图）、AI 摘要、设置
- **响应式多列布局**：今日概览不锁死宽度，窗口 ≥900px 两列、≥1320px 三列；热力图、时间构成、应用排行、专注与随手记、当前会话等一起并排，只有顶部条与主视觉跨满
- **设计系统**：统一的间距（4pt 网格）、字号阶梯、语义化颜色 token、圆角与动效规范
- **5 套主题**：深色、浅色、海洋、森林、玫瑰，共用一套语义 token；**换肤入口在标题栏右侧**，点开是 5 个色块，一次选到位
- **主题色板联动**：`src/styles/palette.js` 是分类色的唯一来源，5 套主题各有一组分类色；换肤时时间带、堆叠条、分类条、应用条、时间线会话与热力图一起换色，配错峰淡入、accent 扫光与表面过渡动效（含 reduced-motion 保护）
- **日期双向同步**：今日概览顶部有日期条（前后翻天 + 日历弹层）；切到任意历史日期时热力图自动移到包含该日的 12 周窗口并高亮，反之点热力图格子也会同步日期条
- **自绘图标**：24×24、1.75 描边的内联 SVG 图标集，不依赖图标字体
- **浮窗**：最小化后在桌面角落保留当前应用与计时，可拖动、可调宽

### 数据可视化与空状态

- **24 小时日时间带**：今日概览把一天画成 96 格（15 分钟/格）彩色带，按 `report.sessions` 聚合取主导分类着色，占用越多越不透明；带小时刻度与「当前时刻」标线。**点击任意格（含空白格）跳到时间线**并滚动高亮最接近的会话。
- **12 周活动热力图**：12 列 × 7 行、周一开头，84 天密集数据由 `get-daily-tracked` IPC 与 `analytics.buildDailyTrackedMs` 提供（口径与首屏工时数字一致）；5 级色用 `--accent` + `color-mix` 自动跟随 5 套主题，阈值 `[90, 210, 360]` 分钟并在数据偏少时自适应降档；悬停显示当日时长，**点击只切换日期、留在概览**。支持 `‹ ›` 前后翻 12 周、月份直选、以及「今天」一键把日期与窗口一起拉回当前。
- **空状态插画**：`EmptyIllustration.vue` 用一张 SVG 母题（表盘 + 记录卡片 + 时间条）配场景变体，替换 6 处空状态；纯 CSS 变量绘制，深浅色都可读，含 reduced-motion 保护。
- **浮窗主题同步**：`float.html` 改为卡片式内高光 + accent 顶光 + 主题化阴影；`focus.html` 从硬编码深色改为 12 个 `--hud-*` 变量与 5 套主题映射，由主进程 `focus-theme` 事件跟随主窗口。

### AI 数据接口
把工时数据交给任意 AI 汇总整理，两种接入方式：

- **MCP（推荐）**：配置一次，之后在 WorkBuddy / Claude Desktop 等支持 MCP 的客户端里直接问"我上周时间花在哪了"，AI 会自己调用查询工具
- **本地 HTTP**：`127.0.0.1` 上的只读 REST 接口，带 token 鉴权，适合脚本、快捷指令、自建看板

启用方式：设置页 →「AI 数据接口」，复制 MCP 配置片段粘贴到客户端的 `mcp.json` 即可。

### 数据管理
- **导入/导出**：支持完整 JSON 导出、CSV 导出、JSON 导入（合并或覆盖）
- **自定义存储路径**：可设置为 iCloud / OneDrive / 坚果云目录，实现跨设备同步
- **历史回溯**：日历选择查看任意日期的活动数据

### 系统集成
- **系统托盘**：最小化到系统托盘，不占用任务栏
- **开机自启动**：支持开机自动启动
- **自动更新**：支持检查 GitHub releases 更新

## AI 数据接口

### 方式一：MCP（接入 AI 客户端）

设置页「AI 数据接口」里有可一键复制的配置片段，形如：

```json
{
  "mcpServers": {
    "worklog": {
      "command": "node",
      "args": ["C:/path/to/WorkLogAssistant-JS/mcp/worklog-mcp.js"]
    }
  }
}
```

粘贴到客户端配置后重启，即可用自然语言查询。提供的工具：

| 工具 | 用途 |
| --- | --- |
| `worklog_list_dates` | 哪些日期有数据 |
| `worklog_day_report` | 单日完整报告（工时、分类、应用、窗口标题、时间线、手记） |
| `worklog_range_report` | 区间概览（每日对比、分类占比、跨天排行） |
| `worklog_app_ranking` | 只要排行 JSON，token 最省 |
| `worklog_search` | 按应用名或窗口标题检索历史 |
| `worklog_timeline` | 某天某时段的时间线 |

MCP 进程直接读磁盘数据，**不要求桌面应用正在运行**。

### 方式二：本地 HTTP

默认 `http://127.0.0.1:47821`，仅在回环地址监听，端口可在设置页修改。

```bash
# token 在设置页「访问 Token」处复制
curl -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:47821/api/report/day?date=2026-03-30"
```

| 端点 | 说明 |
| --- | --- |
| `/health` | 探活（免 token） |
| `/api/dates` | 有记录的日期 |
| `/api/report/day?date=&detail=&format=` | 单日报告 |
| `/api/report/range?from=&to=&detail=&format=` | 区间报告 |
| `/api/apps?from=&to=` | 应用时长排行 |
| `/api/search?q=&from=&to=` | 关键词检索 |
| `/api/summaries?date=` | 应用内已生成的 AI 摘要 |
| `/openapi.json` | OpenAPI 描述 |

`detail` 三档：`compact` 只要汇总，`normal` 含应用时长与时间线（默认），`full` 含全部会话明细。

浏览器打开 `http://127.0.0.1:47821/?token=<token>` 有可视化端点列表。

### 时长是怎么算出来的

`ActivityRecorder` 每秒钟读一次采样，把连续相同的状态合并成「片段」，片段结束时带着精确的 `durationMs` 追加写入 JSONL。三类边界：

- **空闲**：系统最后输入时间距今超过阈值（默认 180 秒）→ 片段标记为 `idle`，单独累计为"离座"，不计入有效工时
- **休眠/唤醒**：tick 间隔异常拉长时，把当前片段截止到最后一个正常 tick，休眠期间不产生工时
- **碎片**：短于 `minSegmentSec`（默认 3 秒）的切换并入上一段，避免时间线碎成一堆 1 秒片段

旧版本留下的 `.json` 数据没有时长字段，`analytics` 会退回用相邻记录的时间差推断，并在报告里标注「时长不确定」。

`LockApp`（锁屏界面）等进程统一归类为「空闲离座」，即使被记成普通活动也会被剔除。工作日志助手自身的进程不会计入统计。


## 罗汉模式的由来

> 不强求一念不起，而是时刻的自我觉察。

番茄钟和沉浸模式是意志力与本能的对抗——设倒计时，到点必须停。罗汉模式换了个思路：不设倒计时，不惩罚"失败"，只帮你保持对当下的觉知。

**使用方式**：
1. 点击左侧导航底部的靶心图标，选「罗汉」，写下当下最重要的一件事
2. 进入全屏界面，呼吸光晕辅助调息，计时只往上走
3. 冒出杂念时点"记一笔杂念"快速记下，界面立刻恢复极简
4. 做完就结束，再放下一件事——包括决定去刷会儿手机

杂念记录按天保存，会出现在今日概览的「专注与随手记」里，也可作为待办或灵感素材回顾。

## 博客工作流结合

如果你在写博客，WorkLog Assistant 可以这样帮你：

1. **素材收集**：日常工作中的窗口标题自动记录了你在研究什么、写什么、看什么文档。AI 摘要会提炼出结构化的工作内容，直接作为博客选题或技术笔记的素材
2. **写作时间追踪**：通过应用使用时长统计，你可以看到自己在编辑器/写作工具上花了多少时间
3. **专注模式写作**：进入专注模式专注写博客，冒出的灵感用杂念闪记捕捉，写完后回顾
4. **跨设备同步**：将存储路径设置为同步盘目录，在任何设备上查阅日志和素材
5. **导出为 Markdown**：摘要自动生成 Markdown 文件，可直接复制到博客系统

## 技术栈

- **Electron 28** - 跨平台桌面应用框架
- **Vue 3** - 前端框架
- **Vite 5** - 构建工具
- **Axios** - HTTP 客户端
- **Marked** - Markdown 解析

## 安装与运行

### 安装依赖

```bash
npm install
```

### 配置 API

启动应用后进入设置页面：
1. 选择模型提供商（DeepSeek / OpenAI / Claude / Gemini / 自定义）
2. 填入对应的 API Key
3. Base URL 和模型名称会自动填充，也可手动修改

### 从源码直接运行（推荐，不打包）

```bash
npm run build      # 构建前端产物到 dist/
npm run electron   # 加载 dist/index.html 启动
```

`electron .` 默认没有 `NODE_ENV`，`main.js` 里 `isDev = false`，因此**加载的是 `dist/index.html`**，不是 Vite 开发服务器。若 `dist/` 不存在，窗口会提示先执行构建。

`npm run electron:dev` 会同时启动 Vite（5173）和 Electron，但 `electron .` 不注入 `NODE_ENV`，所以 Vite 起来了也**不会被加载**，没有热更新。真要连开发服务器，请开两个终端：

```bash
# 终端 1
npm run dev
# 终端 2
NODE_ENV=development npm run electron
```

此时会 `loadURL('http://localhost:5173')` 并自动打开 DevTools；若 5173 不可达会自动回退到 `dist/`，不会黑屏。

验证加载的是最新产物：看 `dist/assets/` 的文件名与时间戳，或在 DevTools Network 里确认请求是 `file://.../dist/index.html`（而不是 `http://localhost:5173` / `/@vite/client`）。

改动生效方式：

| 改了什么 | 怎么生效 |
| --- | --- |
| `electron/main.js`、`analytics.js` 等主进程模块 | **完全退出并重启 Electron**（启动时 require，无热重载） |
| `electron/float.html`、`focus.html` | reload 对应浮窗，最稳是重启整个应用 |
| `src/**/*.vue`、`src/styles/*.css` | `npm run build` + 重启 / 主窗口 reload |

### 构建应用

```bash
npm run electron:build
```

打包时 `mcp/` 和 `electron/analytics.js` 会被 `asarUnpack` 解包到 `app.asar.unpacked`，
以便 MCP 客户端能用普通 `node` 进程启动它。

## 数据存储

数据默认存储在系统用户数据目录：
- Windows: `%APPDATA%/worklog-assistant/Data/`
- macOS: `~/Library/Application Support/worklog-assistant/Data/`
- Linux: `~/.config/worklog-assistant/Data/`

> 目录名是代码里钉死的 `worklog-assistant`（不是显示名 LifeLog）。
> 想让多台机器同步，把 `Data/` 指到 iCloud / OneDrive 目录即可，设置里改完即时生效。

目录结构：
```
Data/
├── activities/
│   ├── YYYY-MM-DD.jsonl   # 录制片段，一行一段，追加写（当前格式）
│   └── YYYY-MM-DD.json    # 旧版记录 / 导入数据（只读兼容）
├── summaries/             # 摘要数据（按天 YYYY-MM-DD.json）
├── summaries_md/          # Markdown 摘要文件
├── arhat/                 # 专注模式数据
│   ├── sessions/          # 专注会话记录
│   └── notes/             # 杂念闪记
└── screenshots/           # 截图（实验性）
```

JSONL 每行格式：

```json
{"t":"2026-11-06T03:26:37.862Z","dur":4016,"kind":"active","app":"chrome","title":"...","platform":"windows"}
```

`dur` 为毫秒，`kind` 为 `active` 或 `idle`。

可在设置中将存储路径指向同步盘目录（如 OneDrive、iCloud、坚果云），实现跨设备数据同步。

## 项目结构

```
WorkLogAssistant-JS/
├── electron/                 # Electron 主进程
│   ├── main.js              # 入口、窗口、IPC、托盘
│   ├── windowMonitor.js     # 常驻采样（Windows PowerShell + GetLastInputInfo）
│   ├── activityRecorder.js  # 片段切分、时长计算、空闲判定、落盘
│   ├── analytics.js         # 聚合与报告（无 Electron 依赖，MCP 复用）
│   ├── apiServer.js         # 本地 HTTP 接口
│   ├── summarizer.js        # AI 摘要（多模型）
│   ├── storageManager.js    # 存储（JSONL 追加 + 旧 JSON 兼容）
│   ├── configManager.js     # 配置
│   ├── arhatManager.js      # 专注记录与杂念存储
│   ├── focusManager.js      # 专注状态机（番茄/沉浸/罗汉）
│   ├── logManager.js        # 日志
│   ├── float.html           # 浮窗页面
│   └── focus.html           # 专注悬浮小窗
├── mcp/
│   └── worklog-mcp.js       # 独立 MCP Server（stdio）
├── src/
│   ├── App.vue              # 编排层：状态、IPC、视图路由
│   ├── main.js
│   ├── styles/
│   │   ├── tokens.css       # 设计 token（间距/字号/圆角/5 套主题）
│   │   ├── base.css         # Reset + 通用组件（按钮/卡片/输入/空状态）
│   │   └── palette.js       # 分类色板唯一来源（5 套主题 × 11 分类）
│   ├── components/
│   │   ├── Icon.vue              # 内联 SVG 图标集
│   │   ├── TitleBar.vue          # 自定义标题栏
│   │   ├── NavRail.vue           # 左侧导航
│   │   ├── DateNav.vue           # 日期切换 + 日历弹层
│   │   ├── FocusOverlay.vue      # 专注模式全屏层
│   │   ├── ActivityHeatmap.vue   # 12 周活动热力图
│   │   └── EmptyIllustration.vue # 空状态插画
│   └── views/
│       ├── TodayView.vue    # 今日概览
│       ├── TimelineView.vue # 时间线
│       ├── SummaryView.vue  # AI 摘要
│       └── SettingsView.vue # 设置
├── build/                    # icon.svg（源文件）/ icon.png / icon.ico / tray.png
├── scripts/
│   ├── build-icons.js        # SVG → 各尺寸 PNG / ICO（需 Electron）
│   └── patch-exe-icon.js     # 给 Electron 模板 exe 打图标（绕开 winCodeSign）
├── package.json
├── vite.config.js
└── README.md
```

## 更新日志

### v0.8.0 (当前版本)
- **24 小时日时间带**：今日概览新增 96 格彩色时间带，点击任意时段跳到时间线并定位高亮最近会话
- **12 周活动热力图**：周一开头、5 级强度随主题变化，悬停看时长、点击换日；新增 `get-daily-tracked` IPC 与 `buildDailyTrackedMs`，口径与首屏工时一致
- **空状态插画**：`EmptyIllustration.vue` 统一 6 处空状态，全用 CSS 变量跟随主题
- **浮窗主题同步**：`float.html` 卡片层次升级；`focus.html` 由硬编码深色改为 12 个 `--hud-*` 变量 + 5 套主题映射，主进程推送 `focus-theme`
- **视觉重构**：设计 token 扩展大字号与表面层次，分类色板收敛，核心工时数字放大，图表加粗，5 套主题一致性提升
- **响应式与换肤**：今日概览改多列 grid（≥900px 两列 / ≥1320px 三列）；换肤入口移到标题栏并加 5 色弹层；`palette.js` 统一分类色，图表随主题联动；补错峰淡入、accent 扫光与颜色过渡动效
- **日期与热力图统一**：今日概览顶部补回日期条；热力图支持前后翻页、月份直选、「今天」；日期条与热力图窗口双向同步
- **专注小窗交互**：主窗口启动时自动收起，计时小窗可拖动并支持暂停/继续、记杂念、结束、返回主窗口；结束自动恢复主窗口；专注入口移到今日概览顶部
- **数据来源修正**：手工补记的「事项名」不再混进「应用排行」（`report.apps` 带 `manual` 标记，前端单列提示），并清除了两条调试残留的补记记录
- 修正文档关于 `electron:dev` 会加载 Vite 开发服务器的错误描述，补上运行与重启说明

### v0.7.0
- **专注助手重做**：拆成番茄钟 / 沉浸 / 罗汉三种预设，`focusManager` 负责状态机（阶段推进、暂停、跳过、轮次）
- **桌面悬浮小窗**：新增 `focus.html`，工作/休息阶段实时显示，休息时整体转绿
- **阶段通知**：工作→休息、休息→工作自动发系统通知
- **专注记录带模式**：sessions 增加 `mode` / `rounds` / `activeMs`，旧记录无此字段仍可读
- **专注时长可配置**：设置页新增「专注模式」分区，番茄与沉浸的时长、轮数可改
- **手工补记**：时间线支持手动补一段（开始时间 + 时长 + 分类 + 事项），带「手工」标记，计入统计
- 补记支持指定分类，避免全部落进「其他」
- **应用图标重绘**：心电波形 + 蓝紫圆角容器，`build/icon.svg` 为源文件，`npm run icons` 一键生成各尺寸 PNG 和 7 尺寸 ICO；标题栏品牌标记同步为同一波形

### v0.6.0
- **采集内核重写**：`windowMonitor` 改为常驻 PowerShell 子进程，Add-Type 只编译一次；每秒采样并读取 `GetLastInputInfo` 做真实空闲检测
- **新增 `activityRecorder`**：把采样切成片段，片段自带精确 `durationMs`，区分 active / idle；处理系统休眠、短碎片合并
- **存储改为 JSONL 追加写**：写入变成 O(1)；读取时自动兼容旧 JSON
- **空闲与锁屏**：离座时间单独统计并从有效工时剔除；记录器自身进程不再计入
- **AI 摘要输入重做**：改为带真实时长的会话时间线（片段多时按小时聚合压缩）
- **界面重构**：拆成 App 编排层 + 4 个视图 + 5 个基础组件，`App.vue` 从 3200 行降到约 900 行
- **设计系统**：新增 `tokens.css` 与 `base.css`，5 套主题共用语义 token
- **图标重做**：emoji 全部替换为 24×24 / 1.75 描边的内联 SVG 图标集
- 修复从源码启动黑屏；渲染进程报错写入应用日志

### v0.5.0
- 新增 AI 数据接口：`mcp/worklog-mcp.js`（MCP Server，6 个查询工具）+ `electron/apiServer.js`（本地 HTTP）
- 新增 `electron/analytics.js` 聚合层：按相邻记录时间差推断真实停留时长，折叠会话，分类统计
- 锁屏 / 登录界面自动识别为「离座」，从有效工时中剔除
- 报告支持 `compact` / `normal` / `full` 三档详细度，控制 token 开销
- 设置页新增「AI 数据接口」面板：状态、端口、token、连通性测试、MCP 配置一键复制
- 修复从源码启动时黑屏的问题（`isDev` 判断误把非打包运行当成开发模式去连 localhost:5173）
- 渲染进程报错现在会写入应用日志，便于排查白屏

### v0.4.0
- 新增罗汉模式（极简觉察 UI、杂念闪记、呼吸灯、柔性计时）
- 新增多模型支持（DeepSeek / OpenAI / Claude / Gemini / 自定义）
- 重构数据存储为按天分文件，旧数据自动迁移
- 新增自定义存储路径，支持同步盘跨设备同步
- 新增完整数据导入/导出（JSON 全量、CSV、合并/覆盖导入）
- 主题选择改为可视化色块卡片
- 修复 IPC 事件监听器未清理的内存泄漏
- 修复"查看今日摘要"功能异常的 Bug

### v0.3.0
- 启动自动开始记录
- 修改设置后立即生效
- 新增费用预估、自选时间段摘要、自定义总结周期

### v0.2.0
- 浮窗模式、日志管理、多主题支持
- 开机自启动、自动更新检查

### v0.1.0
- 窗口监控、AI 摘要生成、系统托盘、配置管理

## 许可证

MIT License
