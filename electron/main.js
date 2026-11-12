const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');

// 强调色在主窗口里由 CSS 变量生成；浮窗是独立 HTML，拿不到主文档变量，
// 这里用同一组色相/饱和度再算一遍推过去，保证小窗和大窗同色。
const ACCENT_HSL = {
  blue: [222, 82], teal: [190, 78], green: [158, 58],
  violet: [262, 76], rose: [344, 72], amber: [34, 88]
};
function accentCss(ui = {}) {
  const [h, sat] = ACCENT_HSL[ui.accent] || ACCENT_HSL.blue;
  const l = ui.mode === 'light' ? 42 : 52;
  return `hsl(${h} ${sat}% ${l}%)`;
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WindowMonitor = require('./windowMonitor');
const ActivityRecorder = require('./activityRecorder');
const Summarizer = require('./summarizer');
const ConfigManager = require('./configManager');
const StorageManager = require('./storageManager');
const LogManager = require('./logManager');
const importSafety = require('./importSafety');
const slotRule = require('./slotRule');
const storagePrecheck = require('./storagePrecheck');
const ipcGuard = require('./ipcGuard');
const externalLink = require('./externalLink');

// 桥接页的一次性票据。放在模块级：进程存活期间有效，
// 重启即清空——这正是我们想要的（旧票据不能跨会话使用）。
// 必须在 apiServer 之前声明：它要把这个库注入进去做兑换。
const bridgeTickets = new externalLink.TicketStore();
const reportRunner = require('./reportRunner');
const ArhatManager = require('./arhatManager');
const FocusManager = require('./focusManager');
const { ApiServer, generateToken } = require('./apiServer');
const analytics = require('./analytics');
const { categorySuggestions } = require('./annotationAdvisor');
const { DidaSync } = require('./didaSync');
const { PlanManager } = require('./planManager');
const { writeFileAtomic } = require('./atomicFile');
const { reviewWindow } = require('./aiReview');
const { splitRecordAtMidnight } = require('./timeSplit');

/**
 * 图标资源路径。打包后放在 resources 目录（见 package.json extraResources），
 * 开发时直接读 build/。
 */
function assetPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', 'build', name);
}

/**
 * Windows 任务栏 / 开始菜单靠 AppUserModelID 把窗口归到某个应用。
 * 不设的话，源码运行时窗口会被算作 electron.exe，显示 Electron 的默认图标。
 * 这个值要和 electron-builder 的 appId 保持一致。
 */
const APP_ID = 'com.worklog.assistant';

// 数据目录固定成这个值。
// 注意：改 app.setName 会让 Electron 重算 userData 路径（跟着名字走），
// 历史上因为目录名不同出现过两次，所以这里显式钉死，避免升级后"数据消失"。
const DATA_APP_DIR = 'worklog-assistant';

try {
  app.setAppUserModelId(APP_ID);
  app.setName('LifeLog');
  app.setPath('userData', path.join(app.getPath('appData'), DATA_APP_DIR));
} catch (e) { /* 非 Windows 平台忽略前两项 */ }

let mainWindow;
let floatWindow;
let focusWindow;
let tray;
let isMonitoring = false;
let monitorInterval = null;
let summaryInterval = null;
let scheduleCheckerInterval = null;
let triggeredSchedules = new Set();
let autoReviewBusy = false;
let lastSummaryTime = null;
let currentAppName = '';
let currentAppStartTime = null;
let floatSize = { width: 220, height: 36 };

const configManager = new ConfigManager();
const customPath = configManager.getConfig().storage?.customPath || '';
const storageManager = new StorageManager(customPath);
const windowMonitor = new WindowMonitor();
const summarizer = new Summarizer();
const logManager = new LogManager(customPath);
const arhatManager = new ArhatManager(customPath);
const planManager = new PlanManager(() => storageManager.getDataDir());

/**
 * 迁移期间写操作会抛 WriteBlockedError。IPC handler 若直接把它放出去，
 * 渲染层只会看到一条没有上下文的异常；这里统一换成「有错误码、能读懂」的结果，
 * 前端据此提示「迁移中，请稍候」，而不是误报成「保存失败」。
 */
function writeFailure(error) {
  if (error && error.code === 'MIGRATION_IN_PROGRESS') {
    return { ok: false, code: 'MIGRATION_IN_PROGRESS', error: error.message, retryable: true };
  }
  return { ok: false, code: 'WRITE_FAILED', error: error ? error.message : '写入失败' };
}

/**
 * 包一层写调用：迁移被锁时返回结构化错误，其余异常也不让它冒泡到 IPC 层。
 * 各 handler 的返回形状不完全一样（有的用 success，有的用 ok），所以这里
 * 只负责把异常转成同一份「失败形状」，由调用方决定字段名。
 */
function callStorage(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    const failure = writeFailure(error);
    if (fallback === 'success') return { success: false, code: failure.code, error: failure.error };
    return failure;
  }
}

/** 推给渲染层的统一出口；窗口可能还没创建或正在销毁 */
function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch (_) { /* 窗口切换期忽略 */ }
}

const didaSync = new DidaSync({
  getConfig: () => configManager.getConfig(),
  getDataDir: () => storageManager.getDataDir(),
  broadcast,
  buildDayReport: (dir, date, options) => analytics.buildDayReport(dir, date,
    { ...(options || {}), ...(configManager.getConfig().analysis || {}) })
});

// --- 专注助手（番茄 / 沉浸 / 罗汉） ---

const focusManager = new FocusManager({
  arhatManager,
  getConfig: () => configManager.getConfig(),
  onLog: (message, type) => logManager.addLog(message, type || 'info'),
  onPhaseChange: (state) => {
    notifyFocus(state);
    broadcastFocus(state);
  },
  onEnd: (record) => {
    hideFocusWindow();
    restoreMainWindow();
    broadcastFocus({ active: false, lastRecord: record });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('focus-ended', record);
    }
  }
});

function notifyFocus(state) {
  try {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const isBreak = state.phase === 'break';
    new Notification({
      title: isBreak ? '该休息了' : `${state.modeName} · 开始专注`,
      body: isBreak
        ? `${state.durationMs / 60000} 分钟后回来，站起来走走`
        : (state.focusText || '回到当下这一件事'),
      silent: false
    }).show();
  } catch (e) { /* 通知失败不影响主流程 */ }
}

function broadcastFocus(state) {
  const payload = state || focusManager.getState();
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.webContents.send('focus-hud', payload);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus-state', payload);
  }
}

function createFocusWindow() {
  if (focusWindow && !focusWindow.isDestroyed()) return focusWindow;

  const { screen } = require('electron');
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 340;
  const height = 48;

  focusWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 14,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // 计时小窗需要能拖动、能点按钮，所以放开 movable / focusable
    movable: true,
    hasShadow: false,
    focusable: true,
    show: false,
    // A3b：关闭 Node 能力，开启上下文隔离，挂专注窗专用 preload。
    // 专注窗只需要 5 个通道（会话控制 + 状态查询），拿不到活动记录也改不了配置。
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload-focus.js')
    }
  });

  focusWindow.loadFile(path.join(__dirname, 'focus.html'));
  // 隐藏窗口的 ready-to-show 在部分 Electron 版本不触发，主题用 did-finish-load 兜底
  focusWindow.webContents.once('did-finish-load', () => {
    if (!focusWindow || focusWindow.isDestroyed()) return;
    const ui = configManager.getConfig().ui || {};
    focusWindow.webContents.send('focus-theme', { mode: ui.mode || 'dark', surface: ui.surface || 'nocturne' });
  });
  focusWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  focusWindow.setAlwaysOnTop(true, 'screen-saver');
  focusWindow.once('ready-to-show', () => {
    focusWindow.showInactive();
    broadcastFocus();
  });
  focusWindow.on('closed', () => { focusWindow = null; });

  return focusWindow;
}

function hideFocusWindow() {
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.hide();
  }
}

/** 专注结束后把主窗口带回来（幂等，手动结束与自然结束都会调用） */
function restoreMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

const activityRecorder = new ActivityRecorder({
  monitor: windowMonitor,
  storage: storageManager,
  getConfig: () => configManager.getConfig(),
  onLog: (message, type) => logManager.addLog(message, type || 'info'),
  onSegment: (record) => {
    // 只把「工作片段」实时推给界面，空闲段不刷时间线
    if (record.kind !== 'active') return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('activity-logged', {
        id: record.t,
        timestamp: record.t,
        processName: record.app,
        windowTitle: record.title,
        platform: record.platform,
        durationMs: record.dur,
        kind: 'active'
      });
    }
  }
});

// --- 对外数据接口（本地 HTTP + MCP） ---

