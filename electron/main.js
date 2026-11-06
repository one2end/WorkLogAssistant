const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const WindowMonitor = require('./windowMonitor');
const ActivityRecorder = require('./activityRecorder');
const Summarizer = require('./summarizer');
const ConfigManager = require('./configManager');
const StorageManager = require('./storageManager');
const LogManager = require('./logManager');
const ArhatManager = require('./arhatManager');
const FocusManager = require('./focusManager');
const { ApiServer, generateToken } = require('./apiServer');
const analytics = require('./analytics');

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
  app.setName('WorkLog Assistant');
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
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  focusWindow.loadFile(path.join(__dirname, 'focus.html'));
  // 隐藏窗口的 ready-to-show 在部分 Electron 版本不触发，主题用 did-finish-load 兜底
  focusWindow.webContents.once('did-finish-load', () => {
    if (!focusWindow || focusWindow.isDestroyed()) return;
    const theme = configManager.getConfig().ui?.theme || 'dark';
    focusWindow.webContents.send('focus-theme', theme);
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
  token: ensureBridgeToken()
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

  mainWindow = new BrowserWindow({
    width: 620,
    height: workArea.height,
    x: workArea.x + workArea.width - 620,
    y: workArea.y,
    minWidth: 520,
    minHeight: 600,
    // Windows 下用 .ico 才能在任务栏/Alt+Tab 拿到多尺寸清晰图标
    icon: process.platform === 'win32' ? assetPath('icon.ico') : assetPath('icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: configManager.getConfig().ui?.theme === 'light' ? '#f7f8fa' : '#0b0c0e'
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
    // Electron 自带的 CSP 提示在开启 nodeIntegration 时无解，不往诊断日志里塞噪音
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

  tray.setToolTip('WorkLog Assistant');
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  floatWindow.loadFile(path.join(__dirname, 'float.html'));
  floatWindow.setVisibleOnAllWorkspaces(true);

  floatWindow.webContents.once('did-finish-load', () => {
    const theme = configManager.getConfig().ui?.theme || 'dark';
    floatWindow.webContents.send('float-theme', theme);
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

function startMonitoring() {
  const config = configManager.getConfig();

  logManager.addLog('开始记录', 'info');

  activityRecorder.start();

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
              await summarizer.generateSummaryForLookback(lookbackMinutes);
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

      summaryInterval = setInterval(async () => {
        try {
          logManager.addLog('正在自动生成摘要...', 'info');
          await summarizer.generateSummary();
          logManager.addLog('自动摘要生成完成', 'info');
          if (mainWindow) {
            mainWindow.webContents.send('summary-generated');
          }
        } catch (error) {
          console.error('自动摘要生成失败:', error);
          logManager.addLog('自动摘要生成失败: ' + error.message, 'error');
        }
      }, summaryIntervalTime);
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

ipcMain.handle('get-config', () => {
  return configManager.getConfig();
});

ipcMain.handle('get-provider-presets', () => {
  return Summarizer.getProviderPresets();
});

ipcMain.handle('save-config', (event, config) => {
  configManager.saveConfig(config);
  summarizer.updateConfig(config);

  // 重启监控定时器以使新配置生效
  if (isMonitoring) {
    stopMonitoring();
    startMonitoring();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', config);
    // 窗口底色只在创建时设过一次，换肤时同步，避免浅色/深色切换闪一下
    mainWindow.setBackgroundColor(config.ui?.theme === 'light' ? '#f7f8fa' : '#0b0c0e');
  }

  if (floatWindow) {
    floatWindow.webContents.send('float-theme', config.ui?.theme || 'dark');
  }

  // 专注 HUD 是懒创建窗口：此刻可能还不存在，创建时会再推一次当前主题
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.webContents.send('focus-theme', config.ui?.theme || 'dark');
  }

  return true;
});

ipcMain.handle('get-activities', (event, date) => {
  return storageManager.getActivities(date);
});

// --- 聚合统计（前端与 AI 接口共用同一套口径） ---

ipcMain.handle('get-day-analytics', (event, date) => {
  try {
    const dateStr = date || analytics.toDateStr(new Date());
    const report = analytics.buildDayReport(storageManager.getDataDir(), dateStr);
    return { ok: true, report, markdown: analytics.renderDayMarkdown(report, 'normal') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('get-range-analytics', (event, payload) => {
  try {
    const to = (payload && payload.to) || analytics.toDateStr(new Date());
    const from = (payload && payload.from) || analytics.toDateStr(
      new Date(new Date(to + 'T00:00:00').getTime() - 6 * 86400000)
    );
    const report = analytics.buildRangeReport(storageManager.getDataDir(), from, to);
    return { ok: true, report, markdown: analytics.renderRangeMarkdown(report, 'normal') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// 热力图专用：只返回逐日有效时长，口径与单日 report.stats.trackedMs 一致
ipcMain.handle('get-daily-tracked', (event, payload) => {
  try {
    const p = payload || {};
    const to = p.to || analytics.toDateStr(new Date());
    const from = p.from || analytics.toDateStr(
      new Date(new Date(to + 'T00:00:00').getTime() - 83 * 86400000)
    );
    const days = analytics.buildDailyTrackedMs(storageManager.getDataDir(), from, to);
    return { ok: true, from, to, days, generatedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: error.message, days: [] };
  }
});

ipcMain.handle('get-recorder-status', () => {
  return activityRecorder.getStatus();
});

// 手工补记：录制器漏掉的时段，由用户补上（类似 RescueTime 的手动条目）
ipcMain.handle('add-manual-record', (event, payload) => {
  const p = payload || {};
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '')
    ? p.date
    : analytics.toDateStr(new Date());
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(p.startTime || '').trim());
  if (!m) {
    return { ok: false, error: '开始时间格式应为 HH:mm' };
  }

  const durationMin = parseInt(p.durationMin, 10);
  if (!durationMin || durationMin < 1 || durationMin > 24 * 60) {
    return { ok: false, error: '时长需在 1–1440 分钟之间' };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(`${dateStr}T${pad(m[1])}:${m[2]}:00`);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: '时间无法解析' };
  }

  const ok = storageManager.appendActivityRecords([{
    t: start.toISOString(),
    dur: durationMin * 60000,
    kind: 'active',
    app: String(p.app || '手工记录').trim() || '手工记录',
    title: String(p.title || '').trim(),
    platform: 'manual',
    source: 'manual',
    cat: p.category || ''
  }]);

  if (ok) {
    logManager.addLog(`手工补记 ${dateStr} ${p.startTime} · ${durationMin} 分钟`, 'info');
  }
  return { ok, error: ok ? null : '写入失败' };
});

ipcMain.handle('flush-recorder', () => {
  const n = activityRecorder.flush();
  return { flushed: n };
});

ipcMain.handle('get-summaries', (event, date) => {
  return storageManager.getSummaries(date);
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
    title: '选择导入文件',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    const data = JSON.parse(content);

    if (!data.activities && !data.summaries) {
      return { success: false, error: '无效的数据文件格式' };
    }

    let importedCount = 0;

    if (mode === 'overwrite') {
      // Clear existing data first
      storageManager.clearActivities();
    }

    // Import activities
    if (Array.isArray(data.activities)) {
      data.activities.forEach(a => {
        if (a.timestamp && a.processName) {
          storageManager.saveActivity(a);
          importedCount++;
        }
      });
    }

    // Import summaries
    if (Array.isArray(data.summaries)) {
      data.summaries.forEach(s => {
        if (s.timestamp && s.summary) {
          storageManager.saveSummary(s);
        }
      });
    }

    logManager.addLog(`数据导入完成 (${mode})，导入 ${importedCount} 条活动`, 'info');
    if (mainWindow) {
      mainWindow.webContents.send('summary-generated');
    }
    return { success: true, importedCount };
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
      today: status.url ? `${status.url}/api/report/day?token=${status.token}` : null,
      landing: status.url ? `${status.url}/?token=${status.token}` : null
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

ipcMain.handle('open-bridge-url', () => {
  const status = apiServer.getStatus();
  if (!status.running) return false;
  const { shell } = require('electron');
  shell.openExternal(`${status.url}/?token=${status.token}`);
  return true;
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