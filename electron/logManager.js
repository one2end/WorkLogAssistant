const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class LogManager {
  constructor(customBasePath) {
    const userDataPath = app.getPath('userData');
    const defaultDataDir = path.join(userDataPath, 'Data');

    if (customBasePath && customBasePath.trim()) {
      try {
        if (!fs.existsSync(customBasePath)) {
          fs.mkdirSync(customBasePath, { recursive: true });
        }
        this.logsDir = path.join(customBasePath, 'logs');
      } catch (error) {
        console.error('自定义日志路径不可用，使用默认路径:', error.message);
        this.logsDir = path.join(defaultDataDir, 'logs');
      }
    } else {
      this.logsDir = path.join(defaultDataDir, 'logs');
    }

    this.ensureLogsDir();
    this.logEntries = [];
    this.maxLogEntries = 1000;
  }

  /** 运行时切换数据根目录（配合设置页改存储路径后立即生效） */
  setDataDir(newPath) {
    const userDataPath = app.getPath('userData');
    const base = newPath && newPath.trim()
      ? newPath.trim()
      : path.join(userDataPath, 'Data');
    try {
      this.logsDir = path.join(base, 'logs');
      this.ensureLogsDir();
      return true;
    } catch (error) {
      console.error('切换日志目录失败:', error.message);
      return false;
    }
  }

  ensureLogsDir() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  getLogFilename() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this.logsDir, `app_log_${today}.log`);
  }

  addLog(message, type = 'info') {
    const timestamp = new Date();
    const logEntry = {
      id: Date.now(),
      timestamp: timestamp.toISOString(),
      time: timestamp.toLocaleTimeString('zh-CN'),
      message: message,
      type: type
    };

    this.logEntries.push(logEntry);
    
    if (this.logEntries.length > this.maxLogEntries) {
      this.logEntries.shift();
    }

    this.writeLogToFile(logEntry);

    return logEntry;
  }

  writeLogToFile(logEntry) {
    try {
      const filename = this.getLogFilename();
      const logLine = `[${logEntry.timestamp}] [${logEntry.type.toUpperCase()}] ${logEntry.message}\n`;
      fs.appendFileSync(filename, logLine, 'utf8');
    } catch (error) {
      console.error('写入日志文件失败:', error);
    }
  }

  getLogs(count = 500) {
    return this.logEntries.slice(-count);
  }

  clearLogs() {
    this.logEntries = [];
  }

  deleteOldLogs(daysToKeep = 7) {
    try {
      const files = fs.readdirSync(this.logsDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      files.forEach(file => {
        const filepath = path.join(this.logsDir, file);
        const stats = fs.statSync(filepath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filepath);
          console.log(`删除过期日志: ${file}`);
        }
      });
    } catch (error) {
      console.error('清理过期日志失败:', error);
    }
  }
}

module.exports = LogManager;