function getMcpServerPath() {
  // 打包后 mcp/ 会被 asarUnpack，需要指向解包目录
  return path.join(__dirname, '..', 'mcp', 'worklog-mcp.js')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function ensureBridgeToken() {
  const cfg = configManager.getConfig();
  let token = cfg.bridge?.token;
  if (!token) {
    token = generateToken();
    configManager.updateConfig({ bridge: { token } });
  }
  return token;
}

const apiServer = new ApiServer({
  getDataDir: () => storageManager.getDataDir(),
  getConfig: () => ({ ...configManager.getConfig(), version: app.getVersion() }),
  port: configManager.getConfig().bridge?.port || 47821,
  token: ensureBridgeToken(),
  // 兑换端点要用它把一次性码换成 Token
  ticketStore: bridgeTickets
});

async function startBridge() {
  const cfg = configManager.getConfig();
  if (cfg.bridge?.enabled === false) {
    logManager.addLog('数据接口已禁用，跳过启动', 'info');
    return;
  }
  const result = await apiServer.start();
  if (result.ok) {
    logManager.addLog(`数据接口已启动: ${result.url}`, 'info');
  } else {
    logManager.addLog('数据接口启动失败: ' + result.error, 'error');
  }
}

function getMcpConfigSnippet() {
  // 统一成正斜杠：Node 在 Windows 上完全支持，且 JSON 里不用双反斜杠转义，更短更好读
  const toPosix = (p) => p.replace(/\\/g, '/');
  const snippet = {
    mcpServers: {
      worklog: {
        command: 'node',
        args: [toPosix(getMcpServerPath())],
        env: { WORKLOG_DATA_DIR: toPosix(storageManager.getDataDir()) }
      }
    }
  };
  return JSON.stringify(snippet, null, 2);
}

function createWindow() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;

  // 默认就用最窄宽度：这是贴在屏幕右侧的一条竖窗，不抢桌面。
  // 想临时看宽版可以手动拉宽，或按贴边键切换。
  const DEFAULT_W = 520;
  const MIN_W = 520;

  mainWindow = new BrowserWindow({
    width: DEFAULT_W,
    height: workArea.height,
    x: workArea.x + workArea.width - DEFAULT_W,
    y: workArea.y,
    minWidth: MIN_W,
    minHeight: 600,
    // Windows 下用 .ico 才能在任务栏/Alt+Tab 拿到多尺寸清晰图标
    icon: process.platform === 'win32' ? assetPath('icon.ico') : assetPath('icon.png'),
    webPreferences: {
      // A4：主窗关闭 Node 能力，开启上下文隔离，挂主窗 preload。
      // 这是全项目风险最高的一处改动——主窗承载全部业务界面。
      //
      // 不启用 sandbox：主窗要加载打包后的 Vite 产物与本地资源，
      // 沙箱会限制 preload 之外的 Node 能力，而本窗口的 preload 已经
      // 按白名单收窄了暴露面，再加沙箱的收益小于它可能引入的加载问题。
      // 两个小窗是纯静态 HTML，沙箱开销小、收益明确，所以它们开了。
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: configManager.getConfig().ui?.mode === 'light' ? '#f7f8fa' : '#0b0c0e'
  });

  const isDev = process.env.NODE_ENV === 'development';
  const distIndex = path.join(__dirname, '../dist/index.html');

  const loadProduction = () => {
    if (!fs.existsSync(distIndex)) {
      logManager.addLog('未找到 dist/index.html，请先执行 npm run build', 'error');
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<body style="background:#0d0d0d;color:#e6e6e6;font-family:sans-serif;padding:40px">' +
        '<h2>页面资源缺失</h2><p>没有找到 dist/index.html。</p>' +
        '<p>请先运行 <code>npm run build</code>，或使用 <code>npm run electron:dev</code> 启动开发模式。</p></body>'
      ));
      return;
    }
    mainWindow.loadFile(distIndex).catch((err) => {
      logManager.addLog('加载页面失败: ' + err.message, 'error');
    });
  };

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    // 开发模式下如果 dev server 还没起来，直接回退到构建产物，避免黑屏
    mainWindow.loadURL(devUrl).catch(() => {
      logManager.addLog('开发服务器不可达，回退到 dist/index.html', 'info');
      loadProduction();
    });
    mainWindow.webContents.once('did-fail-load', (e, code, desc, url) => {
      if (url && url.startsWith('http://localhost')) {
        logManager.addLog(`开发服务器连接失败(${code} ${desc})，回退到构建产物`, 'info');
        loadProduction();
      }
    });
    mainWindow.webContents.openDevTools();
  } else {
    loadProduction();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (floatWindow) {
      floatWindow.hide();
    }
  });

  // 把渲染进程的报错转存到应用日志，便于排查白屏/黑屏
  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level < 2) return;
    // Electron 的安全警告（CSP、nodeIntegration 等）在开发模式下会刷屏，
    // 不往诊断日志里塞噪音——真正的错误在它后面，别被淹掉。
    if (message.includes('Electron Security Warning')) return;
    logManager.addLog('[渲染进程] ' + message, 'error');
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    logManager.addLog(`页面加载失败 ${code}: ${desc}`, 'error');
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    logManager.addLog('渲染进程异常退出: ' + details.reason, 'error');
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  let trayIcon;

  try {
    // 优先用专门为托盘生成的 32px 图，缩到 16px 比从 1024 缩更清晰
    const candidates = ['tray.png', 'icon.png'];
    let img = null;
    for (const name of candidates) {
      const p = assetPath(name);
      if (!fs.existsSync(p)) continue;
      const candidate = nativeImage.createFromPath(p);
      if (!candidate.isEmpty()) {
        img = candidate;
        break;
      }
    }
    trayIcon = img || nativeImage.createEmpty();
  } catch (error) {
    logManager.addLog('加载托盘图标失败: ' + error.message, 'error');
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '查看今日摘要', click: () => showTodaySummary() },
    { label: '生成当前摘要', click: () => generateCurrentSummary() },
    { label: '打开数据文件夹', click: () => openDataFolder() },
    { type: 'separator' },
    { 
      label: isMonitoring ? '暂停记录' : '开始记录',
      click: () => toggleMonitoring() 
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]);

  tray.setToolTip('LifeLog · 本地记录中');
  tray.setContextMenu(contextMenu);
  
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (floatWindow) {
    floatWindow.hide();
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createFloatWindow() {
  if (floatWindow) return;

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  const config = configManager.getConfig();
  const floatW = config.ui?.floatWidth || 220;
  floatSize = { width: floatW, height: 36 };

  floatWindow = new BrowserWindow({
    width: floatW,
    height: 36,
    x: width - floatW - 20,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // A3b：同上。悬浮条只有 6 个通道，主要是拖动自己与开关录制。
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload-float.js')
    }
  });

  floatWindow.loadFile(path.join(__dirname, 'float.html'));
  floatWindow.setVisibleOnAllWorkspaces(true);

  floatWindow.webContents.once('did-finish-load', () => {
    const ui = configManager.getConfig().ui || {};
    floatWindow.webContents.send('float-theme', { mode: ui.mode || 'dark', surface: ui.surface || 'nocturne' });
    floatWindow.webContents.send('float-accent', accentCss(ui));
    floatWindow.webContents.send('float-monitoring-status', isMonitoring);
  });

  floatWindow.on('closed', () => {
    floatWindow = null;
  });
}

function updateFloatWindow() {
  if (!floatWindow) return;

  const status = activityRecorder.getStatus();
  const cur = status.current;

  let duration = '';
  if (isMonitoring && cur) {
    const minutes = Math.floor(cur.elapsedMs / 60000);
    if (minutes < 1) duration = '<1m';
    else if (minutes < 60) duration = `${minutes}分钟`;
    else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      duration = mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
    }
  }

  let appName = '--';
  if (isMonitoring && cur) {
    appName = cur.idle ? '空闲中' : cur.app;
  }

  floatWindow.webContents.send('float-update', {
    appName,
    duration,
    isMonitoring
  });
}

function showTodaySummary() {
  const summaries = storageManager.getTodaySummaries();
  if (summaries.length > 0) {
    // Open the summaries_md folder so user can see today's markdown files
    const { shell } = require('electron');
    const mdDir = path.join(storageManager.getDataDir(), 'summaries_md');
    if (fs.existsSync(mdDir)) {
      shell.openPath(mdDir);
    } else {
      shell.openPath(storageManager.getDataDir());
    }
  } else {
    if (mainWindow) {
      mainWindow.webContents.send('log-message', '今日暂无摘要');
    }
  }
}

async function generateCurrentSummary() {
  try {
    await summarizer.generateSummary();
    if (mainWindow) {
      mainWindow.webContents.send('summary-generated');
    }
    showTodaySummary();
  } catch (error) {
    console.error('生成摘要失败:', error);
    if (mainWindow) {
      mainWindow.webContents.send('error-message', '生成摘要失败: ' + error.message);
    }
  }
}

function openDataFolder() {
  const { shell } = require('electron');
  shell.openPath(storageManager.getDataDir());
}

function toggleMonitoring() {
  isMonitoring = !isMonitoring;
  
  if (isMonitoring) {
    startMonitoring();
  } else {
    stopMonitoring();
  }
  
  updateTrayMenu();
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '查看今日摘要', click: () => showTodaySummary() },
    { label: '生成当前摘要', click: () => generateCurrentSummary() },
    { label: '打开数据文件夹', click: () => openDataFolder() },
    { type: 'separator' },
    { 
      label: isMonitoring ? '暂停记录' : '开始记录',
      click: () => toggleMonitoring() 
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]);
  
  tray.setContextMenu(contextMenu);
}

