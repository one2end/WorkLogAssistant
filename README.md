# WorkLog Assistant - JavaScript版本

基于 Electron + Vue 的工作日志助手，用于自动监控和总结工作活动。

## 功能特性

- 🖥️ **窗口监控**: 自动监控当前活动窗口的标题和进程名
- 📸 **截图功能**: 定时截取屏幕截图（可选）
- 🤖 **AI摘要**: 使用AI API自动生成工作活动摘要
- 🎯 **系统托盘**: 最小化到系统托盘，不占用任务栏
- 💾 **数据存储**: 使用JSON文件存储活动记录和摘要
- ⚙️ **配置管理**: 灵活的配置选项，支持自定义监控间隔、API设置等

## 技术栈

- **Electron**: 跨平台桌面应用框架
- **Vue 3**: 现代化前端框架
- **Vite**: 快速的构建工具
- **Node.js**: 后端运行环境

## 安装步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置API密钥

编辑 `config.json` 文件，设置您的API密钥：

```json
{
  "api": {
    "apiKey": "your-api-key-here",
    "baseUrl": "https://api.deepseek.com/chat/completions",
    "modelName": "deepseek-chat"
  }
}
```

### 3. 运行应用

#### 开发模式
```bash
npm run electron:dev
```

#### 构建应用
```bash
npm run electron:build
```

## 使用说明

### 启动监控

1. 打开应用主窗口
2. 点击"开始监控"按钮
3. 应用将自动监控活动窗口并记录数据

### 生成摘要

1. 点击"摘要"标签页
2. 点击"生成摘要"按钮
3. 应用将根据最近的活动记录生成工作摘要

### 系统托盘

应用最小化后会隐藏到系统托盘，可以通过以下方式操作：
- 双击托盘图标显示主窗口
- 右键点击托盘图标显示菜单

### 配置选项

在"设置"标签页中可以配置：
- 监控间隔（秒）
- 是否启用截图
- API密钥和端点
- 摘要生成参数

## 项目结构

```
WorkLogAssistant-JS/
├── electron/              # Electron主进程
│   ├── main.js           # 主进程入口
│   ├── windowMonitor.js  # 窗口监控
│   ├── screenshotManager.js # 截图管理
│   ├── summarizer.js     # AI摘要
│   ├── configManager.js  # 配置管理
│   └── storageManager.js # 数据存储
├── src/                   # Vue前端
│   ├── App.vue          # 主组件
│   └── main.js          # 入口文件
├── public/              # 静态资源
├── build/               # 构建资源
├── Data/                # 数据目录（自动创建）
│   ├── activities.json  # 活动记录
│   ├── summaries.json   # 摘要记录
│   └── screenshots/     # 截图文件
├── package.json
├── vite.config.js
└── README.md
```

## 数据存储

所有数据存储在 `Data` 目录下：
- `activities.json`: 活动记录
- `summaries.json`: 摘要记录
- `summaries/`: Markdown格式的摘要文件
- `screenshots/`: 截图文件

## 跨平台支持

应用支持以下平台：
- Windows
- macOS
- Linux

## 注意事项

1. 首次运行需要配置API密钥
2. 监控间隔建议设置为60秒或更长
3. 截图功能会占用较多存储空间
4. 建议定期清理旧数据

## 故障排除

### 应用无法启动
- 检查Node.js版本（建议18+）
- 重新安装依赖：`npm install`

### 窗口监控不工作
- 检查系统权限
- 确认监控间隔设置合理

### AI摘要生成失败
- 检查API密钥是否正确
- 确认网络连接正常
- 检查API端点配置

## 许可证

MIT License

## 贡献

欢迎提交Issue和Pull Request！