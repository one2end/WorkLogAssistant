const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class StorageManager {
  constructor(customBasePath) {
    const userDataPath = app.getPath('userData');
    this._defaultDataDir = path.join(userDataPath, 'Data');

    // Use custom path if provided and accessible, otherwise default
    if (customBasePath && customBasePath.trim()) {
      try {
        if (!fs.existsSync(customBasePath)) {
          fs.mkdirSync(customBasePath, { recursive: true });
        }
        // Test write access
        const testFile = path.join(customBasePath, '.write_test');
        fs.writeFileSync(testFile, 'test', 'utf8');
        fs.unlinkSync(testFile);
        this.dataDir = customBasePath;
      } catch (error) {
        console.error('自定义存储路径不可用，使用默认路径:', error.message);
        this.dataDir = this._defaultDataDir;
      }
    } else {
      this.dataDir = this._defaultDataDir;
    }

    this.activitiesDir = path.join(this.dataDir, 'activities');
    this.summariesDir = path.join(this.dataDir, 'summaries');
    this.screenshotsDir = path.join(this.dataDir, 'screenshots');
    // Legacy single-file paths (for migration)
    this._legacyActivitiesFile = path.join(this._defaultDataDir, 'activities.json');
    this._legacySummariesFile = path.join(this._defaultDataDir, 'summaries.json');
    this.ensureDataDir();
    this._migrateIfNeeded();
  }

  // --- Helpers ---

  _toDateStr(timestamp) {
    const d = new Date(timestamp);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  _todayStr() {
    return this._toDateStr(new Date());
  }

  _activityFile(dateStr) {
    return path.join(this.activitiesDir, `${dateStr}.json`);
  }

  _summaryFile(dateStr) {
    return path.join(this.summariesDir, `${dateStr}.json`);
  }

  _readJsonFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      console.error(`读取文件失败 ${filePath}:`, error);
    }
    return [];
  }

  _writeJsonFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error(`写入文件失败 ${filePath}:`, error);
      return false;
    }
  }

  // --- Init & Migration ---

  ensureDataDir() {
    [this.dataDir, this.activitiesDir, this.summariesDir, this.screenshotsDir]
      .forEach(dir => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });
  }

  _migrateIfNeeded() {
    // Migrate legacy activities.json → per-day files
    if (fs.existsSync(this._legacyActivitiesFile)) {
      try {
        const all = JSON.parse(fs.readFileSync(this._legacyActivitiesFile, 'utf8'));
        if (Array.isArray(all) && all.length > 0) {
          const grouped = {};
          all.forEach(a => {
            const dateStr = this._toDateStr(a.timestamp);
            if (!grouped[dateStr]) grouped[dateStr] = [];
            grouped[dateStr].push(a);
          });
          for (const [dateStr, items] of Object.entries(grouped)) {
            const filePath = this._activityFile(dateStr);
            const existing = this._readJsonFile(filePath);
            this._writeJsonFile(filePath, existing.concat(items));
          }
          console.log(`已迁移 ${all.length} 条活动记录到按天存储`);
        }
        // Rename legacy file as backup
        fs.renameSync(this._legacyActivitiesFile,
          this._legacyActivitiesFile + '.migrated');
      } catch (error) {
        console.error('迁移活动数据失败:', error);
      }
    }

    // Migrate legacy summaries.json → per-day files
    if (fs.existsSync(this._legacySummariesFile)) {
      try {
        const all = JSON.parse(fs.readFileSync(this._legacySummariesFile, 'utf8'));
        if (Array.isArray(all) && all.length > 0) {
          const grouped = {};
          all.forEach(s => {
            const dateStr = this._toDateStr(s.timestamp);
            if (!grouped[dateStr]) grouped[dateStr] = [];
            grouped[dateStr].push(s);
          });
          for (const [dateStr, items] of Object.entries(grouped)) {
            const filePath = this._summaryFile(dateStr);
            const existing = this._readJsonFile(filePath);
            this._writeJsonFile(filePath, existing.concat(items));
          }
          console.log(`已迁移 ${all.length} 条摘要记录到按天存储`);
        }
        fs.renameSync(this._legacySummariesFile,
          this._legacySummariesFile + '.migrated');
      } catch (error) {
        console.error('迁移摘要数据失败:', error);
      }
    }
  }

  // --- Data Dir ---

  getDataDir() {
    return this.dataDir;
  }

  // --- Activities ---

  saveActivity(activity) {
    try {
      const dateStr = this._toDateStr(activity.timestamp);
      const filePath = this._activityFile(dateStr);
      const activities = this._readJsonFile(filePath);
      activities.push(activity);
      return this._writeJsonFile(filePath, activities);
    } catch (error) {
      console.error('保存活动失败:', error);
      return false;
    }
  }

  getActivities(date) {
    if (!date) {
      return this._getAllFromDir(this.activitiesDir);
    }
    const dateStr = this._toDateStr(date);
    return this._readJsonFile(this._activityFile(dateStr));
  }

  getAllActivities() {
    return this._getAllFromDir(this.activitiesDir);
  }

  getActivitiesByDateRange(startDate, endDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const results = [];
    const dateFiles = this._getDateFilesInRange(this.activitiesDir, start, end);
    for (const filePath of dateFiles) {
      const items = this._readJsonFile(filePath);
      items.forEach(a => {
        const t = new Date(a.timestamp);
        if (t >= start && t <= end) results.push(a);
      });
    }
    return results;
  }

  getActivitiesByTimeRange(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);

    const results = [];
    const dateFiles = this._getDateFilesInRange(this.activitiesDir, start, end);
    for (const filePath of dateFiles) {
      const items = this._readJsonFile(filePath);
      items.forEach(a => {
        const t = new Date(a.timestamp);
        if (t >= start && t <= end) results.push(a);
      });
    }
    return results;
  }

  deleteActivity(activityId) {
    try {
      // Need to search all day files for the activity
      const files = this._listJsonFiles(this.activitiesDir);
      for (const file of files) {
        const filePath = path.join(this.activitiesDir, file);
        const items = this._readJsonFile(filePath);
        const filtered = items.filter(a => a.id !== activityId);
        if (filtered.length !== items.length) {
          this._writeJsonFile(filePath, filtered);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('删除活动失败:', error);
      return false;
    }
  }

  clearActivities() {
    try {
      const files = this._listJsonFiles(this.activitiesDir);
      files.forEach(f => fs.unlinkSync(path.join(this.activitiesDir, f)));
      return true;
    } catch (error) {
      console.error('清空活动失败:', error);
      return false;
    }
  }

  // --- Summaries ---

  saveSummary(summary) {
    try {
      const dateStr = this._toDateStr(summary.timestamp);
      const filePath = this._summaryFile(dateStr);
      const summaries = this._readJsonFile(filePath);
      summaries.push(summary);
      this._writeJsonFile(filePath, summaries);

      // Also write markdown file
      const mdDir = path.join(this.dataDir, 'summaries_md');
      if (!fs.existsSync(mdDir)) {
        fs.mkdirSync(mdDir, { recursive: true });
      }
      const mdFilename = `summary_${new Date(summary.timestamp).toISOString().replace(/[:.]/g, '-')}.md`;
      const mdPath = path.join(mdDir, mdFilename);
      fs.writeFileSync(mdPath, this.generateMarkdownSummary(summary), 'utf8');

      return true;
    } catch (error) {
      console.error('保存摘要失败:', error);
      return false;
    }
  }
  generateMarkdownSummary(summary) {
    let content = `# 工作日志摘要\n\n`;
    content += `**时间**: ${new Date(summary.timestamp).toLocaleString('zh-CN')}\n\n`;
    content += `**活动数量**: ${summary.activityCount}\n\n`;
    content += `---\n\n`;
    content += `## 摘要内容\n\n`;
    content += `${summary.summary}\n\n`;
    content += `---\n\n`;
    content += `## 活动详情\n\n`;
    if (summary.activities) {
      summary.activities.forEach(activity => {
        content += `- [${new Date(activity.timestamp).toLocaleTimeString('zh-CN')}] `;
        content += `${activity.processName} - ${activity.windowTitle}\n`;
      });
    }
    return content;
  }

  getAllSummaries() {
    return this._getAllFromDir(this.summariesDir);
  }

  getSummaries(date) {
    if (!date) {
      return this._getAllFromDir(this.summariesDir);
    }
    const dateStr = this._toDateStr(date);
    return this._readJsonFile(this._summaryFile(dateStr));
  }

  getTodaySummaries() {
    return this.getSummaries(new Date());
  }

  deleteSummary(summaryId) {
    try {
      const files = this._listJsonFiles(this.summariesDir);
      for (const file of files) {
        const filePath = path.join(this.summariesDir, file);
        const items = this._readJsonFile(filePath);
        const filtered = items.filter(s => s.id !== summaryId);
        if (filtered.length !== items.length) {
          this._writeJsonFile(filePath, filtered);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('删除摘要失败:', error);
      return false;
    }
  }

  // --- Screenshots ---

  saveScreenshot(activityId, screenshot) {
    try {
      // Search today's file first, then all files
      const todayFile = this._activityFile(this._todayStr());
      const activities = this._readJsonFile(todayFile);
      const activity = activities.find(a => a.id === activityId);
      if (activity) {
        activity.screenshot = screenshot;
        this._writeJsonFile(todayFile, activities);
        return true;
      }
      return false;
    } catch (error) {
      console.error('保存截图信息失败:', error);
      return false;
    }
  }

  getScreenshotPath(filename) {
    return path.join(this.screenshotsDir, filename);
  }

  // --- Statistics ---

  getStatistics(date) {
    const activities = this.getActivities(date);
    if (activities.length === 0) {
      return {
        totalActivities: 0,
        uniqueApplications: 0,
        mostUsedApplication: null,
        activityTimeline: []
      };
    }

    const appUsage = {};
    activities.forEach(a => {
      appUsage[a.processName] = (appUsage[a.processName] || 0) + 1;
    });

    const uniqueApplications = Object.keys(appUsage).length;
    const mostUsedApplication = Object.entries(appUsage)
      .sort((a, b) => b[1] - a[1])[0];

    const activityTimeline = activities.map(a => ({
      time: new Date(a.timestamp).toLocaleTimeString('zh-CN'),
      application: a.processName,
      window: a.windowTitle
    }));

    return {
      totalActivities: activities.length,
      uniqueApplications,
      mostUsedApplication: mostUsedApplication
        ? { name: mostUsedApplication[0], count: mostUsedApplication[1] }
        : null,
      activityTimeline
    };
  }

  // --- Cleanup ---

  cleanupOldData(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const cutoffStr = this._toDateStr(cutoffDate);

      let removed = 0;
      [this.activitiesDir, this.summariesDir].forEach(dir => {
        this._listJsonFiles(dir).forEach(file => {
          const dateStr = file.replace('.json', '');
          if (dateStr < cutoffStr) {
            fs.unlinkSync(path.join(dir, file));
            removed++;
          }
        });
      });

      console.log(`清理完成，删除了 ${removed} 个过期文件，保留最近 ${daysToKeep} 天`);
      return true;
    } catch (error) {
      console.error('清理旧数据失败:', error);
      return false;
    }
  }

  // --- Directory scan helpers ---

  _listJsonFiles(dir) {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort();
    } catch (error) {
      console.error(`列出文件失败 ${dir}:`, error);
      return [];
    }
  }

  _getAllFromDir(dir) {
    const files = this._listJsonFiles(dir);
    let all = [];
    for (const file of files) {
      const items = this._readJsonFile(path.join(dir, file));
      all = all.concat(items);
    }
    return all;
  }

  _getDateFilesInRange(dir, start, end) {
    const startStr = this._toDateStr(start);
    const endStr = this._toDateStr(end);
    return this._listJsonFiles(dir)
      .filter(f => {
        const dateStr = f.replace('.json', '');
        return dateStr >= startStr && dateStr <= endStr;
      })
      .map(f => path.join(dir, f));
  }

  // --- Dates with data (for calendar) ---

  getDatesWithData() {
    return this._listJsonFiles(this.activitiesDir)
      .map(f => f.replace('.json', ''));
  }

  // --- Data migration between paths ---

  migrateDataTo(newPath) {
    try {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      // Test write access
      const testFile = path.join(newPath, '.write_test');
      fs.writeFileSync(testFile, 'test', 'utf8');
      fs.unlinkSync(testFile);

      const dirsToMigrate = ['activities', 'summaries', 'summaries_md', 'screenshots'];
      let fileCount = 0;

      for (const dirName of dirsToMigrate) {
        const srcDir = path.join(this.dataDir, dirName);
        const destDir = path.join(newPath, dirName);
        if (!fs.existsSync(srcDir)) continue;
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        const files = fs.readdirSync(srcDir);
        for (const file of files) {
          const srcFile = path.join(srcDir, file);
          const destFile = path.join(destDir, file);
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, destFile);
            fileCount++;
          }
        }
      }

      console.log(`已迁移 ${fileCount} 个文件到 ${newPath}`);
      return { success: true, fileCount };
    } catch (error) {
      console.error('数据迁移失败:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = StorageManager;