async function runAutomaticReview(intervalMinutes) {
  if (autoReviewBusy || !isMonitoring) return;
  autoReviewBusy = true;
  try {
    activityRecorder.flush();
    if (activityRecorder.getStatus().pendingRecords > 0) return;
    const stateFile = path.join(storageManager.getDataDir(), 'ai', 'review-state.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { /* first run */ }
    // 当前前台片段尚未落盘；只处理它开始之前的稳定区间，避免把未保存的活动当作空白跳过。
    const liveSince = activityRecorder.getStatus().current?.since;
    const boundary = liveSince ? new Date(Math.min(Date.now(), new Date(liveSince).getTime())) : new Date();
    if (!Number.isFinite(boundary.getTime())) return;
    const { start, end } = reviewWindow(previous?.lastEnd, boundary, intervalMinutes);
    if (end <= start) return;
    let cursor = start;
    while (cursor < end) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const next = midnight <= end ? midnight : end;
      const queryEnd = midnight <= end ? new Date(next.getTime() - 1) : next;
      const records = storageManager.getActivitiesByTimeRange(cursor.toISOString(), queryEnd.toISOString())
        .filter(a => a.kind !== 'idle');
      const result = records.length
        ? await summarizer.generateSummaryForRange(cursor.toISOString(), queryEnd.toISOString(), { kind: 'auto' })
        : null;
      // 没有活动也是已处理区间；有活动却没有模型结果时留待下次重试。
      if (records.length && !result) break;
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileAtomic(stateFile, JSON.stringify({ lastEnd: next.toISOString() }));
      if (result && mainWindow) mainWindow.webContents.send('summary-generated');
      cursor = next;
    }
  } catch (error) {
    logManager.addLog('自动回顾失败: ' + error.message, 'error');
  } finally { autoReviewBusy = false; }
}

function startMonitoring() {
  const config = configManager.getConfig();

  logManager.addLog('开始记录', 'info');
  activityRecorder.start();

  // 自动回顾须由用户开启，并且模型配置就绪。
  // 运行时开启插件会由 save-config 重启监控，这里会重新走到这一步。
  if (!config.ai?.enabled || !config.api?.apiKey || !config.summary?.autoGenerate) {
    logManager.addLog('自动回顾未启用或模型未就绪，跳过后台调用', 'info');
    return;
  }

  const schedules = config.summary?.schedules || [];

  if (schedules.length > 0) {
    // 使用调度器模式：每分钟检查是否匹配某个 schedule 的 endTime
    logManager.addLog('已配置 ' + schedules.length + ' 个总结周期', 'info');
    triggeredSchedules = new Set();

    scheduleCheckerInterval = setInterval(async () => {
      const now = new Date();
      const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

      // 午夜清空已触发记录
      if (currentTime === '00:00') {
        triggeredSchedules.clear();
      }

      for (const schedule of schedules) {
        const key = schedule.startTime + '-' + schedule.endTime;
        if (currentTime === schedule.endTime && !triggeredSchedules.has(key)) {
          triggeredSchedules.add(key);
          // 计算回溯分钟数
          const [sh, sm] = schedule.startTime.split(':').map(Number);
          const [eh, em] = schedule.endTime.split(':').map(Number);
          const lookbackMinutes = (eh * 60 + em) - (sh * 60 + sm);
          if (lookbackMinutes > 0) {
            try {
              logManager.addLog(`正在生成 ${schedule.startTime}-${schedule.endTime} 时段摘要...`, 'info');
              const start = new Date(now);
              start.setHours(sh, sm, 0, 0);
              const end = new Date(now);
              end.setHours(eh, em, 0, 0);
              await summarizer.generateSummaryForRange(start.toISOString(), end.toISOString(), { kind: 'auto' });
              logManager.addLog(`${schedule.startTime}-${schedule.endTime} 时段摘要生成成功`, 'info');
              if (mainWindow) {
                mainWindow.webContents.send('summary-generated');
              }
            } catch (error) {
              logManager.addLog(`${schedule.startTime}-${schedule.endTime} 时段摘要生成失败: ` + error.message, 'error');
            }
          }
        }
      }
    }, 60 * 1000);
  } else {
    // 无调度配置，使用原有 intervalMinutes 定时器
    const summaryIntervalMinutes = config.summary?.intervalMinutes || 60;
    if (summaryIntervalMinutes > 0) {
      const summaryIntervalTime = summaryIntervalMinutes * 60 * 1000;
      logManager.addLog('摘要间隔: ' + summaryIntervalMinutes + '分钟', 'info');

      summaryInterval = setInterval(() => runAutomaticReview(summaryIntervalMinutes), summaryIntervalTime);
    }
  }
}

function stopMonitoring() {
  logManager.addLog('停止记录', 'info');

  activityRecorder.stop();

  if (summaryInterval) {
    clearInterval(summaryInterval);
    summaryInterval = null;
  }
  if (scheduleCheckerInterval) {
    clearInterval(scheduleCheckerInterval);
    scheduleCheckerInterval = null;
  }
  logManager.addLog('记录已暂停', 'info');
}

