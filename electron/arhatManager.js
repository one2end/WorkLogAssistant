const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ArhatManager {
  constructor(customBasePath) {
    const userDataPath = app.getPath('userData');
    const dataDir = customBasePath && customBasePath.trim()
      ? customBasePath
      : path.join(userDataPath, 'Data');
    this.arhatDir = path.join(dataDir, 'arhat');
    this.sessionsDir = path.join(this.arhatDir, 'sessions');
    this.notesDir = path.join(this.arhatDir, 'notes');
    this._ensureDirs();

    this.currentSession = null;
  }

  /** 运行时切换数据根目录（配合设置页改存储路径后立即生效） */
  setDataDir(newPath) {
    const userDataPath = app.getPath('userData');
    const base = newPath && newPath.trim()
      ? newPath.trim()
      : path.join(userDataPath, 'Data');
    try {
      this.arhatDir = path.join(base, 'arhat');
      this.sessionsDir = path.join(this.arhatDir, 'sessions');
      this.notesDir = path.join(this.arhatDir, 'notes');
      this._ensureDirs();
      return true;
    } catch (error) {
      console.error('切换专注数据目录失败:', error.message);
      return false;
    }
  }

  _ensureDirs() {
    [this.arhatDir, this.sessionsDir, this.notesDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  _toDateStr(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  _readJson(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) {
      console.error('读取文件失败:', e);
    }
    return [];
  }

  _writeJson(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('写入文件失败:', e);
      return false;
    }
  }

  // --- Session management ---

  startSession(focusText) {
    const now = new Date();
    this.currentSession = {
      id: `arhat_${Date.now()}`,
      startTime: now.toISOString(),
      endTime: null,
      durationMs: 0,
      focusText: focusText || '',
      notesCount: 0
    };
    return this.currentSession;
  }

  endSession() {
    if (!this.currentSession) return null;

    const now = new Date();
    this.currentSession.endTime = now.toISOString();
    this.currentSession.durationMs = now.getTime() - new Date(this.currentSession.startTime).getTime();

    // Save to today's session file
    const dateStr = this._toDateStr(this.currentSession.startTime);
    const filePath = path.join(this.sessionsDir, `${dateStr}.json`);
    const sessions = this._readJson(filePath);
    sessions.push(this.currentSession);
    this._writeJson(filePath, sessions);

    const ended = { ...this.currentSession };
    this.currentSession = null;
    return ended;
  }

  /**
   * 删除一条专注会话。
   * 专注是本人发起的记录（人工标注层），写错了、误开了都要能删；
   * 它和记录层的原始采样不是一回事，删掉不影响「那段时间电脑在干什么」。
   */
  deleteSession(dateStr, sessionId) {
    const filePath = path.join(this.sessionsDir, `${dateStr}.json`);
    const sessions = this._readJson(filePath);
    const idx = sessions.findIndex(s => String(s.id) === String(sessionId));
    if (idx < 0) return { success: false, error: '没找到这条专注记录' };
    const [removed] = sessions.splice(idx, 1);
    this._writeJson(filePath, sessions);
    return { success: true, removed: { id: removed.id, startTime: removed.startTime } };
  }

  getActiveSession() {
    if (!this.currentSession) return null;
    // Return with live duration
    return {
      ...this.currentSession,
      durationMs: Date.now() - new Date(this.currentSession.startTime).getTime()
    };
  }

  // --- Flash notes (杂念闪记) ---

  addNote(text, category) {
    const now = new Date();
    const note = {
      id: Date.now(),
      sessionId: this.currentSession ? this.currentSession.id : null,
      timestamp: now.toISOString(),
      text: text,
      category: category || 'random'  // 'todo' | 'idea' | 'random'
    };

    const dateStr = this._toDateStr(now);
    const filePath = path.join(this.notesDir, `${dateStr}.json`);
    const notes = this._readJson(filePath);
    notes.push(note);
    this._writeJson(filePath, notes);

    if (this.currentSession) {
      this.currentSession.notesCount++;
    }

    return note;
  }

  getNotes(date) {
    const dateStr = date ? this._toDateStr(date) : this._toDateStr(new Date());
    return this._readJson(path.join(this.notesDir, `${dateStr}.json`));
  }

  getAllNotes() {
    return this._getAllFromDir(this.notesDir);
  }

  // --- Statistics ---

  getSessions(date) {
    const dateStr = date ? this._toDateStr(date) : this._toDateStr(new Date());
    return this._readJson(path.join(this.sessionsDir, `${dateStr}.json`));
  }

  getStats() {
    const todaySessions = this.getSessions();
    const todayNotes = this.getNotes();

    const totalDurationMs = todaySessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const sessionCount = todaySessions.length;

    // All-time stats
    const allSessions = this._getAllFromDir(this.sessionsDir);
    const allDurationMs = allSessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);

    return {
      today: {
        sessionCount,
        totalDurationMs,
        notesCount: todayNotes.length
      },
      allTime: {
        sessionCount: allSessions.length,
        totalDurationMs: allDurationMs
      }
    };
  }

  _getAllFromDir(dir) {
    try {
      if (!fs.existsSync(dir)) return [];
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      let all = [];
      for (const file of files) {
        const items = this._readJson(path.join(dir, file));
        all = all.concat(items);
      }
      return all;
    } catch (e) {
      return [];
    }
  }
}

module.exports = ArhatManager;
