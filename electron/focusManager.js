'use strict';

/**
 * focusManager.js — 专注助手（番茄 / 沉浸 / 罗汉）
 *
 * 三种模式的差别只在「节奏」：
 *   番茄钟  固定 25/5，四轮一组
 *   沉浸    15/15，节奏更松，适合写作和深度阅读
 *   罗汉    不计时，单任务，一直做当下的事，随时觉察
 *
 * 共同的产出：一段带模式的专注记录 + 若干条杂念闪记，都落到 arhat/ 目录，
 * 和旧版数据格式兼容（sessions 多出 mode / rounds 字段，旧记录无此字段照常读）。
 */

const fs = require('fs');
const path = require('path');

const PRESETS = {
  pomodoro: {
    id: 'pomodoro',
    name: '番茄钟',
    icon: 'timer',
    workMin: 25,
    breakMin: 5,
    rounds: 4,
    autoContinue: true,
    tint: '#f97316',
    hint: '25 分钟专注，5 分钟休息，四轮一组'
  },
  immersive: {
    id: 'immersive',
    name: '沉浸',
    icon: 'zap',
    workMin: 15,
    breakMin: 15,
    rounds: 0,
    autoContinue: true,
    tint: '#38bdf8',
    hint: '15 分钟工作，15 分钟休息，节奏更松'
  },
  arhat: {
    id: 'arhat',
    name: '罗汉',
    icon: 'zen',
    workMin: 0,
    breakMin: 0,
    rounds: 0,
    autoContinue: false,
    tint: '#a855f7',
    hint: '不计时，只做当下这一件事，随时觉察'
  }
};

const PHASE_LABEL = { work: '专注中', break: '休息中', open: '觉察中' };
const MINUTE = 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 毫秒 → mm:ss / h:mm:ss */
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

class FocusManager {
  constructor(options) {
    const opts = options || {};
    this.arhatManager = opts.arhatManager || null;
    this.getConfig = opts.getConfig || (() => ({}));
    this.onLog = opts.onLog || (() => {});
    this.onPhaseChange = opts.onPhaseChange || (() => {});
    this.onEnd = opts.onEnd || (() => {});

    this.session = null;
    this._lastPhase = null;
  }

  // --- 预设 ---

  /** 预设 + 用户在设置里改过的时长 */
  getPresets() {
    const cfg = (this.getConfig() || {}).focus || {};
    const out = {};
    for (const [id, base] of Object.entries(PRESETS)) {
      const custom = cfg[id] || {};
      const merged = { ...base };
      if (id !== 'arhat') {
        if (custom.workMin > 0) merged.workMin = Number(custom.workMin);
        if (custom.breakMin >= 0 && custom.breakMin !== undefined) merged.breakMin = Number(custom.breakMin);
        if (custom.rounds !== undefined && custom.rounds !== null) merged.rounds = Number(custom.rounds);
      }
      merged.hint = merged.breakMin > 0
        ? `${merged.workMin} 分钟专注，${merged.breakMin} 分钟休息${merged.rounds > 0 ? `，${merged.rounds} 轮一组` : ''}`
        : base.hint;
      out[id] = merged;
    }
    return out;
  }

  _preset(modeId) {
    return this.getPresets()[modeId] || PRESETS.pomodoro;
  }

  // --- 生命周期 ---

  start(modeId, focusText, overrides) {
    const preset = { ...this._preset(modeId), ...(overrides || {}) };
    const now = Date.now();

    this.session = {
      id: `focus_${preset.id}_${now}`,
      mode: preset.id,
      modeName: preset.name,
      tint: preset.tint,
      focusText: String(focusText || '').trim(),
      startedAt: now,
      phase: preset.workMin > 0 ? 'work' : 'open',
      phaseStartAt: now,
      pausedAt: null,
      pausedMs: 0,
      totalPausedMs: 0,
      totalBreakMs: 0,
      round: 1,
      rounds: preset.rounds || 0,
      workMin: preset.workMin,
      breakMin: preset.breakMin,
      notesCount: 0
    };

    this._lastPhase = this.session.phase;
    this.onLog(`专注开始 · ${preset.name}${this.session.focusText ? ' · ' + this.session.focusText : ''}`, 'info');
    return this.getState();
  }

  pause() {
    if (!this.session || this.session.pausedAt) return this.getState();
    this.session.pausedAt = Date.now();
    return this.getState();
  }

  resume() {
    if (!this.session || !this.session.pausedAt) return this.getState();
    const delta = Date.now() - this.session.pausedAt;
    this.session.pausedMs += delta;
    this.session.totalPausedMs += delta;
    this.session.pausedAt = null;
    return this.getState();
  }

  togglePause() {
    return this.session && this.session.pausedAt ? this.resume() : this.pause();
  }

  /** 手动跳到下一阶段（工作↔休息） */
  skip() {
    if (!this.session || this.session.phase === 'open') return this.getState();
    this._advance(Date.now(), true);
    return this.getState();
  }

