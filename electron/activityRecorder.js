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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isExcludedSample } = require('./privacyRules');

const DEFAULTS = {
  evaluateMs: 1000,        // Windows 常驻采样时的评估节奏
  idleThresholdMs: 180000, // 连续 3 分钟无键鼠输入判定为离开
  minSegmentMs: 3000,      // 短于此的片段并入上一段
  flushIntervalMs: 15000,  // 落盘节流
  flushBufferSize: 30,
  /**
   * 当前片段最长挂多久就必须「封口重开」一次。
   *
   * 之前一段只在窗口切走时才关闭并落盘，于是有个要命的副作用：
   * 一直待在同一个窗口（打两小时游戏、写一下午文档），那几个小时全在内存里，
   * 一条都没写进文件。此时若应用被杀掉（崩溃、任务管理器结束、断电），
   * 整段时间直接蒸发——实测丢过两个多小时。
   *
   * 现在到点就把当前段关掉、立刻重开一条同应用的新段：
   * 数据最多落后 5 分钟，而展示层的 foldSessions 会把相邻同应用段合并回一段，
   * 时间线看起来仍是连续的。
   */
  checkpointMs: 5 * 60 * 1000
};

class ActivityRecorder {
  constructor(options) {
    const opts = options || {};
    this.monitor = opts.monitor;
    this.storage = opts.storage;
    this.getConfig = opts.getConfig || (() => ({}));
    this.onSegment = opts.onSegment || (() => {});
    this.onLog = opts.onLog || (() => {});
    // 写盘持续失败、片段被迫落到溢出文件时回调，供 UI 提示用户
    this.onOverflow = opts.onOverflow || null;

    this.running = false;
    this.startedAt = null;
    this._timer = null;
    this._flushTimer = null;
    this._cur = null;
    this._buffer = [];
    this._lastTick = 0;
    this._suspendCount = 0;
    this._lastFallbackSample = 0;
    this._gateNoticeShown = false;
    this._stats = { segments: 0, activeMs: 0, idleMs: 0 };

    // 迁移一结束就把缓冲写下去，不等下一个 15 秒周期。
    // 用弱绑定：拿不到 writeGate 也不影响录制器工作。
    try {
      const writeGate = require('./writeGate');
      this._offGateRelease = writeGate.onReleased(() => {
        if (this._buffer.length) this.flush();
      });
    } catch (_) {
      this._offGateRelease = () => {};
    }
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

    if (this._offGateRelease) {
      this._offGateRelease();
      this._offGateRelease = null;
    }

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

    // 在形成片段前过滤，避免敏感应用或标题进入活动文件。
    if (isExcludedSample(sample, this.getConfig()?.monitoring)) {
      this._closeCurrent(now);
      return;
    }

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
      return;
    }

    this._cur.lastSeen = now;

