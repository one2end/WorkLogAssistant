<template>
  <div class="datenav" @mousedown.stop>
    <button class="nav-btn" title="前一天" @click="$emit('shift', -1)">
      <Icon name="chevronLeft" :size="15" />
    </button>

    <button ref="trigger" class="date-btn" @click="toggle">
      <Icon name="calendar" :size="13" />
      <span class="date-label">{{ label }}</span>
      <Icon name="chevronDown" :size="12" class="date-caret" />
    </button>

    <button class="nav-btn" :disabled="isToday" title="后一天" @click="$emit('shift', 1)">
      <Icon name="chevronRight" :size="15" />
    </button>

    <button v-if="!isToday" class="today-chip" @click="$emit('today')">今天</button>

    <transition name="pop">
      <div v-if="open" class="cal-pop" :style="popStyle">
        <div class="cal-head">
          <button class="nav-btn" @click="shiftMonth(-1)"><Icon name="chevronLeft" :size="14" /></button>
          <span class="cal-title">{{ viewYear }}年{{ viewMonth + 1 }}月</span>
          <button class="nav-btn" @click="shiftMonth(1)"><Icon name="chevronRight" :size="14" /></button>
        </div>

        <div class="cal-week">
          <span v-for="d in weekdays" :key="d">{{ d }}</span>
        </div>

        <div class="cal-grid">
          <button
            v-for="day in days"
            :key="day.key"
            class="cal-day"
            :class="{
              muted: !day.inMonth,
              today: day.isToday,
              selected: day.dateStr === selectedDate,
              future: day.isFuture
            }"
            :disabled="day.isFuture"
            @click="pick(day)"
          >
            {{ day.day }}
            <span v-if="hasData(day.dateStr)" class="cal-dot"></span>
          </button>
        </div>

        <div class="cal-foot">
          <span class="cal-legend"><span class="cal-dot static"></span> 有记录</span>
          <button class="btn btn-ghost btn-sm" @click="pickToday">跳到今天</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import Icon from './Icon.vue';

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default {
  name: 'DateNav',
  components: { Icon },
  props: {
    selectedDate: { type: String, required: true },
    datesWithData: { type: Set, default: () => new Set() }
  },
  emits: ['update:selectedDate', 'shift', 'today'],
  data() {
    const base = new Date(this.selectedDate + 'T00:00:00');
    return {
      open: false,
      viewYear: base.getFullYear(),
      viewMonth: base.getMonth(),
      weekdays: ['日', '一', '二', '三', '四', '五', '六'],
      popStyle: {}
    };
  },
  computed: {
    todayStr() {
      return localDateStr(new Date());
    },
    isToday() {
      return this.selectedDate === this.todayStr;
    },
    label() {
      const d = new Date(this.selectedDate + 'T00:00:00');
      if (this.selectedDate === this.todayStr) return '今天';
      const y = new Date(Date.now() - 86400000);
      if (this.selectedDate === localDateStr(y)) return '昨天';
      const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return sameYear
        ? `${d.getMonth() + 1}月${d.getDate()}日 ${w}`
        : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${w}`;
    },
    days() {
      const year = this.viewYear;
      const month = this.viewMonth;
      const first = new Date(year, month, 1);
      const startDow = first.getDay();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const out = [];

      const prevEnd = new Date(year, month, 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        const day = prevEnd - i;
        const dt = new Date(year, month - 1, day);
        out.push(this.makeDay(dt, false, today));
      }
      const total = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= total; day++) {
        out.push(this.makeDay(new Date(year, month, day), true, today));
      }
      let next = 1;
      while (out.length % 7 !== 0 || out.length < 35) {
        out.push(this.makeDay(new Date(year, month + 1, next++), false, today));
      }
      return out;
    }
  },
  mounted() {
    document.addEventListener('mousedown', this.onDocDown);
  },
  beforeUnmount() {
    document.removeEventListener('mousedown', this.onDocDown);
  },
  methods: {
    makeDay(dt, inMonth, today) {
      const dateStr = localDateStr(dt);
      return {
        day: dt.getDate(),
        dateStr,
        inMonth,
        isToday: dateStr === localDateStr(today),
        isFuture: dt.getTime() > today.getTime(),
        key: dateStr + (inMonth ? '' : '-x')
      };
    },
    hasData(dateStr) {
      return this.datesWithData && this.datesWithData.has(dateStr);
    },
    toggle() {
      if (!this.open) {
        const base = new Date(this.selectedDate + 'T00:00:00');
        this.viewYear = base.getFullYear();
        this.viewMonth = base.getMonth();
      }
      this.open = !this.open;
    },
    onDocDown(e) {
      if (this.open && this.$el && !this.$el.contains(e.target)) {
        this.open = false;
      }
    },
    shiftMonth(delta) {
      const d = new Date(this.viewYear, this.viewMonth + delta, 1);
      this.viewYear = d.getFullYear();
      this.viewMonth = d.getMonth();
    },
    pick(day) {
      if (day.isFuture) return;
      this.$emit('update:selectedDate', day.dateStr);
      this.open = false;
    },
    pickToday() {
      this.$emit('update:selectedDate', this.todayStr);
      this.open = false;
    }
  }
};
</script>

<style scoped>
.datenav {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}

.nav-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.nav-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.date-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  font-size: var(--fs-12);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}

.date-btn:hover {
  border-color: var(--border-default);
  background: var(--bg-elevated);
}

.date-label {
  min-width: 68px;
  text-align: center;
}

.date-caret {
  color: var(--text-tertiary);
}

.today-chip {
  height: 24px;
  padding: 0 9px;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-11);
  font-weight: var(--fw-medium);
  margin-left: 2px;
}

.today-chip:hover {
  background: var(--accent);
  color: var(--on-accent);
}

/* 日历弹层 */
.cal-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 50;
  width: 248px;
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-lg);
}

.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
}

.cal-title {
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}

.cal-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 2px;
}

.cal-week span {
  text-align: center;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
  padding: 2px 0;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}

.cal-day {
  position: relative;
  height: 28px;
  border-radius: var(--r-xs);
  font-size: var(--fs-12);
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}

.cal-day:hover:not(:disabled) {
  background: var(--bg-hover);
}

.cal-day.muted {
  color: var(--text-tertiary);
  opacity: 0.5;
}

.cal-day.future {
  color: var(--text-tertiary);
  opacity: 0.3;
}

.cal-day.today {
  color: var(--accent);
  font-weight: var(--fw-semibold);
}

.cal-day.selected {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-semibold);
}

.cal-dot {
  position: absolute;
  bottom: 3px;
  left: 50%;
  transform: translateX(-50%);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
}

.cal-day.selected .cal-dot {
  background: var(--on-accent);
}

.cal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

.cal-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-10);
  color: var(--text-tertiary);
}

.cal-dot.static {
  position: static;
  transform: none;
}

.pop-enter-active,
.pop-leave-active {
  transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease);
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
