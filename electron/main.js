const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const WindowMonitor = require('./windowMonitor');
const ScreenshotManager = require('./screenshotManager');
const Summarizer = require('./summarizer');
const ConfigManager = require('./configManager');
const StorageManager = require('./storageManager');
const OCRManager = require('./ocrManager');
const LogManager = require('./logManager');

let mainWindow;
let floatWindow;
let tray;
let isMonitoring = false;
let monitorInterval = null;
let screenshotInterval = null;
let summaryInterval = null;
let lastSummaryTime = null;
let currentAppName = '';
let currentAppStartTime = null;

const configManager = new ConfigManager();
const storageManager = new StorageManager();
const windowMonitor = new WindowMonitor();
const screenshotManager = new ScreenshotManager();
const summarizer = new Summarizer();
const ocrManager = new OCRManager();
const logManager = new LogManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 560,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a2e'
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (floatWindow) {
      floatWindow.hide();
    }
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
    const iconPath = path.join(__dirname, '../build/icon.png');
    trayIcon = nativeImage.createFromPath(iconPath);
    
    if (trayIcon.isEmpty()) {
      console.log('图标文件为空，使用默认图标');
      trayIcon = nativeImage.createEmpty();
    }
  } catch (error) {
    console.log('无法加载图标文件，使用默认图标:', error.message);
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '查看今日摘要', click: () => showTodaySummary() },
    { label: '生成当前摘要', click: () => generateCurrentSummary() },
    { label: '打开数据文件夹', click: () => openDataFolder() },
    { type: 'separator' },
    { 
      label: isMonitoring ? '暂停监控' : '开始监控', 
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

  floatWindow = new BrowserWindow({
    width: 260,
    height: 36,
    x: width - 280,
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

  floatWindow.on('closed', () => {
    floatWindow = null;
  });
}

function updateFloatWindow() {
  if (!floatWindow || !isMonitoring) return;

  let duration = '0分钟';
  if (currentAppStartTime) {
    const diffMs = Date.now() - currentAppStartTime;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) duration = '<1分钟';
    else if (minutes < 60) duration = `${minutes}分钟`;
    else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      duration = mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
    }
  }

  floatWindow.webContents.send('float-update', {
    appName: currentAppName || '--',
    duration
  });
}

function showTodaySummary() {
  const summaries = storageManager.getTodaySummaries();
  if (summaries.length > 0) {
    const latest = summaries[summaries.length - 1];
    const { shell } = require('electron');
    shell.openPath(latest.path);
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
      label: isMonitoring ? '暂停监控' : '开始监控', 
      click: () => toggleMonitoring() 
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]);
  
  tray.setContextMenu(contextMenu);
}

function startMonitoring() {
  const config = configManager.getConfig();
  const monitorIntervalTime = config.monitoring.interval * 1000;
  
  logManager.addLog('开始监控', 'info');
  logManager.addLog('监控间隔: ' + config.monitoring.interval + '秒', 'info');
  
  monitorInterval = setInterval(async () => {
    try {
      const activity = await windowMonitor.getCurrentActivity();
      if (activity) {
        // Track current app for float window
        if (activity.processName !== currentAppName) {
          currentAppName = activity.processName;
          currentAppStartTime = Date.now();
        }
        updateFloatWindow();

        storageManager.saveActivity(activity);
        logManager.addLog('记录活动: ' + activity.processName + ' - ' + activity.windowTitle, 'info');

        if (mainWindow) {
          mainWindow.webContents.send('activity-logged', activity);
        }
      } else {
        // Even if no new activity, update float window timer
        updateFloatWindow();
      }
    } catch (error) {
      console.error('监控错误:', error);
      logManager.addLog('监控错误: ' + error.message, 'error');
    }
  }, monitorIntervalTime);
  
  if (config.monitoring.captureScreenshot) {
    const screenshotIntervalTime = config.monitoring.screenshotInterval * 1000;
    logManager.addLog('截图间隔: ' + config.monitoring.screenshotInterval + '秒', 'info');
    
    screenshotInterval = setInterval(async () => {
      try {
        const activity = await windowMonitor.getCurrentActivity();
        if (activity) {
          const screenshot = await screenshotManager.captureScreen();
          if (screenshot) {
            storageManager.saveActivity(activity);
            storageManager.saveScreenshot(activity.id, screenshot);
            logManager.addLog('保存截图: ' + screenshot.path, 'info');
            
            logManager.addLog('开始OCR识别...', 'info');
            const ocrResult = await ocrManager.recognizeImage(screenshot.path);
            if (ocrResult) {
              ocrManager.saveOCRResult(activity.id, ocrResult);
              logManager.addLog('OCR识别完成: ' + (ocrResult.success ? '成功' : '失败'), ocrResult.success ? 'info' : 'error');
            }
            
            if (mainWindow) {
              mainWindow.webContents.send('activity-logged', activity);
            }
          }
        }
      } catch (error) {
        console.error('截图错误:', error);
        logManager.addLog('截图错误: ' + error.message, 'error');
      }
    }, screenshotIntervalTime);
  }

  const summaryIntervalMinutes = config.summary?.intervalMinutes || 60;
  if (summaryIntervalMinutes > 0) {
    const summaryIntervalTime = summaryIntervalMinutes * 60 * 1000;
    logManager.addLog('摘要间隔: ' + summaryIntervalMinutes + '分钟', 'info');
    
    summaryInterval = setInterval(async () => {
      try {
        logManager.addLog('正在自动生成摘要...', 'info');
        logManager.addLog('开始自动摘要生成', 'info');
        await summarizer.generateSummary();
        logManager.addLog('自动摘要生成成功', 'info');
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

function stopMonitoring() {
  logManager.addLog('停止监控', 'info');
  logManager.addLog('监控已暂停', 'info');
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  if (summaryInterval) {
    clearInterval(summaryInterval);
    summaryInterval = null;
  }
}

function quitApp() {
  app.isQuitting = true;
  stopMonitoring();
  if (mainWindow) {
    mainWindow.destroy();
  }
  app.quit();
}

app.whenReady().then(() => {
  logManager.addLog('应用程序启动中...', 'info');
  createWindow();
  logManager.addLog('主窗口已创建', 'info');
  createTray();
  logManager.addLog('托盘图标已创建', 'info');
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

ipcMain.handle('save-config', (event, config) => {
  configManager.saveConfig(config);
  summarizer.updateConfig(config);
  
  if (mainWindow) {
    mainWindow.webContents.send('config-updated', config);
  }
  
  return true;
});

ipcMain.handle('get-activities', (event, date) => {
  return storageManager.getActivities(date);
});

ipcMain.handle('get-summaries', (event, date) => {
  return storageManager.getSummaries(date);
});

ipcMain.handle('generate-summary', async () => {
  return await summarizer.generateSummary();
});

ipcMain.handle('toggle-monitoring', () => {
  toggleMonitoring();
  return isMonitoring;
});

ipcMain.handle('get-monitoring-status', () => {
  return isMonitoring;
});

ipcMain.handle('get-ocr-result', (event, activityId) => {
  return ocrManager.getOCRResult(activityId);
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) {
    mainWindow.hide();
    if (isMonitoring) {
      createFloatWindow();
      updateFloatWindow();
    }
  }
});

ipcMain.handle('show-main-window', () => {
  showMainWindow();
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

ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-auto-launch', (event, enable) => {
  app.setLoginItemSettings({ openAtLogin: enable });
  return true;
});