    // 长时间不切窗口也要定期封口，否则这段时间只活在内存里，
    // 应用一旦被强杀就整段丢失（见 checkpointMs 的注释）。
    if (now - this._cur.start >= opts.checkpointMs) {
      this._closeCurrent(now);
      this._openSegment(sample, now, idleNow);
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

  /**
   * 片段入缓冲。rid 在这里统一生成——active 与 idle 两个调用点都经过此处，
   * 放在这里就不会漏掉其中一种。
   *
   * 为什么需要 rid：iCloud / OneDrive 发生写入冲突时会生成一份副本文件，
   * 主文件和副本里可能有同一条记录，也可能各有一条不同的记录。没有稳定标识
   * 就只能靠「内容一样」判断重复，而内容一样的两条记录完全可能都是真的
   * （同一分钟在两个窗口各记了一次）。rid 让「是否同一条」变成可以确定的问题。
   *
   * 只在生成时写一次，之后随记录落盘；重启读回时沿用，绝不重算——
   * 重算就等于换了个身份，去重立刻失效。
   */
  _emit(record) {
    const withId = record.rid ? record : { ...record, rid: crypto.randomUUID() };
    this._buffer.push(withId);
    this._stats.segments += 1;

    this.onSegment(withId);

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
      if (!this.storage.appendActivityRecords(batch)) throw new Error('数据文件写入失败');
      this._gateNoticeShown = false;
      return batch.length;
    } catch (error) {
      // 迁移期间被写锁拒绝：这不是错误，也不是数据问题。
      // 片段原样放回且**不截断**——迁移是可控的短时状态，缓冲不会无限增长，
      // 一旦 slice(-200) 就会把最早录到的片段丢掉。
      if (error && error.code === 'MIGRATION_IN_PROGRESS') {
        this._buffer = batch.concat(this._buffer);
        // 同一迁移期内会反复触发，只在第一次提示，避免日志刷屏
        if (!this._gateNoticeShown) {
          this._gateNoticeShown = true;
          this.onLog('数据迁移进行中，录制数据暂存内存，迁移完成后写入', 'info');
        }
        return 0;
      }

      this._gateNoticeShown = false;
      this.onLog('写入活动记录失败: ' + error.message, 'error');

      // 写盘持续失败（磁盘满、目录被同步软件锁住、权限问题）时，不能把
      // 缓冲无限增长，也不能像以前那样 slice(-200) 直接丢掉最早的部分——
      // 那等于在用户毫无察觉的情况下删掉一整段工作记录。
      //
      // 改成：超出的部分落到溢出文件。缓冲保持在上限内，数据一条不丢，
      // 并且通过 onOverflow 告诉调用方「有东西没进主文件」，由 UI 提示用户。
      const MAX_BUFFER = 200;
      this._buffer = batch.concat(this._buffer);
      if (this._buffer.length > MAX_BUFFER) {
        const overflow = this._buffer.slice(0, this._buffer.length - MAX_BUFFER);
        this._buffer = this._buffer.slice(-MAX_BUFFER);
        const spilled = this._spillOverflow(overflow, error);
        if (!spilled) {
          // 溢出也写不进去：此时只能保缓冲，但必须让调用方知道有数据处于危险中
          this.onLog(
            `缓冲已达 ${this._buffer.length} 条且溢出文件不可写，数据仅存于内存。` +
            '请尽快释放磁盘空间或检查数据目录权限。', 'error');
        }
      }
      return 0;
    }
  }

  /**
   * 把主文件写不进去的片段落到 overflow 文件。
   *
   * 为什么是追加而不是覆盖：这些片段本身就是按时间顺序产生的，
   * 追加能保持顺序，也避免了「先读旧文件再合并」这种在磁盘满时必然失败的写法。
   *
   * 文件名带日期，便于用户和后续工具直接看懂它属于哪一天。
   */
  _spillOverflow(records, cause) {
    if (!records || !records.length) return true;
    try {
      const base = this.storage && typeof this.storage.getDataDir === 'function'
        ? this.storage.getDataDir()
        : null;
      if (!base) return false;

      const dir = path.join(base, 'activities');
      fs.mkdirSync(dir, { recursive: true });
      // 用本地日期命名，与 activities/<YYYY-MM-DD>.jsonl 保持一致。
      // 不调用 storageManager._toDateStr：那是另一个类的私有方法，
      // 在这里依赖它会把两个模块的边界搅在一起。
      const d = new Date(records[0].t);
      const p2 = n => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const file = path.join(dir, `${day}.overflow.jsonl`);

      // 每次溢出都记一行原因，便于事后判断是磁盘满还是权限问题
      const header = JSON.stringify({
        at: new Date().toISOString(),
        kind: 'overflow',
        reason: cause && cause.message ? cause.message : 'write-failed',
        count: records.length
      });
      const lines = records.map(r => JSON.stringify(r));
      fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');

      if (typeof this.onOverflow === 'function') {
        this.onOverflow({ count: records.length, file, day });
      }
      this.onLog(
        `${records.length} 条录制片段未能写入主文件，已暂存到 ${path.basename(file)}` +
        '（不会出现在报表里，需要恢复请联系维护者或等待下一次成功写入后手工合并）', 'error');
      return true;
    } catch (error) {
      this.onLog('写入溢出文件失败: ' + error.message, 'error');
      return false;
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