function quitApp() {
  app.isQuitting = true;
  stopMonitoring();
  didaSync.stop();
  try {
    apiServer.stop();
  } catch (e) { /* ignore */ }
  if (mainWindow) {
    mainWindow.destroy();
  }
  app.quit();
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

app.whenReady().then(() => {
  logManager.addLog('应用程序启动中...', 'info');

  // 把已存在的明文密钥加密。失败不阻断启动——只是继续用明文并记一条提示。
  // 必须在创建窗口之前做，否则窗口里可能拿到尚未迁移的配置。
  try {
    const encryption = configManager.migratePlaintextSecrets();
    if (encryption.status === 'migrated') {
      logManager.addLog(`已加密 ${encryption.migrated} 个密钥`, 'info');
    } else if (encryption.status === 'unavailable') {
      logManager.addLog('系统未提供安全凭据存储，密钥以明文保存', 'error');
    } else if (!encryption.ok) {
      logManager.addLog(`密钥加密失败（${encryption.status}），已保留原始配置`, 'error');
    }
  } catch (error) {
    logManager.addLog(`密钥加密流程异常: ${error.message}`, 'error');
  }

  try {
    const merged = planManager.mergeLegacyOvernightPlans();
    if (merged) logManager.addLog(`已合并 ${merged} 组旧版跨日计划，并备份原计划文件`, 'info');
  } catch (error) {
    logManager.addLog(`旧版跨日计划合并失败: ${error.message}`, 'error');
  }
  createWindow();
  logManager.addLog('主窗口已创建', 'info');
  createTray();
  logManager.addLog('托盘图标已创建', 'info');

  // 自动开始记录
  isMonitoring = true;
  startMonitoring();
  updateTrayMenu();
  logManager.addLog('已自动开始记录', 'info');

  // 启动本地数据接口
  startBridge();

  // 滴答同步插件：按各自间隔调度拉取 / 推送（推送默认关闭）
  didaSync.start();

  // 浮窗计时每秒刷新
  setInterval(() => updateFloatWindow(), 1000);

  // 专注状态机每秒推进
  setInterval(() => {
    const state = focusManager.tick();
    if (state) broadcastFocus(state);
  }, 1000);

  logManager.addLog('应用程序已就绪', 'info');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      logManager.addLog('应用程序激活，重新创建窗口', 'info');
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * 退出前兜底收尾。
 *
 * 正常情况下走 quitApp()，它会停掉录制并落盘。但从菜单、系统关机、
 * 其它进程请求退出这几条路径不一定经过那里，当前片段就会留在内存里。
 * 这里再关一次是幂等的：已经停了就什么都不做。
 */
app.on('before-quit', () => {
  try {
    if (activityRecorder && typeof activityRecorder.stop === 'function') {
      activityRecorder.stop();
    }
  } catch (_) { /* 退出路径上不再抛错 */ }
});

// --- IPC 来源校验 ---
// 必须在任何 ipcMain.handle 之前装上：它包住的是 ipcMain.handle 本身。
// 窗口引用每次现取，因为窗口会被销毁重建。
ipcGuard.install(ipcMain, () => ({ main: mainWindow, focus: focusWindow, float: floatWindow }), {
  onDenied: ({ channel, role, reason }) => {
    logManager.addLog(`拒绝 IPC 调用 ${channel}（来源 ${role || '未知'}，原因 ${reason}）`, 'error');
  }
});

ipcMain.handle('get-config', () => {
  // 只返回脱敏投影：明文密钥不出主进程。
  // 旧实现返回 getConfig()，渲染层读一次就拿到了 apiKey 与滴答 token。
  return configManager.getSafeConfig();
});

ipcMain.handle('get-provider-presets', () => {
  return Summarizer.getProviderPresets();
});

// --- 滴答清单同步插件 ---
ipcMain.handle('dida-status', () => didaSync.status());

// 设置页选推送目标清单用：返回账号下的清单列表（带 10 分钟缓存）
ipcMain.handle('dida-projects', async (event, payload) => {
  return didaSync.listProjects({ force: !!(payload && payload.force) });
});

ipcMain.handle('dida-sync-now', async (event, payload) => {
  if (payload?.direction && payload.direction !== 'push') return { ok: false, reason: '滴答仅支持单向推送' };
  return didaSync.push({ manual: true });
});

/**
 * 主动清除密钥。
 *
 * 为什么需要独立通道：渲染层拿到的是脱敏投影，密钥字段恒为空串，
 * 传空串无法表达「我要清除」。给一个显式动作，语义清楚也可审计——
 * 日志里能看出「用户点了清除」，而不是「保存了一次配置」。
 */
ipcMain.handle('clear-secret', (event, payload) => {
  const which = payload && payload.which;
  if (which === 'apiKey') {
    const ok = configManager.clearApiKey();
    if (ok) logManager.addLog('已清除 API Key', 'info');
    return { ok };
  }
  if (which === 'didaToken') {
    const ok = configManager.clearDidaToken();
    if (ok) logManager.addLog('已清除滴答 API 口令', 'info');
    return { ok };
  }
  return { ok: false, error: '未知的密钥类型' };
});

ipcMain.handle('save-config', async (event, config) => {
  const prev = configManager.getConfig();
  const prevPath = prev.storage?.customPath || '';
  const didaJustEnabled = !prev.dida?.enabled && !!config.dida?.enabled;
  const nextPath = config.storage?.customPath || '';
  const storageChanged = nextPath !== prevPath;

  // 改数据目录前同样要预检（与 migrate-storage 同一套判断）。
  // 这条路径更隐蔽：用户可能只是改了个开关，顺手把路径也换了，
  // 若新目录是云端占位文件，接下来每次读都会卡住界面。
  if (storageChanged && nextPath) {
    const precheck = await storagePrecheck.checkStorageDirAsync(nextPath);
    if (!precheck.ok) {
      return {
        success: false,
        // 明确说明是拒绝切换，而不是笼统的「保存失败」——
        // 后者会让用户反复重试同一个目录
        error: `数据目录不可用：${precheck.message}`,
        code: precheck.reason
      };
    }
  }

  // 先把录制器的当前片段写回旧目录，再切换路径。
  if (isMonitoring) stopMonitoring();
  if (storageChanged) {
    const result = storageManager.setDataDir(nextPath);
    if (!result.success || !logManager.setDataDir(nextPath) || !arhatManager.setDataDir(nextPath)) {
      storageManager.setDataDir(prevPath);
      logManager.setDataDir(prevPath);
      arhatManager.setDataDir(prevPath);
      if (isMonitoring) startMonitoring();
      return { success: false, error: result.error || '目录切换失败' };
    }
  }
  if (!configManager.saveConfig(config)) {
    if (storageChanged) {
      storageManager.setDataDir(prevPath);
      logManager.setDataDir(prevPath);
      arhatManager.setDataDir(prevPath);
    }
    if (isMonitoring) startMonitoring();
    return { success: false, error: '配置保存失败' };
  }
  summarizer.updateConfig(config);
  if (storageChanged) logManager.addLog(`数据目录已切换为: ${nextPath || '默认路径'}`, 'info');

  if (didaJustEnabled && config.dida?.pushEnabled && config.dida?.pushProjectId && config.dida?.token) {
    setTimeout(() => { didaSync.push({ manual: false }).catch(() => {}); }, 300);
  }

  // 重启监控定时器以使新配置生效
  if (isMonitoring) {
    startMonitoring();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', config);
    // 窗口底色只在创建时设过一次，换肤时同步，避免浅色/深色切换闪一下
    mainWindow.setBackgroundColor(config.ui?.mode === 'light' ? '#f7f8fa' : '#0b0c0e');
    if (storageChanged) {
      mainWindow.webContents.send('storage-path-changed', storageManager.getDataDir());
    }
  }

  if (floatWindow) {
    floatWindow.webContents.send('float-theme', { mode: config.ui?.mode || 'dark', surface: config.ui?.surface || 'nocturne' });
    floatWindow.webContents.send('float-accent', accentCss(config.ui || {}));
  }

  // 专注 HUD 是懒创建窗口：此刻可能还不存在，创建时会再推一次当前主题
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.webContents.send('focus-theme', { mode: config.ui?.mode || 'dark', surface: config.ui?.surface || 'nocturne' });
  }

  return { success: true };
});

// ---------------------------------------------------------------------------
// 展示层（人工标注层）可以改、可以删；记录层（自动录制）一律拒绝。
// 这条边界由主进程把关，前端无论传什么都不会改到原始采样。
// ---------------------------------------------------------------------------
function notifyDataChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 渲染层的 data-changed 会做全量重载（report / activities / 有数据的日期 /
    // 热力图 / 摘要）。之前这里误发 summary-generated，只重拉 report，
    // 导致「计划转为事实」后记录层、日期集合与热力图都不刷新，
    // 看起来像计划没有合并进展示层。
    mainWindow.webContents.send('data-changed');
  }
}

ipcMain.handle('update-display-record', (event, payload) => {
  const { date, t, patch } = payload || {};
  if (!date || !t) return { success: false, error: '参数不完整' };
  const res = callStorage(() => storageManager.updateDisplayRecord(date, t, patch || {}), 'success');
  if (res.success) notifyDataChanged();
  return res;
});

ipcMain.handle('delete-display-record', (event, payload) => {
  const { date, t } = payload || {};
  if (!date || !t) return { success: false, error: '参数不完整' };
  const res = callStorage(() => storageManager.deleteDisplayRecord(date, t), 'success');
  if (res.success) notifyDataChanged();
  return res;
});

ipcMain.handle('delete-display-range', (event, payload) => {
  const { date, start, end } = payload || {};
  if (!date || !start || !end) return { success: false, error: '参数不完整' };
  const res = callStorage(() => storageManager.deleteDisplayRange(date, start, end), 'success');
  if (res.success) notifyDataChanged();
  return res;
});

// 专注属于标注层：本人发起、写错了要能删
ipcMain.handle('delete-focus-session', (event, payload) => {
  const { date, id } = payload || {};
  if (!date || !id) return { success: false, error: '参数不完整' };
  const res = arhatManager.deleteSession(date, id);
  if (res.success) notifyDataChanged();
  return res;
});

ipcMain.handle('update-focus-session', (event, payload) => {
  const { date, id, focusText, note } = payload || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !id) return { success: false, error: '参数不完整' };
  const res = String(id).startsWith('dida:')
    ? arhatManager.updateImportedFocus(date, id, { focusText, note })
    : arhatManager.updateSession(date, id, { focusText, note });
  if (res.success) notifyDataChanged();
  return res;
});

ipcMain.handle('update-focus-note', (event, payload) => {
  const { date, id, text } = payload || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !id) return { success: false, error: '参数不完整' };
  const res = arhatManager.updateNote(date, id, text);
  if (res.success) notifyDataChanged();
  return res;
});

ipcMain.handle('get-activities', (event, date) => {
  return storageManager.getActivities(date);
});

// --- 聚合统计（前端与 AI 接口共用同一套口径） ---

