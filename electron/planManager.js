'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomicFile');
const { REPEATS, matchesRepeat } = require('./holidays');

function pad(n) { return String(n).padStart(2, '0'); }

function timeToMin(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minToTime(value) {
  const min = Math.max(0, Math.min(1439, Math.round(Number(value) || 0)));
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/**
 * 本地计划层。
 *
 * 计划与活动记录分文件保存。actuals 只记“这个计划已经通过哪条路径确认”，
 * 不参与工时统计；真正的事实仍由 activities/ 或原始屏幕活动提供。
 */
class PlanManager {
  constructor(getDataDir) {
    this.getDataDir = getDataDir;
  }

  file() { return path.join(this.getDataDir(), 'plans', 'local.json'); }

  read() {
    try {
      const file = this.file();
      if (!fs.existsSync(file)) return { items: [], actuals: {} };
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        items: Array.isArray(data.items) ? data.items : [],
        actuals: data.actuals && typeof data.actuals === 'object' ? data.actuals : {}
      };
    } catch (_) {
      return { items: [], actuals: {} };
    }
  }

  write(data) {
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ version: 1, ...data }, null, 2));
  }

  /**
   * 把旧版日程中同名的「午夜前」和「午夜后」每日计划合成一条跨日计划。
   * 只处理完全相同、没有单次调整或确认记录的配对；迁移前保留原文件备份。
   */
  mergeLegacyOvernightPlans() {
    const file = this.file();
    if (!fs.existsSync(file)) return 0;
    const data = this.read();
    const used = new Set();
    const additions = [];
    let merged = 0;
    for (const late of data.items) {
      if (late.repeat !== 'daily' || late.startMin <= 0 || late.startMin + late.durationMin !== 1440 ||
          (late.exceptions || []).length || used.has(late.localId)) continue;
      const early = data.items.find(item => item.localId !== late.localId && !used.has(item.localId) &&
        item.repeat === 'daily' && item.date === late.date && item.startMin === 0 &&
        item.durationMin > 0 && late.startMin + late.durationMin + item.durationMin <= 2880 &&
        item.repeatEnd === late.repeatEnd && !(item.exceptions || []).length &&
        item.label === late.label && item.category === late.category && item.project === late.project);
      if (!early) continue;
      const hasActual = Object.keys(data.actuals).some(key =>
        key.startsWith(`local-plan:${late.localId}:`) || key.startsWith(`local-plan:${early.localId}:`));
      if (hasActual) continue;
      late.durationMin += early.durationMin;
      late.updatedAt = new Date().toISOString();
      // 第一日凌晨原本有计划，系列合并后用一条单次计划保留它。
      additions.push({ ...early, localId: crypto.randomUUID(), repeat: 'none', repeatEnd: '',
        exceptions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      used.add(early.localId);
      merged += 1;
    }
    if (!merged) return 0;
    fs.copyFileSync(file, `${file}.before-overnight-merge-${Date.now()}.bak`);
    data.items = data.items.filter(item => !used.has(item.localId)).concat(additions);
    this.write(data);
    return merged;
  }

  keyOf(plan, date) {
    const source = plan.source || 'local-plan';
    const identity = plan.templateId || plan.localId || plan.id || '';
    return `${source}:${identity}:${date || plan.date || ''}`;
  }

  decorate(items, date) {
    const data = this.read();
    return (items || []).map(item => ({
      ...item,
      planKey: this.keyOf(item, date),
      actual: data.actuals[this.keyOf(item, date)] || null
    }));
  }

  /**
   * 这条计划在某个日期是否生效。
   * repeat = 'none' 只匹配自己的日期；其余按规则 + 结束日 + 例外展开。
   */
  matchesDate(item, date) {
    const repeat = item.repeat || 'none';
    if (repeat === 'none') return item.date === date;
    if (!date || date < item.date) return false;
    if (item.repeatEnd && date > item.repeatEnd) return false;
    if (Array.isArray(item.exceptions) && item.exceptions.includes(date)) return false;
    return matchesRepeat(repeat, date);
  }

  listForDate(date) {
    const data = this.read();
    const rows = data.items.filter(item => this.matchesDate(item, date)).map(item => {
      const startMin = Number(item.startMin) || 0;
      const durationMin = Math.max(15, Number(item.durationMin) || 30);
      const start = new Date(`${date}T00:00:00`);
      start.setMinutes(startMin);
      return {
        ...item,
        // 展开实例的日期是当天，不是系列起始日
        date,
        seriesDate: item.date,
        id: `local:${item.localId}:${date}`,
        source: 'local-plan',
        start: start.toISOString(),
        end: new Date(start.getTime() + durationMin * 60000).toISOString(),
        startMin,
        endMin: Math.min(1440, startMin + durationMin),
        fullEndMin: startMin + durationMin,
        durationMin,
        repeat: item.repeat || 'none',
        actual: data.actuals[this.keyOf(item, date)] || null,
        planKey: this.keyOf(item, date)
      };
    });
    const previous = new Date(`${date}T00:00:00`);
    previous.setDate(previous.getDate() - 1);
    const previousDate = `${previous.getFullYear()}-${pad(previous.getMonth() + 1)}-${pad(previous.getDate())}`;
    for (const item of data.items.filter(plan => this.matchesDate(plan, previousDate))) {
      const overflow = (Number(item.startMin) || 0) + (Number(item.durationMin) || 0) - 1440;
      if (overflow <= 0) continue;
      const key = this.keyOf(item, previousDate);
      rows.push({ ...item, date, originDate: previousDate, originStartMin: item.startMin,
        originDurationMin: item.durationMin,
        id: `local:${item.localId}:${previousDate}:carry`, source: 'carryover-plan',
        startMin: 0, endMin: Math.min(1440, overflow), durationMin: Math.min(1440, overflow),
        planKey: key, actual: data.actuals[key] || null });
    }
    return rows.sort((a, b) => a.startMin - b.startMin);
  }

  upsert(payload) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date || '')) ? payload.date : '';
    const startMin = payload?.startMin === undefined ? timeToMin(payload?.startTime) : Number(payload.startMin);
    const durationMin = Math.max(15, Math.round((Number(payload?.durationMin) || 30) / 15) * 15);
    const label = String(payload?.label || payload?.title || '').trim().slice(0, 100);
    if (!date || !Number.isFinite(startMin) || startMin < 0 || startMin >= 1440) {
      return { ok: false, error: '计划日期或开始时间无效' };
    }
    if (!label) return { ok: false, error: '请填写计划内容' };

    const data = this.read();
    const localId = String(payload?.localId || '').trim() || crypto.randomUUID();
    const current = data.items.find(item => item.localId === localId);
    const repeat = REPEATS.includes(payload?.repeat) && payload.repeat !== 'none'
      ? payload.repeat : 'none';
    const repeatEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.repeatEnd || ''))
      ? payload.repeatEnd : '';
    const next = {
      localId,
      // 重复计划的 date 是系列起始日；单次计划就是它发生的那天
      date,
      startMin: Math.floor(startMin / 15) * 15,
      durationMin: Math.min(1440, 2880 - Math.floor(startMin / 15) * 15, durationMin),
      label,
      title: label,
      category: String(payload?.category || '其他').trim() || '其他',
      project: String(payload?.project || '').trim().slice(0, 60),
      repeat,
      repeatEnd,
      exceptions: current?.exceptions || [],
      createdAt: current?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const occurrenceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.occurrenceDate || ''))
      ? payload.occurrenceDate : '';
    const scope = payload?.scope;
    if (current && current.repeat !== 'none' && occurrenceDate && occurrenceDate >= current.date &&
        (scope === 'single' || scope === 'future')) {
      if (scope === 'single') {
        current.exceptions = [...new Set([...(current.exceptions || []), occurrenceDate])];
        current.updatedAt = new Date().toISOString();
        next.localId = crypto.randomUUID();
        next.repeat = 'none';
        next.repeatEnd = '';
        next.exceptions = [];
        data.items.push(next);
      } else if (occurrenceDate === current.date) {
        data.items = data.items.map(item => item.localId === localId ? next : item);
      } else {
        const before = new Date(`${occurrenceDate}T00:00:00`);
        before.setDate(before.getDate() - 1);
        current.repeatEnd = `${before.getFullYear()}-${pad(before.getMonth() + 1)}-${pad(before.getDate())}`;
        current.updatedAt = new Date().toISOString();
        next.localId = crypto.randomUUID();
        next.createdAt = new Date().toISOString();
        next.exceptions = (current.exceptions || []).filter(day => day >= occurrenceDate);
        data.items.push(next);
      }
      this.write(data);
      return { ok: true, item: next };
    }
    data.items = current
      ? data.items.map(item => item.localId === localId ? next : item)
      : [...data.items, next];
    this.write(data);
    return { ok: true, item: next };
  }

  remove(localId) {
    const data = this.read();
    const before = data.items.length;
    data.items = data.items.filter(item => item.localId !== localId);
    if (data.items.length === before) return { ok: false, error: '没有找到这条本地计划' };
    // 历史 actual 保留，避免删除计划时误删已经产生的事实来源说明。
    this.write(data);
    return { ok: true };
  }

  /**
   * 只取消重复计划的某一天，不删除整个系列。
   * 单次计划或系列第一天仍然按「整条删除」处理。
   */
  removeOccurrence(localId, date) {
    const data = this.read();
    const item = data.items.find(row => row.localId === localId);
    if (!item) return { ok: false, error: '没有找到这条计划' };
    if ((item.repeat || 'none') === 'none' || item.date === date) {
      return this.remove(localId);
    }
    item.exceptions = [...new Set([...(item.exceptions || []), date])];
    item.updatedAt = new Date().toISOString();
    this.write(data);
    return { ok: true, skipped: date };
  }

  markActual(plan, date, actual) {
    const data = this.read();
    const key = this.keyOf(plan, date);
    data.actuals[key] = {
      source: actual.source === 'screen' ? 'screen' : 'plan',
      label: String(actual.label || plan.label || plan.title || '').slice(0, 100),
      category: String(actual.category || plan.category || '其他'),
      startMin: Number(actual.startMin ?? plan.startMin) || 0,
      durationMin: Math.max(1, Math.round(Number(actual.durationMin) || Number(plan.durationMin) || 15)),
      confirmedAt: new Date().toISOString()
    };
    this.write(data);
    return { ok: true, key, actual: data.actuals[key] };
  }
}

module.exports = { PlanManager, timeToMin, minToTime };
