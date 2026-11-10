'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomicFile');

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

  listForDate(date) {
    const data = this.read();
    const rows = data.items.filter(item => item.date === date).map(item => {
      const startMin = Number(item.startMin) || 0;
      const durationMin = Math.max(15, Number(item.durationMin) || 30);
      const start = new Date(`${date}T00:00:00`);
      start.setMinutes(startMin);
      return {
        ...item,
        id: `local:${item.localId}:${date}`,
        source: 'local-plan',
        start: start.toISOString(),
        end: new Date(start.getTime() + durationMin * 60000).toISOString(),
        startMin,
        endMin: Math.min(1440, startMin + durationMin),
        durationMin,
        repeat: false,
        actual: data.actuals[this.keyOf(item, date)] || null,
        planKey: this.keyOf(item, date)
      };
    });
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
    const next = {
      localId,
      date,
      startMin: Math.floor(startMin / 15) * 15,
      durationMin: Math.min(1440 - Math.floor(startMin / 15) * 15, durationMin),
      label,
      title: label,
      category: String(payload?.category || '其他').trim() || '其他',
      project: String(payload?.project || '').trim().slice(0, 60),
      createdAt: current?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
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