  end() {
    if (!this.session) return null;
    const s = this.session;
    const now = Date.now();
    const pendingPauseMs = s.pausedAt ? now - s.pausedAt : 0;
    const currentBreakMs = s.phase === 'break'
      ? Math.max(0, now - s.phaseStartAt - s.pausedMs - pendingPauseMs) : 0;

    const record = {
      id: s.id,
      mode: s.mode,
      modeName: s.modeName,
      focusText: s.focusText,
      startTime: new Date(s.startedAt).toISOString(),
      endTime: new Date(now).toISOString(),
      durationMs: now - s.startedAt,
      activeMs: Math.max(0, now - s.startedAt - s.totalPausedMs - pendingPauseMs - s.totalBreakMs - currentBreakMs),
      rounds: s.round,
      notesCount: s.notesCount
    };

    this.session = null;
    this._lastPhase = null;

    record.saved = record.activeMs >= 15 * MINUTE;
    if (record.saved) this._persist(record);
    this.onLog(record.saved
      ? `专注结束 · ${record.modeName} · ${Math.round(record.activeMs / 60000)} 分钟`
      : '专注不足 15 分钟，未保存', 'info');
    this.onEnd(record);
    return record;
  }

  /** 每秒由主进程调用 */
  tick() {
    if (!this.session) return null;
    const now = Date.now();
    if (this.session.pausedAt) return this.getState();

    if (this.session.phase !== 'open') {
      const remaining = this._phaseRemaining(now);
      if (remaining <= 0) {
        this._advance(now, false);
      }
    }

    const state = this.getState();
    if (state && state.phase !== this._lastPhase) {
      this._lastPhase = state.phase;
      this.onPhaseChange(state);
    }
    return state;
  }

  // --- 阶段推进 ---

  _phaseDuration(phase) {
    if (!this.session) return 0;
    const min = phase === 'break' ? this.session.breakMin : this.session.workMin;
    return min * MINUTE;
  }

  _phaseRemaining(now) {
    if (!this.session || this.session.phase === 'open') return 0;
    const elapsed = now - this.session.phaseStartAt - this.session.pausedMs;
    return Math.max(0, this._phaseDuration(this.session.phase) - elapsed);
  }

  _advance(now, manual) {
    const s = this.session;
    if (!s) return;

    if (s.phase === 'work') {
      if (s.breakMin > 0) {
        s.phase = 'break';
        s.phaseStartAt = now;
        s.pausedMs = 0;
        s.pausedAt = null;
        return;
      }
      // 没有休息时长，直接进入下一轮或结束
      if (!s.rounds || s.round > s.rounds) return this.end();
      s.round += 1;
      s.phaseStartAt = now;
      s.pausedMs = 0;
      return;
    }

    if (s.phase === 'break') {
      s.totalBreakMs += Math.max(0, now - s.phaseStartAt - s.pausedMs);
      if (s.rounds > 0 && s.round >= s.rounds) {
        return this.end();
      }
      s.phase = 'work';
      s.round += 1;
      s.phaseStartAt = now;
      s.pausedMs = 0;
      s.pausedAt = null;
      return;
    }

    // phase === 'open' 永不自动结束
    if (manual) {
      this.onLog('罗汉模式没有阶段可跳，直接结束即可', 'info');
    }
  }

  // --- 杂念 ---

  addNote(text, category) {
    if (!this.arhatManager) return null;
    const note = this.arhatManager.addNote(text, category || 'random');
    if (this.session && note) this.session.notesCount += 1;
    return note;
  }

  // --- 状态 ---

  getState() {
    const s = this.session;
    if (!s) return { active: false };

    const now = Date.now();
    const paused = !!s.pausedAt;
    const isOpen = s.phase === 'open';

    let remainingMs = 0;
    let durationMs = 0;
    let elapsedMs = 0;
    let progress = 0;

    if (isOpen) {
      elapsedMs = Math.max(0, now - s.startedAt - s.totalPausedMs);
    } else {
      durationMs = this._phaseDuration(s.phase);
      remainingMs = this._phaseRemaining(now);
      elapsedMs = Math.max(0, durationMs - remainingMs);
      progress = durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 0;
    }

    return {
      active: true,
      id: s.id,
      mode: s.mode,
      modeName: s.modeName,
      tint: s.tint,
      phase: s.phase,
      phaseLabel: PHASE_LABEL[s.phase] || '专注中',
      round: s.round,
      totalRounds: s.rounds,
      paused,
      focusText: s.focusText,
      notesCount: s.notesCount,
      startedAt: new Date(s.startedAt).toISOString(),
      remainingMs,
      durationMs,
      elapsedMs,
      progress,
      clock: isOpen ? formatClock(elapsedMs) : formatClock(remainingMs),
      totalActiveMs: Math.max(0, now - s.startedAt - s.totalPausedMs)
    };
  }

  getSessionRaw() {
    return this.session;
  }

  // --- 持久化 ---

  _persist(record) {
    if (!this.arhatManager) return;
    try {
      const dir = this.arhatManager.sessionsDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${dateStr(new Date(record.startTime).getTime())}.json`);
      let items = [];
      if (fs.existsSync(file)) {
        try {
          items = JSON.parse(fs.readFileSync(file, 'utf8')) || [];
        } catch (e) {
          items = [];
        }
      }
      items.push(record);
      fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
    } catch (error) {
      this.onLog('保存专注记录失败: ' + error.message, 'error');
    }
  }
}

module.exports = FocusManager;
module.exports.PRESETS = PRESETS;
module.exports.formatClock = formatClock;
