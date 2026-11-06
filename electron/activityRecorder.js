'use strict';

/**
 * activityRecorder.js — 活动录制器
 *
 * 职责：按固定节奏采样前台窗口，把连续相同的状态合并成「片段」，片段结束时
 * 带着精确的 durationMs 落盘（JSONL 追加），并区分 active / idle。
 *
 * 和旧实现的关键差别：
 *   旧：只在窗口切换时记一条裸时间戳，时长靠条数 × 采样间隔去猜。
 *   新：每个片段自带真实时长，空闲段单独标记，读的时候不需要再推断。
 *
 * 边界处理：
 *   - 系统休眠/唤醒：tick 间隔异常拉长时，把当前片段截止到最后一个正常 tick，不把休眠算进工时
 *   - 同应用短促切换：短于 minSegmentMs 的片段并入上一段，避免时间线碎片化
 */

const MAX_IDLE_SEGMENT_MS = 2 * 60 * 60 * 1000; // 单段空闲最多记 2 小时

const DEFAULTS = {
  evaluateMs: 1000,        // Windows 常驻采样时的评估节奏
  idleThresholdMs: 180000, // 连续 3 分钟无键鼠输入判定为离开
  minSegmentMs: 3000,      // 短于此的片段并入上一段
  flushIntervalMs: 15000,  // 落盘节流
  flushBufferSize: 30
};

class ActivityRecorder {
  constructor(options) {
    const opts = options || {};
    this.monitor = opts.monitor;
    this.storage = opts.storage;
    this.getConfig = opts.getConfig || (() => ({}));
    this.onSegment = opts.onSegment || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.running = false;
    this.startedAt = null;
    this._timer = null;
    this._flushTimer = null;
    this._cur = null;
    this._buffer = [];
    this._lastTick = 0;
    this._suspendCount = 0;
    this._lastFallbackSample = 0;
    this._stats = { segments: 0, activeMs: 0, idleMs: 0 };
  }

  // --- 配置读取 ---

  _opts() {
    const cfg = this.getConfig() || {};
    const m = cfg.monitoring || {};
    const persistent = this.monitor && this.monitor.isPersistent();

    return {
      ...DEFAULTS,
      // 常驻采样时用 1 秒评估以求精确；否则只能按用户设置的间隔来
      evaluateMs: persistent
        ? DEFAULTS.evaluateMs
        : Math.max(5, parseInt(m.interval, 10) || 60) * 1000,
      idleThresholdMs: Math.max(30, parseInt(m.idleThresholdSec, 10) || 180) * 1000,
      minSegmentMs: Math.max(0, parseInt(m.minSegmentSec, 10) || 3) * 1000
    };
  }

  // --- 生命周期 ---

  async start() {
    if (this.running) return { ok: true, already: true };

    if (this.monitor && typeof this.monitor.start === 'function') {
      const r = await this.monitor.start();
      if (r && r.error) {
        this.onLog('采样器启动异常，将回退到按次采样: ' + r.error, 'error');
      } else if (r && r.persistent) {
        this.onLog('常驻采样已启动（1 秒精度，含空闲检测）', 'info');
      }
    }

    this.running = true;
    this.startedAt = Date.now();
    this._lastTick = Date.now();
    this._lastFallbackSample = 0;

    const { evaluateMs, flushIntervalMs } = this._opts();
    this.onLog('录制开始，评估间隔 ' + Math.round(evaluateMs / 1000) + ' 秒', 'info');

    this._timer = setInterval(() => this._tick(), evaluateMs);
    this._flushTimer = setInterval(() => this.flush(), flushIntervalMs);

    return { ok: true };
  }

  stop() {
    if (!this.running) return { ok: true, already: true };
    this.running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    // 收尾：把当前片段关掉并落盘
    this._closeCurrent(Date.now(), 'shutdown');
    this.flush();

    if (this.monitor && typeof this.monitor.stop === 'function') {
      this.monitor.stop();
    }

    this.onLog('录制已停止', 'info');
    return { ok: true };
  }

  // --- 采样与片段切分 ---