ipcMain.handle('get-day-analytics', async (event, date) => {
  try {
    const dateStr = date || analytics.toDateStr(new Date());
    // 报表计算放到 worker 线程：读文件是这里唯一可能长时间阻塞的操作，
    // 放在主进程会连带冻住所有窗口（尤其在云端目录上）。
    // 失败或超时会回退到同步计算，并如实标记 degraded——不返回空报告。
    const { report, degraded, reason } = await reportRunner.buildDayReportSafe(
      storageManager.getDataDir(),
      dateStr,
      configManager.getConfig().analysis,
      { onLog: (msg, level) => logManager.addLog(msg, level) }
    );
    // 计划层只是意图参考，不进入 analytics 的实际工时和来源优先级计算。
    // 计划已全部本地化：不再合并滴答《记录》的只读计划。
    report.plan = planManager.listForDate(dateStr);
    return {
      ok: true,
      report,
      markdown: analytics.renderDayMarkdown(report, 'normal'),
      degraded,
      degradedReason: degraded ? reason : undefined
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('save-local-plan', (event, payload) => {
  try {
    const result = planManager.upsert(payload || {});
    if (result.ok) notifyDataChanged();
    return result;
  } catch (error) {
    return { ok: false, error: error.message || '保存计划失败' };
  }
});

ipcMain.handle('delete-local-plan', (event, payload) => {
  try {
    const result = planManager.remove(String(payload?.localId || ''));
    if (result.ok) notifyDataChanged();
    return result;
  } catch (error) {
    return { ok: false, error: error.message || '删除计划失败' };
  }
});

/**
 * 计划变为事实有两条路径：
 * 1. plan   —— 用户确认“就按计划记”，写一条人工事实；
 * 2. screen —— 复用已经存在的屏幕活动，只给计划挂上识别结果，不复制工时。
 */
ipcMain.handle('convert-plan-to-fact', async (event, payload) => {
  try {
    const plan = payload?.plan || {};
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date || '')) ? payload.date : '';
    const mode = payload?.mode === 'screen' ? 'screen' : 'plan';
    if (!date || !Number.isFinite(Number(plan.startMin)) || !Number.isFinite(Number(plan.durationMin))) {
      return { ok: false, error: '计划时间无效' };
    }

    if (mode === 'screen') {
      const { report } = await reportRunner.buildDayReportSafe(
        storageManager.getDataDir(), date, configManager.getConfig().analysis,
        { onLog: (msg, level) => logManager.addLog(msg, level) }
      );
      const endMin = Number(plan.endMin) || Number(plan.startMin) + Number(plan.durationMin);
      const matches = (report.activityThreads || []).map(thread => {
        const start = Number(thread.startMin) || 0;
        const end = start + (Number(thread.durationMs) || 0) / 60000;
        return { thread, overlap: Math.max(0, Math.min(endMin, end) - Math.max(Number(plan.startMin), start)) };
      }).filter(item => item.overlap >= 5).sort((a, b) => b.overlap - a.overlap);
      if (!matches.length) return { ok: false, error: '该计划时段还没有足够的屏幕活动可生成事实' };
      const top = matches[0].thread;
      const covered = matches.reduce((sum, item) => sum + item.overlap, 0);
      const marked = planManager.markActual(plan, date, {
        source: 'screen', label: top.label, category: top.group || top.category,
        startMin: Number(plan.startMin), durationMin: Math.min(Number(plan.durationMin), covered)
      });
      notifyDataChanged();
      return { ok: true, actual: marked.actual };
    }

    const parsed = manualRecordFromPayload({
      date,
      startTime: `${String(Math.floor(Number(plan.startMin) / 60)).padStart(2, '0')}:${String(Number(plan.startMin) % 60).padStart(2, '0')}`,
      durationMin: plan.durationMin,
      app: plan.label || plan.title || '计划',
      note: plan.label || plan.title || '',
      category: plan.category || '其他',
      project: plan.project || ''
    });
    if (parsed.error) return { ok: false, error: parsed.error };
    parsed.record.platform = 'plan';
    parsed.record.origin = 'plan';
    parsed.record.groupId = crypto.randomUUID();
    // rid 标识单条记录，与 groupId（一次操作的多段分组）不同层
    if (!parsed.record.rid) parsed.record.rid = crypto.randomUUID();
    parsed.record.planKey = planManager.keyOf(plan, date);
    let ok;
    try {
      ok = storageManager.appendActivityRecords(splitRecordAtMidnight(parsed.record));
    } catch (error) {
      return writeFailure(error);
    }
    if (!ok) return { ok: false, error: '计划转为事实时写入失败' };
    const marked = planManager.markActual(plan, date, {
      source: 'plan', label: plan.label || plan.title, category: plan.category,
      startMin: Number(plan.startMin), durationMin: Number(plan.durationMin)
    });
    notifyDataChanged();
    return { ok: true, actual: marked.actual };
  } catch (error) {
    return { ok: false, error: error.message || '计划转为事实失败' };
  }
});

ipcMain.handle('get-known-apps', async () => {
  const analysis = configManager.getConfig().analysis || {};
  const classify = analytics.buildClassifier(analysis.categoryRules);
  const apps = await analytics.listRecordedAppsAsync(storageManager.getDataDir(), analysis);
  return apps.map(app => ({
    ...app,
    inferredCategory: classify(app.name, ''),
    mappedCategory: analysis.appCategoryMap?.[app.key] || ''
  }));
});

ipcMain.handle('get-annotation-suggestions', (event, payload) => {
  try {
    const date = payload?.date;
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : analytics.toDateStr(new Date());
    const from = new Date(`${dateStr}T00:00:00`);
    from.setDate(from.getDate() - 90);
    const records = storageManager.getActivitiesByDateRange(from, new Date(`${dateStr}T23:59:59`));
    const slots = Array.isArray(payload?.slots) ? payload.slots.slice(0, 96) : [];
    const dismissed = new Set(configManager.getConfig().advice?.dismissed || []);
    return categorySuggestions(records, slots, 12).filter(s =>
      !dismissed.has(`${dateStr}:${s.startMin}:${s.app}:${s.category}`)).slice(0, 3);
  } catch (error) {
    logManager.addLog('生成标注建议失败: ' + error.message, 'error');
    return [];
  }
});

ipcMain.handle('dismiss-annotation-suggestion', (event, payload) => {
  const { date, startMin, app, category } = payload || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(startMin) ||
      startMin < 0 || startMin >= 1440 || !app || !category) return false;
  const existing = configManager.getConfig().advice?.dismissed || [];
  const key = `${date}:${startMin}:${app}:${category}`;
  const saved = configManager.updateConfig({ advice: { dismissed: [...new Set([...existing, key])].slice(-200) } });
  if (saved) broadcast('config-updated', configManager.getConfig());
  return saved;
});

ipcMain.handle('get-range-analytics', (event, payload) => {
  try {
    const to = (payload && payload.to) || analytics.toDateStr(new Date());
    const from = (payload && payload.from) || analytics.toDateStr(
      new Date(new Date(to + 'T00:00:00').getTime() - 6 * 86400000)
    );
    const report = analytics.buildRangeReport(storageManager.getDataDir(), from, to, configManager.getConfig().analysis);
    return { ok: true, report, markdown: analytics.renderRangeMarkdown(report, 'normal') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// 热力图专用：逐日全部已记录时长，包含生活与睡眠。
ipcMain.handle('get-daily-tracked', (event, payload) => {
  try {
    const p = payload || {};
    const to = p.to || analytics.toDateStr(new Date());
    const from = p.from || analytics.toDateStr(
      new Date(new Date(to + 'T00:00:00').getTime() - 83 * 86400000)
    );
    const days = analytics.buildDailyTrackedMs(storageManager.getDataDir(), from, to, configManager.getConfig().analysis);
    return { ok: true, from, to, days, generatedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: error.message, days: [] };
  }
});

ipcMain.handle('get-recorder-status', () => {
  return activityRecorder.getStatus();
});

/**
 * 历史备注候选：写备注时给出以前用过的说法，可直接复用。
 * 默认只回看最近一年，避免每次翻全量历史。
 */
ipcMain.handle('find-note-hints', (event, payload) => {
  try {
    const p = payload || {};
    const to = p.to || analytics.toDateStr(new Date());
    const days = Math.max(1, Math.min(365, Number(p.days) || 365));
    const from = p.from || analytics.toDateStr(
      new Date(new Date(to + 'T00:00:00').getTime() - days * 86400000)
    );
    const result = analytics.findNoteHints(
      storageManager.getDataDir(), p.keyword, from, to,
      { ...(configManager.getConfig().analysis || {}), app: p.app || '', category: p.category || '' }
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message, hints: [] };
  }
});

// 手工补记与编辑共用同一套 15 分钟校验，避免两个入口写出不同口径。
function manualRecordFromPayload(payload) {
  const p = payload || {};
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '')
    ? p.date
    : analytics.toDateStr(new Date());

  const rawDuration = parseInt(p.durationMin, 10);

  // 吸附规则只在 slotRule 里实现一次。这里不再自己算 round/floor——
  // 之前正是因为起点向下、时长就近两套策略并存，同一个输入在不同入口
  // 会得到不同结果。
  //
  // snapRange 用**原始**时长判定最短 15 分钟：先吸附再判定的话，
  // 3 分钟会被吸附成 15 分钟，判定就再也拦不住了。
  const snapped = slotRule.snapRange(dateStr, p.startTime, rawDuration);
  if (snapped.rejected) {
    return { error: snapped.message, reason: snapped.reason };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(
    `${dateStr}T${pad(Math.floor(snapped.startMin / 60))}:${pad(snapped.startMin % 60)}:00`
  );
  if (Number.isNaN(start.getTime())) {
    return { error: '时间无法解析' };
  }
  const durationMin = snapped.durationMin;
  const appName = String(p.app || '手工标注').trim() || '手工标注';
  const remark = String(p.note ?? p.title ?? '').trim() ||
    (!['手工标注', '手工记录'].includes(appName) ? appName : '');
  return { dateStr, durationMin, snapped, record: {
    t: start.toISOString(),
    dur: durationMin * 60000,
    kind: 'active',
    app: appName,
    title: remark,
    platform: 'manual',
    source: 'manual',
    cat: p.category || '',
    project: String(p.project || '').trim().slice(0, 60)
  } };
}

// 手工补记：录制器漏掉的时段，由用户补上
ipcMain.handle('add-manual-record', (event, payload) => {
  const parsed = manualRecordFromPayload(payload);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { dateStr, durationMin, record, snapped } = parsed;

  // 重叠检测（方案 §5.4）。
  //
  // 与**自动记录**重叠是补记的正当用途——用户就是要在录制器漏掉的时段补一条，
  // 而录制器其实录到了。这种情况只提示，不阻断。
  //
  // 与**另一条人工记录**重叠则大概率是重复记录，默认阻断，让用户自己改时间。
  //
  // 无论哪种，都只是「不写」或「照写」，**绝不改动已有的记录层采样**。
  // 补记写的是展示层标注，记录层逐字节保持原样。
  let overlaps = [];
  try {
    const dayRecords = storageManager.getActivities(new Date(`${dateStr}T12:00:00`));
    overlaps = slotRule.findOverlaps(dateStr, snapped.startMin, snapped.endMin, dayRecords);
  } catch (_) {
    overlaps = [];   // 读不到当日记录就不做重叠判断，不因此阻断补记
  }

  const manualConflicts = overlaps.filter(o => o.kind === 'display' && o.source === 'manual');
  if (manualConflicts.length && !payload?.allowOverlap) {
    const first = manualConflicts[0].record;
    return {
      ok: false,
      error: `该时段与已有的人工记录重叠（${first.processName || '手工标注'}，` +
        `重叠 ${manualConflicts[0].overlapMin} 分钟），请调整时间后再保存`,
      code: 'OVERLAP_MANUAL',
      overlaps: manualConflicts.map(o => ({ overlapMin: o.overlapMin, app: o.record.processName }))
    };
  }

  record.groupId = crypto.randomUUID();
  if (!record.rid) record.rid = crypto.randomUUID();
  let ok;
  try {
    ok = storageManager.appendActivityRecords(splitRecordAtMidnight(record));
  } catch (error) {
    return writeFailure(error);
  }

  if (ok) {
    logManager.addLog(`手工补记 ${dateStr} ${payload.startTime} · ${durationMin} 分钟`, 'info');
  }
  return {
    ok,
    error: ok ? null : '写入失败',
    durationMin,
    snapped: {
      start: snapped.start,
      end: snapped.end,
      durationMin: snapped.durationMin,
      distorted: snapped.distorted,
      rawDurationMin: snapped.rawDurationMin
    },
    // 与自动记录重叠：如实告知，但已经写入
    autoOverlaps: overlaps
      .filter(o => o.kind === 'record')
      .map(o => ({ overlapMin: o.overlapMin, app: o.record.processName }))
  };
});

/**
 * 吸附预览。只读，不写任何数据。
 *
 * 渲染层不能 require electron/slotRule（那是主进程模块），但显示「将保存为
 * 09:00—10:45，共 105 分钟」又必须与真正落盘的结果完全一致。所以让渲染层
 * 问主进程要结果——同一份代码、同一次计算，前端拿到的就是最终会写进去的。
 *
 * 若让前端自己复刻一份四舍五入，迟早会与后端飘开，而那种偏差只会在
 * 「预览说 105 分，实际存了 90 分」时才被发现，且没有任何报错。
 */
ipcMain.handle('preview-snap', (event, payload) => {
  const p = payload || {};
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : analytics.toDateStr(new Date());
  const rawDuration = parseInt(p.durationMin, 10);
  const result = slotRule.snapRange(dateStr, p.startTime, rawDuration);
  // 重叠检测也一并在主进程做，避免前端再实现一遍区间相交
  if (!result.rejected && Array.isArray(p.records)) {
    result.overlaps = slotRule.findOverlaps(dateStr, result.startMin, result.endMin, p.records)
      .map(o => ({
        index: o.index,
        overlapMin: o.overlapMin,
        kind: o.kind,
        source: o.source,
        app: o.record && o.record.processName,
        title: o.record && o.record.windowTitle
      }));
  }
  return result;
});

ipcMain.handle('replace-display-ranges', (event, payload) => {
  const parsed = manualRecordFromPayload(payload?.record);
  if (parsed.error) return { ok: false, error: parsed.error };
  const ranges = payload?.ranges || [];
  // 上限放宽到 200 段：「当天同应用全部同步」会一次覆盖该应用的多个时段。
  // 相邻区间不能重叠，否则前一次写的标注会被后一次删掉。
  if (!Array.isArray(ranges) || ranges.length > 200 ||
      payload?.record?.date !== parsed.dateStr) return { ok: false, error: '日期或区间无效' };
  parsed.record.groupId = crypto.randomUUID();
  if (!parsed.record.rid) parsed.record.rid = crypto.randomUUID();
  const result = callStorage(
    () => storageManager.replaceDisplayRanges(parsed.dateStr, ranges, parsed.record), 'success');
  if (result.success) notifyDataChanged();
  return { ok: result.success, code: result.code, error: result.error };
});

/**
 * 把某一天里某个应用的所有时段改成同一分类。
 * 记录层不可改，所以通过展示层覆盖实现：用户自己写的标注就地改分类，
 * 自动录制占用的时段写覆盖标注，别的应用不动。
 */
ipcMain.handle('recategorize-app-for-day', (event, payload) => {
  const p = payload || {};
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : analytics.toDateStr(new Date());
  const app = String(p.app || '').trim();
  const category = String(p.category || '').trim();
  if (!app || !category) return { ok: false, error: '缺少应用或分类' };
  const spans = Array.isArray(p.spans) ? p.spans : [];
  if (!spans.length) return { ok: false, error: '当天没有找到该应用的其它时段' };
  const result = callStorage(
    () => storageManager.recategorizeAppForDay(dateStr, app, category, spans, String(p.note || '')), 'success');
  if (result.success) notifyDataChanged();
  return { ok: result.success, error: result.error, ...result };
});

ipcMain.handle('flush-recorder', () => {
  const n = activityRecorder.flush();
  return { flushed: n };
});

ipcMain.handle('get-summaries', (event, date) => {
  return storageManager.getSummaries(date);
});

ipcMain.handle('get-ai-usage', () => ({
  ...summarizer.getUsageStats(),
  next: summarizer.estimateNextReview(configManager.getConfig().summary?.intervalMinutes || 60)
}));

ipcMain.handle('suggest-categories', async () => {
  try {
    const config = configManager.getConfig();
    if (!config.ai?.enabled) throw new Error('请先开启 AI 能力');
    const windows = [];
    for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
      const day = new Date();
      day.setDate(day.getDate() - daysAgo);
      const report = analytics.buildDayReport(storageManager.getDataDir(), analytics.toDateStr(day), config.analysis);
      for (const item of report.recordedWindows || []) {
        if (item.title && !windows.some(w => w.title === item.title)) windows.push(item);
      }
    }
    if (!windows.length) return { ok: true, categories: [], mappings: [] };
    windows.sort((a, b) => b.durationMs - a.durationMs);
    const existing = (config.analysis?.customCategories || []).map(c => c.key || c.name);
    const choices = ['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他', ...existing];
    const prompt = `分析最近窗口标题，提出最多 3 个新分类和最多 5 条对现有分类的应用映射建议。已有分类：${choices.join('、')}。同一应用用途多变时，只能建议具体窗口关键词映射，不能把整个应用固定为一种活动。\n只返回 JSON 对象：{"categories":[{"name":"2-6字中文名称","color":"#六位十六进制颜色","group":"工作/学习/生活/娱乐/睡眠/专注/其他之一","reason":"简短证据"}],"mappings":[{"app":"原样应用名","category":"已有分类之一","titleContains":"可选的窗口标题关键词，整个应用通用时留空","reason":"简短证据"}]}。没有建议就使用空数组，不要 Markdown。\n窗口：${JSON.stringify(windows.slice(0, 25).map(w => ({ title: String(w.title).slice(0, 90), app: w.app, minutes: Math.round(w.durationMs / 60000) })))}`;
    const raw = await summarizer.callAI(prompt);
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const categories = (Array.isArray(parsed.categories) ? parsed.categories : []).filter(c =>
      c && typeof c.name === 'string' && /^[\u4e00-\u9fa5]{2,6}$/.test(c.name) &&
      /^#[0-9a-fA-F]{6}$/.test(c.color) && !['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他', ...existing].includes(c.name)
    ).slice(0, 3).map(c => ({ name: c.name, color: c.color,
      group: ['工作', '学习', '生活', '娱乐', '睡眠', '专注', '其他'].includes(c.group) ? c.group : '其他',
      reason: String(c.reason || '').slice(0, 30) }));
    const seenApps = new Set(windows.map(w => String(w.app || '').toLowerCase()));
    const mappings = (Array.isArray(parsed.mappings) ? parsed.mappings : []).filter(m =>
      m && seenApps.has(String(m.app || '').toLowerCase()) && choices.includes(m.category) &&
      String(m.titleContains || '').length <= 60 &&
      (!m.titleContains || String(m.titleContains).trim().length >= 2) &&
      (!m.titleContains || windows.some(w =>
        String(w.app).toLowerCase() === String(m.app).toLowerCase() &&
        String(w.title).toLowerCase().includes(String(m.titleContains).toLowerCase())))
    ).slice(0, 5).map(m => ({
      app: String(m.app), category: m.category,
      titleContains: String(m.titleContains || '').trim(), reason: String(m.reason || '').slice(0, 40)
    }));
    return { ok: true, categories, mappings };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('generate-summary', async () => {
  return await summarizer.generateSummary();
});

ipcMain.handle('generate-summary-range', async (event, { startTime, endTime }) => {
  return await summarizer.generateSummaryForRange(startTime, endTime);
});

ipcMain.handle('toggle-monitoring', () => {
  toggleMonitoring();
  if (floatWindow) {
    floatWindow.webContents.send('float-monitoring-status', isMonitoring);
  }
  if (mainWindow) {
    mainWindow.webContents.send('monitoring-status-changed', isMonitoring);
  }
  return isMonitoring;
});

ipcMain.handle('get-monitoring-status', () => {
  return isMonitoring;
});

// 贴边窗格：把主窗口压成屏幕一侧的竖条，方便一边看记录一边干活。
// 再点一次恢复原来的位置和大小。
let snappedBounds = null;
let snapWasMaximized = false;

ipcMain.handle('toggle-snap', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  if (snappedBounds) {
    mainWindow.setBounds(snappedBounds);
    snappedBounds = null;
    if (snapWasMaximized) { mainWindow.maximize(); snapWasMaximized = false; }
    return { success: true, snapped: false };
  }
  // 最大化状态下 setBounds 会被忽略，必须先还原成普通窗口
  snapWasMaximized = mainWindow.isMaximized();
  if (snapWasMaximized) mainWindow.unmaximize();
  snappedBounds = mainWindow.getBounds();
  const width = Math.max(360, Math.min(560, Math.round(area.width * 0.26)));
  mainWindow.setBounds({
    x: area.x + area.width - width,
    y: area.y,
    width,
    height: area.height
  });
  return { success: true, snapped: true };
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) {
    mainWindow.hide();
    const config = configManager.getConfig();
    if (config.ui?.floatWindow !== false) {
      if (floatWindow) {
        floatWindow.show();
      } else {
        createFloatWindow();
      }
      updateFloatWindow();
    }
  }
});

ipcMain.handle('show-main-window', () => {
  showMainWindow();
});

ipcMain.handle('get-float-bounds', () => {
  if (floatWindow) return floatWindow.getBounds();
  return { width: 220, x: 0, y: 0 };
});

ipcMain.handle('set-float-pos', (event, x, y) => {
  if (floatWindow) {
    floatWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: floatSize.width, height: floatSize.height });
  }
});

ipcMain.handle('set-float-width', (event, w) => {
  if (floatWindow) {
    const bounds = floatWindow.getBounds();
    floatSize.width = w;
    floatWindow.setBounds({ x: bounds.x, y: bounds.y, width: w, height: floatSize.height });
  }
});

ipcMain.handle('save-float-width', () => {
  if (floatWindow) {
    configManager.updateConfig({ ui: { floatWidth: floatSize.width } });
  }
});

ipcMain.handle('get-logs', () => {
  return logManager.getLogs();
});

ipcMain.handle('add-log', (event, message, type) => {
  return logManager.addLog(message, type);
});

ipcMain.handle('clear-logs', () => {
  logManager.clearLogs();
  return true;
});

ipcMain.handle('open-logs-folder', () => {
  const { shell } = require('electron');
  shell.openPath(logManager.logsDir);
});

/**
 * 渲染层请求打开外部链接。
 *
 * A2 只做「不收任意协议」的最小校验；完整白名单（含桥接端口精确匹配）
 * 在 B2 实现。这里先把能力从渲染层收到主进程——
 * 一旦渲染层还能直接调 shell.openExternal，B2 的白名单就形同虚设。
 */
/**
 * 渲染层请求打开外部链接。
 *
 * A2 时只做了「不收任意协议」的最小校验；这里补上完整白名单：
 *   · 本机桥接地址：http + 回环主机 + **当前实际端口**，精确匹配
 *   · 其他链接：只允许 https
 *
 * 端口从 apiServer 现取，不从渲染层传。前端传端口等于让渲染层
 * 自己决定白名单，那这道校验就只剩装饰作用了。
 */
ipcMain.handle('open-external', (event, url) => {
  const status = apiServer.getStatus();
  const verdict = externalLink.check(url, { localPort: status.running ? status.port : null });
  if (!verdict.ok) {
    logManager.addLog(`拒绝打开外部链接（${verdict.reason}）`, 'info');
    return { ok: false, reason: verdict.reason };
  }
  const { shell } = require('electron');
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('export-data', async (event, { filename, content }) => {
  const { dialog, shell } = require('electron');
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf8');
    shell.showItemInFolder(result.filePath);
    return true;
  }
  return false;
});

ipcMain.handle('export-full-data', async (event, format) => {
  const { dialog, shell } = require('electron');

  if (format === 'csv') {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `worklog_export_${new Date().toISOString().split('T')[0]}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return false;

    const activities = storageManager.getAllActivities();
    let csv = 'timestamp,processName,windowTitle\n';
    activities.forEach(a => {
      const ts = a.timestamp || '';
      const proc = (a.processName || '').replace(/"/g, '""');
      const win = (a.windowTitle || '').replace(/"/g, '""');
      csv += `"${ts}","${proc}","${win}"\n`;
    });
    fs.writeFileSync(result.filePath, '\uFEFF' + csv, 'utf8');
    shell.showItemInFolder(result.filePath);
    logManager.addLog('数据已导出为 CSV', 'info');
    return true;
  }

  // JSON full export
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `worklog_full_export_${new Date().toISOString().split('T')[0]}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return false;

  const data = {
    version: app.getVersion(),
    exportDate: new Date().toISOString(),
    activities: storageManager.getAllActivities(),
    summaries: storageManager.getAllSummaries(),
    arhatSessions: arhatManager._getAllFromDir(arhatManager.sessionsDir),
    arhatNotes: arhatManager.getAllNotes(),
    config: configManager.getConfig()
  };
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  shell.showItemInFolder(result.filePath);
  logManager.addLog('完整数据已导出为 JSON', 'info');
  return true;
});

ipcMain.handle('import-data', async (event, mode) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择导入文件（JSON）或数据目录',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile', 'openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  const selected = result.filePaths[0];

  try {
    // 选中的是「原生数据目录」（例如另一台机器同步到 iCloud 的 Data）：
    // 它本来就是应用自己的格式（activities/2026-02-15.json 等），
    // 直接切换过去即可，不需要逐条解析，也不会覆盖或清空任何现有数据。
    if (fs.existsSync(selected) && fs.statSync(selected).isDirectory()) {
      const activitiesDir = path.join(selected, 'activities');
      const dateFileRe = /^\d{4}-\d{2}-\d{2}\.(json|jsonl)$/;
      const looksLikeDataDir = fs.existsSync(activitiesDir) ||
        fs.readdirSync(selected).some(f => dateFileRe.test(f));
      if (!looksLikeDataDir) {
        return {
          success: false,
          error: '所选目录不是有效的数据目录（未找到 activities/ 或按日期命名的活动文件）'
        };
      }

      const config = configManager.getConfig();
      config.storage = { ...(config.storage || {}), customPath: selected };
      configManager.saveConfig(config);
      summarizer.updateConfig(config);

      const switched = storageManager.setDataDir(selected);
      if (!switched.success) {
        return { success: false, error: switched.error };
      }
      logManager.setDataDir(selected);
      arhatManager.setDataDir(selected);
      logManager.addLog(`已切换到数据目录: ${selected}`, 'info');

      const scanDir = fs.existsSync(activitiesDir) ? activitiesDir : selected;
      const fileCount = fs.readdirSync(scanDir).filter(f => dateFileRe.test(f)).length;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config-updated', config);
        mainWindow.webContents.send('storage-path-changed', selected);
      }
      return { success: true, importedCount: fileCount, mode: 'directory' };
    }

    // 单个 JSON 文件：原有的「完整导出」格式
    const content = fs.readFileSync(selected, 'utf8');
    const data = JSON.parse(content);

    if (!data.activities && !data.summaries) {
      return { success: false, error: '无效的数据文件格式' };
    }

    // 覆盖模式已删除。它会先清空 activities/ 再导入，一旦导入文件有问题，
    // 用户的历史就只剩快照可救；而多数人是想「把这份备份并进来」，
    // 不是「用这份备份替换掉现在」。合并导入本来就能达到目的。
    if (mode === 'overwrite') {
      return {
        success: false,
        error: '覆盖导入已移除，请使用「合并」。合并不会删除任何现有记录。'
      };
    }

    const plan = importSafety.planImport({
      dataDir: storageManager.getDataDir(),
      sourceJson: data,
      sourceName: path.basename(selected),
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex')
    });

    // 已完整导入过：默认不做任何事，把决定权交给用户
    if (plan.action === 'already-completed') {
      const prev = plan.previousTask;
      return {
        success: false,
        alreadyImported: true,
        fingerprint: plan.fingerprint,
        previousAt: prev ? prev.updatedAt : null,
        message: `该文件已于 ${prev ? new Date(prev.updatedAt).toLocaleString('zh-CN') : '此前'} 导入过，未重复导入。`
      };
    }

    // 导入前快照。快照失败就中止——没有快照就没有退路
    const snap = storageManager.snapshotBeforeImport('import-merge');
    if (!snap.ok) {
      return {
        success: false,
        error: `导入前快照失败，已中止导入以避免无法回退：${snap.error}`
      };
    }

    let outcome;
    try {
      outcome = importSafety.executeImport({
        dataDir: storageManager.getDataDir(),
        storage: storageManager,
        sourceJson: data,
        plan,
        sourceName: path.basename(selected),
        sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex')
      });
    } catch (error) {
      // 中断（崩溃/关窗）时任务文件已留下 imp 痕迹，下次可以「继续」
      return {
        success: false,
        interrupted: true,
        error: `导入中断：${error.message}`,
        snapshotPath: snap.snapshotPath,
        message: '已写入的记录带有批次标记，重新导入时会从断点继续，不会重复。'
      };
    }

    const a = outcome.activities;
    const s = outcome.summaries;
    const parts = [`活动 ${a.succeeded} 条`];
    if (a.skipped) parts.push(`跳过 ${a.skipped} 条（此前已导入）`);
    if (a.failed) parts.push(`失败 ${a.failed} 条`);
    if (s.succeeded) parts.push(`摘要 ${s.succeeded} 条`);
    if (s.skipped) parts.push(`摘要跳过 ${s.skipped} 条`);
    if (s.failed) parts.push(`摘要失败 ${s.failed} 条`);
    if (s.mdFailed) parts.push(`其中 ${s.mdFailed} 条文字版未生成`);

    logManager.addLog(`数据导入完成：${parts.join('，')}`, a.failed || s.failed ? 'warn' : 'info');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-generated');
      mainWindow.webContents.send('data-changed');
    }

    return {
      success: true,
      // 只有全部成功才算真成功。任一失败都要如实告诉用户。
      ok: a.failed === 0 && s.failed === 0,
      importedCount: a.succeeded,
      activities: a,
      summaries: s,
      snapshotPath: snap.snapshotPath,
      warning: outcome.warning,
      mdIncomplete: outcome.mdIncomplete,
      message: parts.join('，')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('select-storage-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择数据存储文件夹'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('migrate-storage', async (event, newPath) => {
  try {
    // 切换前预检（V0.10.5 任务 1）。
    //
    // 为什么必须先查：数据目录指向 iCloud / OneDrive 的「仅在线」文件时，
    // 目录看起来完全正常（列得出文件、大小也对），但每次读内容都会触发云端召回。
    // 数据读取在主进程里同步进行，读一个文件就能让整个界面卡住，
    // 用户看到的是「软件无响应」——然后以为是软件坏了。
    //
    // 预检放在子进程里做，超时直接 kill：如果预检本身卡在云端召回上，
    // 在主进程里做就等于把要防的问题自己做了一遍。
    const precheck = await storagePrecheck.checkStorageDirAsync(newPath);
    if (!precheck.ok) {
      logManager.addLog(`拒绝切换到 ${newPath}：${precheck.message}`, 'error');
      return {
        success: false,
        error: precheck.message,
        code: precheck.reason,
        timedOut: !!precheck.timedOut
      };
    }

    const result = storageManager.migrateDataTo(newPath);
    if (result.success) {
      logManager.addLog(`数据已迁移到 ${newPath}，共 ${result.fileCount} 个文件`, 'info');
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-storage-path', () => {
  return storageManager.getDataDir();
});

// --- Arhat Mode ---

// --- 专注助手 ---

ipcMain.handle('focus-presets', () => {
  return focusManager.getPresets();
});

ipcMain.handle('focus-start', (event, payload) => {
  // 番茄钟插件关闭后，前端入口会隐藏；这里再挡一次，防止 IPC 被绕过
  if (configManager.getConfig().focus?.enabled === false) {
    return { active: false, error: '番茄钟插件已关闭' };
  }
  const { mode, focusText, overrides } = payload || {};
  const state = focusManager.start(mode || 'pomodoro', focusText, overrides);
  createFocusWindow();
  // 专注开始后主窗口自动收起到托盘，只留可拖动的计时小窗
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  broadcastFocus(state);
  return state;
});

/** 记杂念时把 HUD 临时加高一行输入框 */
ipcMain.handle('focus-hud-expand', (event, expanded) => {
  if (!focusWindow || focusWindow.isDestroyed()) return false;
  const b = focusWindow.getBounds();
  const height = expanded ? 86 : 48;
  if (b.height !== height) {
    focusWindow.setBounds({ x: b.x, y: b.y, width: b.width, height });
  }
  return true;
});

ipcMain.handle('focus-toggle-pause', () => {
  const state = focusManager.togglePause();
  broadcastFocus(state);
  return state;
});

ipcMain.handle('focus-skip', () => {
  const state = focusManager.skip();
  broadcastFocus(state);
  return state;
});

ipcMain.handle('focus-end', () => {
  const record = focusManager.end();
  hideFocusWindow();
  restoreMainWindow();
  broadcastFocus({ active: false });
  return record;
});

ipcMain.handle('focus-state', () => {
  return focusManager.getState();
});

ipcMain.handle('focus-add-note', (event, text, category) => {
  return focusManager.addNote(text, category);
});

ipcMain.handle('arhat-add-note', (event, text, category) => {
  // 兼容旧调用
  return arhatManager.addNote(text, category);
});

ipcMain.handle('arhat-get-notes', (event, date) => {
  return arhatManager.getNotes(date);
});

ipcMain.handle('arhat-get-stats', () => {
  return arhatManager.getStats();
});

ipcMain.handle('arhat-get-sessions', (event, date) => {
  return arhatManager.getSessions(date);
});

// --- 数据接口（HTTP / MCP） IPC ---

ipcMain.handle('get-bridge-status', () => {
  const status = apiServer.getStatus();
  const cfg = configManager.getConfig();
  return {
    ...status,
    enabled: cfg.bridge?.enabled !== false,
    dataDir: storageManager.getDataDir(),
    mcpServerPath: getMcpServerPath(),
    mcpConfig: getMcpConfigSnippet(),
    exampleUrls: {
      health: status.url ? `${status.url}/health` : null,
      // 这里曾经放的是 `?token=<长期凭据>`，等于把密钥交给渲染层去显示、
      // 去复制、去贴进聊天窗口。示例地址只给路径，Token 由「打开桥接页」
      // 用一次性码换，不经过渲染层。
      today: status.url ? `${status.url}/api/report/day` : null,
      landing: status.url ? `${status.url}/` : null
    }
  };
});

ipcMain.handle('set-bridge-config', async (event, patch) => {
  const updates = { bridge: {} };
  if (typeof patch.enabled === 'boolean') updates.bridge.enabled = patch.enabled;
  if (Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535) {
    updates.bridge.port = patch.port;
  }
  if (patch.regenerateToken) {
    updates.bridge.token = generateToken();
  }
  configManager.updateConfig(updates);

  await apiServer.stop();

  const cfg = configManager.getConfig();
  apiServer.token = cfg.bridge?.token || ensureBridgeToken();
  apiServer.basePort = cfg.bridge?.port || 47821;

  if (cfg.bridge?.enabled !== false) {
    const result = await apiServer.start();
    logManager.addLog(
      result.ok ? `数据接口已重启: ${result.url}` : '数据接口重启失败: ' + result.error,
      result.ok ? 'info' : 'error'
    );
  } else {
    logManager.addLog('数据接口已关闭', 'info');
  }

  if (mainWindow) {
    mainWindow.webContents.send('bridge-status-changed');
  }

  return true;
});

ipcMain.handle('test-bridge', async () => {
  const status = apiServer.getStatus();
  if (!status.running) {
    return { ok: false, error: '接口未运行' };
  }
  try {
    const http = require('http');
    return await new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: status.port,
          path: '/api/report/day?detail=compact',
          headers: { Authorization: `Bearer ${status.token}` },
          timeout: 5000
        },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({
            ok: res.statusCode === 200,
            statusCode: res.statusCode,
            preview: body.slice(0, 400)
          }));
        }
      );
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/**
 * 打开桥接页。
 *
 * 以前直接把长期 Token 拼进查询串：`${url}/?token=${token}`。
 * 那个 URL 会进浏览器历史、Referer、用户截图和扩展的视野，
 * 而它带上的是一个长期有效的凭据。
 *
 * 改成一次性票据：URL 里只有一个 60 秒有效、用过即废的码，
 * 桥接页拿它去 POST /auth/exchange 换真正的 Token（存 sessionStorage）。
 * 漏出去的都是废码。
 */
ipcMain.handle('open-bridge-url', () => {
  const status = apiServer.getStatus();
  if (!status.running) return { ok: false, reason: 'bridge-not-running' };

  const ticket = bridgeTickets.issue(status.port);
  const { shell } = require('electron');
  shell.openExternal(`${status.url}/?otc=${encodeURIComponent(ticket)}`);
  return { ok: true };
});

ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin;
});ipcMain.handle('get-dates-with-data', () => {
  return storageManager.getDatesWithData();
});

ipcMain.handle('set-auto-launch', (event, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable });
  return true;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('check-for-updates', async () => {
  const https = require('https');
  const currentVersion = app.getVersion();

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/one2end/WorkLogAssistant/releases/latest',
      headers: { 'User-Agent': 'WorkLogAssistant' }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = (release.tag_name || '').replace(/^v/, '');
          const hasUpdate = latestVersion && latestVersion !== currentVersion &&
            latestVersion.localeCompare(currentVersion, undefined, { numeric: true }) > 0;
          resolve({
            hasUpdate,
            latestVersion,
            currentVersion,
            downloadUrl: release.html_url || ''
          });
        } catch {
          resolve({ hasUpdate: false, latestVersion: '', currentVersion, downloadUrl: '', error: '解析失败' });
        }
      });
    }).on('error', (err) => {
      resolve({ hasUpdate: false, latestVersion: '', currentVersion, downloadUrl: '', error: err.message });
    });
  });
});

} // end single instance else block
