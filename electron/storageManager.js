const fs = require('fs');
const path = require('path');

class StorageManager {
  constructor() {
    this.dataDir = path.join(__dirname, '../Data');
    this.activitiesFile = path.join(this.dataDir, 'activities.json');
    this.summariesFile = path.join(this.dataDir, 'summaries.json');
    this.screenshotsDir = path.join(this.dataDir, 'screenshots');
    this.ensureDataDir();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
    
    if (!fs.existsSync(this.activitiesFile)) {
      fs.writeFileSync(this.activitiesFile, JSON.stringify([], null, 2), 'utf8');
    }
    
    if (!fs.existsSync(this.summariesFile)) {
      fs.writeFileSync(this.summariesFile, JSON.stringify([], null, 2), 'utf8');
    }
  }

  getDataDir() {
    return this.dataDir;
  }

  saveActivity(activity) {
    try {
      const activities = this.getAllActivities();
      activities.push(activity);
      fs.writeFileSync(this.activitiesFile, JSON.stringify(activities, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('保存活动失败:', error);
      return false;
    }
  }

  getAllActivities() {
    try {
      const data = fs.readFileSync(this.activitiesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('读取活动失败:', error);
      return [];
    }
  }

  getActivities(date) {
    const allActivities = this.getAllActivities();
    
    if (!date) {
      return allActivities;
    }
    
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);
    
    return allActivities.filter(activity => {
      const activityDate = new Date(activity.timestamp);
      return activityDate >= targetDate && activityDate < nextDate;
    });
  }

  getActivitiesByDateRange(startDate, endDate) {
    const allActivities = this.getAllActivities();
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    return allActivities.filter(activity => {
      const activityDate = new Date(activity.timestamp);
      return activityDate >= start && activityDate <= end;
    });
  }

  deleteActivity(activityId) {
    try {
      const activities = this.getAllActivities();
      const filtered = activities.filter(a => a.id !== activityId);
      fs.writeFileSync(this.activitiesFile, JSON.stringify(filtered, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('删除活动失败:', error);
      return false;
    }
  }

  clearActivities() {
    try {
      fs.writeFileSync(this.activitiesFile, JSON.stringify([], null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('清空活动失败:', error);
      return false;
    }
  }

  saveSummary(summary) {
    try {
      const summaries = this.getAllSummaries();
      summaries.push(summary);
      fs.writeFileSync(this.summariesFile, JSON.stringify(summaries, null, 2), 'utf8');
      
      const filename = `summary_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      const filepath = path.join(this.dataDir, 'summaries', filename);
      
      if (!fs.existsSync(path.join(this.dataDir, 'summaries'))) {
        fs.mkdirSync(path.join(this.dataDir, 'summaries'), { recursive: true });
      }
      
      const markdownContent = this.generateMarkdownSummary(summary);
      fs.writeFileSync(filepath, markdownContent, 'utf8');
      
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
    
    summary.activities.forEach(activity => {
      content += `- [${new Date(activity.timestamp).toLocaleTimeString('zh-CN')}] `;
      content += `${activity.processName} - ${activity.windowTitle}\n`;
    });
    
    return content;
  }

  getAllSummaries() {
    try {
      const data = fs.readFileSync(this.summariesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('读取摘要失败:', error);
      return [];
    }
  }

  getSummaries(date) {
    const allSummaries = this.getAllSummaries();
    
    if (!date) {
      return allSummaries;
    }
    
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);
    
    return allSummaries.filter(summary => {
      const summaryDate = new Date(summary.timestamp);
      return summaryDate >= targetDate && summaryDate < nextDate;
    });
  }

  getTodaySummaries() {
    const today = new Date();
    return this.getSummaries(today);
  }

  deleteSummary(summaryId) {
    try {
      const summaries = this.getAllSummaries();
      const filtered = summaries.filter(s => s.id !== summaryId);
      fs.writeFileSync(this.summariesFile, JSON.stringify(filtered, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('删除摘要失败:', error);
      return false;
    }
  }

  saveScreenshot(activityId, screenshot) {
    try {
      const activities = this.getAllActivities();
      const activity = activities.find(a => a.id === activityId);
      
      if (activity) {
        activity.screenshot = screenshot;
        fs.writeFileSync(this.activitiesFile, JSON.stringify(activities, null, 2), 'utf8');
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
    activities.forEach(activity => {
      const appName = activity.processName;
      appUsage[appName] = (appUsage[appName] || 0) + 1;
    });
    
    const uniqueApplications = Object.keys(appUsage).length;
    const mostUsedApplication = Object.entries(appUsage)
      .sort((a, b) => b[1] - a[1])[0];
    
    const activityTimeline = activities.map(activity => ({
      time: new Date(activity.timestamp).toLocaleTimeString('zh-CN'),
      application: activity.processName,
      window: activity.windowTitle
    }));
    
    return {
      totalActivities: activities.length,
      uniqueApplications,
      mostUsedApplication: mostUsedApplication ? {
        name: mostUsedApplication[0],
        count: mostUsedApplication[1]
      } : null,
      activityTimeline
    };
  }

  cleanupOldData(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      const activities = this.getAllActivities();
      const filteredActivities = activities.filter(activity => {
        const activityDate = new Date(activity.timestamp);
        return activityDate >= cutoffDate;
      });
      
      fs.writeFileSync(this.activitiesFile, JSON.stringify(filteredActivities, null, 2), 'utf8');
      
      const summaries = this.getAllSummaries();
      const filteredSummaries = summaries.filter(summary => {
        const summaryDate = new Date(summary.timestamp);
        return summaryDate >= cutoffDate;
      });
      
      fs.writeFileSync(this.summariesFile, JSON.stringify(filteredSummaries, null, 2), 'utf8');
      
      console.log(`清理完成，保留了最近 ${daysToKeep} 天的数据`);
      return true;
    } catch (error) {
      console.error('清理旧数据失败:', error);
      return false;
    }
  }
}

module.exports = StorageManager;