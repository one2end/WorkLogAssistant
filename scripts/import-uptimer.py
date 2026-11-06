#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 UpTimer 的本地记录（Couchbase Lite 库）导入 WorkLog Assistant。

背景：UpTimer 用 Couchbase Lite 存储，db.sqlite3 里 kv_default.body 是 Fleece
二进制。文档 key 是 19 位纳秒时间戳（= 记录时刻），正文里只有活动名、标签 ID
和经纬度，**没有结束时间**。所以这里把「记录点 → 下一条记录」的间隔当作时长，
上限 2 小时、下限 5 分钟，并在记录上标 source=uptimer 以便和其它数据区分。

用法：
    python scripts/import-uptimer.py <db.sqlite3> [--write]

只追加写 activities/YYYY-MM-DD.jsonl，不修改、不删除任何已有文件。
"""
import sqlite3
import re
import json
import os
import sys
import datetime
import collections

DB = None
WRITE = '--write' in sys.argv
for a in sys.argv[1:]:
    if not a.startswith('--'):
        DB = a
if not DB:
    print('用法: python scripts/import-uptimer.py <db.sqlite3> [--write]')
    sys.exit(1)

# 活动名 → (分类, kind)。UpTimer 的活动名很口语，只能粗分。
RULES = [
    ('空闲离座', 'idle', ['睡觉', '午睡', '补觉', '休息']),
    ('影音娱乐', 'active', ['游戏', '小说', '视频', '刷', '看剧', '电影', '直播']),
    ('沟通协作', 'active', ['开会', '会议', '聊天', '沟通', '聚会', '串门']),
    ('文档写作', 'active', ['写', '笔记', '整理', '学习', '读书', '听课', '上课']),
    ('任务与效率', 'active', ['工作', '上班', '加班', '事']),
    ('生活事务', 'active', ['吃饭', '午饭', '晚饭', '早饭', '洗漱', '洗澡', '洗手间',
                           '食堂', '回家', '出门', '陪孩子', '家务', '买菜', '跑步',
                           '运动', '健身', '看病', '医院']),
]


def classify(title):
    for cat, kind, keys in RULES:
        if any(k in title for k in keys):
            return cat, kind
    return '生活事务', 'active'


def data_dir():
    appdata = os.environ.get('APPDATA') or os.path.expanduser('~/AppData/Roaming')
    cfg = os.path.join(appdata, 'worklog-assistant', 'config.json')
    try:
        with open(cfg, encoding='utf-8') as f:
            c = json.load(f)
        p = (c.get('storage') or {}).get('customPath')
        if p:
            return p
    except Exception:
        pass
    return os.path.join(appdata, 'worklog-assistant', 'Data')


# 1. 从库里取记录：key 是纳秒时间戳，body 里抓第一段中文当活动名
con = sqlite3.connect(DB)
cur = con.cursor()
rows = cur.execute('select key, body from kv_default').fetchall()
con.close()

cn = re.compile(r'[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9，。、：？！\-_（）() ]{0,40}')
recs = []
for k, b in rows:
    ks = str(k)
    if not ks.isdigit() or len(ks) != 19:
        continue
    txt = b.decode('utf-8', errors='ignore')
    names = [m.group().strip() for m in cn.finditer(txt)
             if len(m.group().strip()) >= 2 and not m.group().startswith('D4558')]
    if not names:
        continue
    ts = int(ks) / 1e9
    recs.append((ts, names[0]))

recs.sort()
print('UpTimer 记录:', len(recs))
if not recs:
    sys.exit(0)

# 2. 时长 = 到下一条记录的间隔，夹在 [5min, 2h]
# UpTimer 记录的是「补记时刻」，相邻两条的间隔并不等于活动时长
# （可能隔了 3 天）。这里统一给 30 分钟，只表达"这个时刻记了这件事"，
# 避免凭空造出一天 8 小时的工时。
FIXED_DUR = 30 * 60
items = [(ts, FIXED_DUR, title) for ts, title in recs]

# 3. 按天分桶（跨天拆开）
act_dir = os.path.join(data_dir(), 'activities')
if not os.path.isdir(act_dir):
    os.makedirs(act_dir, exist_ok=True)

REBUILD = '--rebuild' in sys.argv

existing = {}
for f in os.listdir(act_dir):
    if not f.endswith('.jsonl'):
        continue
    d = f.split('.')[0]
    keys = set()
    kept = []
    with open(os.path.join(act_dir, f), encoding='utf-8', errors='ignore') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                kept.append(line)
                continue
            if REBUILD and r.get('source') == 'uptimer':
                continue          # 重建：丢弃旧的 uptimer 行
            kept.append(line)
            keys.add(f"{r.get('t')}|{r.get('dur')}")
    existing[d] = keys
    if REBUILD:
        with open(os.path.join(act_dir, f), 'w', encoding='utf-8') as fh:
            if kept:
                fh.write('\n'.join(kept) + '\n')

by_day = collections.defaultdict(list)
for ts, dur, title in items:
    cur_dt = datetime.datetime.fromtimestamp(ts)
    end_dt = cur_dt + datetime.timedelta(seconds=dur)
    cat, kind = classify(title)
    # 跨天切成两段
    while cur_dt < end_dt:
        midnight = datetime.datetime.combine(
            (cur_dt + datetime.timedelta(days=1)).date(), datetime.time(0, 0))
        seg_end = min(end_dt, midnight)
        seg = (seg_end - cur_dt).total_seconds()
        if seg >= 60:
            day = cur_dt.strftime('%Y-%m-%d')
            by_day[day].append({
                't': cur_dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                'dur': int(round(seg * 1000)),
                'kind': kind,
                'app': title[:12],
                'title': title[:120],
                'platform': 'uptimer',
                'source': 'uptimer',
                'cat': cat,
            })
        cur_dt = seg_end

total = 0
days = []
for d in sorted(by_day):
    keep = [r for r in by_day[d] if f"{r['t']}|{r['dur']}" not in existing.get(d, set())]
    if not keep:
        continue
    total += len(keep)
    days.append((d, len(keep)))
    if WRITE:
        with open(os.path.join(act_dir, f'{d}.jsonl'), 'a', encoding='utf-8') as fh:
            for r in keep:
                fh.write(json.dumps(r, ensure_ascii=False) + '\n')

cat_cnt = collections.Counter(r['cat'] for lst in by_day.values() for r in lst)
print('写入天数:', len(days), ' 条数:', total)
print('分类:', dict(cat_cnt))
print('范围:', days[0][0] if days else '-', '~', days[-1][0] if days else '-')
print('已写入' if WRITE else '仅预览（加 --write 才写盘）')