  async _tick() {
    if (!this.running) return;

    const opts = this._opts();
    const now = Date.now();

    // 系统休眠/唤醒：tick 被拉长了，把当前片段截止到上一个正常 tick
    const sinceLast = now - this._lastTick;
    if (sinceLast > opts.evaluateMs * 3 + 1000) {
      this._suspendCount += 1;
      this._closeCurrent(this._lastTick, 'suspend');
      this._lastTick = now;
      this.onLog('检测到系统休眠/唤醒，已截断当前片段', 'info');
      return;
    }
    this._lastTick = now;

    const sample = await this._sample(opts, now);
    if (!sample) return;

    const idleNow = (sample.idleMs || 0) >= opts.idleThresholdMs;

    if (!this._cur) {
      this._openSegment(sample, now, idleNow);
      return;
    }

    const changed = sample.processName !== this._cur.app
      || (sample.windowTitle || '') !== (this._cur.title || '');
    const idleChanged = idleNow !== this._cur.idle;

    if (changed || idleChanged) {
      this._closeCurrent(now);
      this._openSegment(sample, now, idleNow);
    } else {
      this._cur.lastSeen = now;
    }
  }

  async _sample(opts, now) {
    if (!this.monitor) return null;

    const cached = typeof this.monitor.latest === 'function' ? this.monitor.latest() : null;
    if (cached) return cached;

    // 非常驻平台（或常驻进程掉线）：按评估间隔做一次即时采样
    if (now - this._lastFallbackSample < opts.evaluateMs) return null;
    this._lastFallbackSample = now;

    try {
      return await this.monitor.sampleOnce();
    } catch (error) {
      this.onLog('采样失败: ' + error.message, 'error');
      return null;
    }
  }

  _openSegment(sample, now, idle) {
    this._cur = {
      app: sample.processName || 'unknown',
      title: sample.windowTitle || '',
      start: now,
      lastSeen: now,
      idle,
      platform: sample.platform || process.platform
    };
  }

  _closeCurrent(endTs, reason) {
    const cur = this._cur;
    this._cur = null;
    if (!cur) return;

    let dur = endTs - cur.start;

    if (reason === 'suspend') {
      // 休眠期间不算工时
      dur = Math.max(0, cur.lastSeen - cur.start);
    }

    if (dur <= 0) return;

    if (cur.idle) {
      const capped = Math.min(dur, MAX_IDLE_SEGMENT_MS);
      this._stats.idleMs += capped;
      this._emit({
        t: new Date(cur.start).toISOString(),
        dur: capped,
        kind: 'idle',
        app: cur.app,
        title: '',
        platform: cur.platform
      });
      return;
    }

    // 过短的片段并入上一段，减少时间线碎片
    const { minSegmentMs } = this._opts();
    const last = this._buffer[this._buffer.length - 1];
    if (minSegmentMs > 0 && dur < minSegmentMs && last && last.kind === 'active' && !last._flushed) {
      last.dur += dur;
      return;
    }

    this._stats.activeMs += dur;
    this._emit({
      t: new Date(cur.start).toISOString(),
      dur,
      kind: 'active',
      app: cur.app,
      title: cur.title,
      platform: cur.platform
    });
  }

  _emit(record) {
    this._buffer.push(record);
    this._stats.segments += 1;

    this.onSegment(record);

    if (this._buffer.length >= DEFAULTS.flushBufferSize) {
      this.flush();
    }
  }

  // --- 落盘 ---

  flush() {
    if (!this._buffer.length || !this.storage) return 0;

    const batch = this._buffer;
    this._buffer = [];

    try {
      this.storage.appendActivityRecords(batch);
      return batch.length;
    } catch (error) {
      this.onLog('写入活动记录失败: ' + error.message, 'error');
      // 放回去，下次再试（避免丢数据），但要防止无限增长
      this._buffer = batch.concat(this._buffer).slice(-200);
      return 0;
    }
  }

  // --- 状态查询 ---

  getStatus() {
    const opts = this._opts();
    return {
      running: this.running,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      persistentSampling: !!(this.monitor && this.monitor.isPersistent()),
      evaluateMs: opts.evaluateMs,
      idleThresholdMs: opts.idleThresholdMs,
      minSegmentMs: opts.minSegmentMs,
      current: this._cur
        ? {
            app: this._cur.app,
            title: this._cur.title,
            since: new Date(this._cur.start).toISOString(),
            elapsedMs: Date.now() - this._cur.start,
            idle: this._cur.idle
          }
        : null,
      pendingRecords: this._buffer.length,
      suspendCount: this._suspendCount,
      stats: { ...this._stats }
    };
  }
}

module.exports = ActivityRecorder;
module.exports.DEFAULTS = DEFAULTS;
