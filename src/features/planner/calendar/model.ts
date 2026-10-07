/**
 * Календарь (из shar-2): модель и арифметика дат. Календарь у каждого один — личный.
 *
 * Время хранится как в базе — локальное, без зоны: «2026-09-30T10:00:00».
 * Все вычисления тоже в локальном времени, через new Date(y, m, d, h, min).
 */

export type ColorName = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'yellow' | 'cyan' | 'gray';
export const COLORS: { id: ColorName; label: string }[] = [
  { id: 'blue', label: 'Синий' },
  { id: 'green', label: 'Зелёный' },
  { id: 'orange', label: 'Оранжевый' },
  { id: 'red', label: 'Красный' },
  { id: 'purple', label: 'Фиолетовый' },
  { id: 'yellow', label: 'Жёлтый' },
  { id: 'cyan', label: 'Бирюзовый' },
  { id: 'gray', label: 'Серый' },
];

export interface CalEvent {
  /** id строки; у повторения — «master::время». */
  id: string;
  /** Серия, если это одно из повторений. */
  masterId?: string;
  /** Начало этого повторения — ключ для правки «только это». */
  recurrenceId?: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  color?: string;
  reminderMinutesBefore?: number | null;
  recurrenceRule?: string | null;
  /** Не событие, а задача со сроком — рисуется в календаре, открывается в «Задачах». */
  taskId?: string;
  done?: boolean;
  /** Кто поставил: имя агента; пусто — человек. */
  source?: string;
  /** Автоматизация: в момент события агент получает задание. */
  automation?: Automation | null;
  /** Чем кончился запуск этого повторения автоматизации. */
  run?: { fired_at: string; inbox_id: string | null; error: string } | null;
  /** Системная автоматизация MBOX (SEO Wizard и т.п.) — только чтение. */
  system?: { source: string; status: SystemStatus; detail: string; tab?: string };
}

export type Automation = { agent: string; prompt: string; project_id?: string };
export type SystemStatus = 'planned' | 'running' | 'done' | 'failed' | 'missed' | 'off';
export const SYSTEM_STATUS: Record<SystemStatus, string> = {
  planned: 'по расписанию',
  running: 'идёт сейчас',
  done: 'выполнено',
  failed: 'ошибка',
  missed: 'не запускалось',
  off: 'автозапуск выключен',
};

// ── Даты ────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** «2026-09-30» */
export const dayIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** «2026-09-30T10:00:00» — как в базе. */
export const localIso = (d: Date) => `${dayIso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
/** «10:00» */
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** Время из базы → Date. Без зоны — локальное; с зоной — как есть. */
export function parseLocal(value?: string | null): Date {
  if (!value) return new Date(NaN);
  const s = String(value);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  const m = s.match(LOCAL_RE);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60000);
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Понедельник недели, в которой лежит d. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAYS_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const weekdayIndex = (d: Date) => (d.getDay() + 6) % 7;

/** 42 дня сетки месяца (с понедельника), 35 — если шестая неделя пустая. */
export function monthGrid(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  const start = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return days.slice(35).every((d) => d.getMonth() !== first.getMonth()) ? days.slice(0, 35) : days;
}

/** «30 сентября», «30 сентября 2027» — год, только если не текущий. */
export function dayLabel(d: Date): string {
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${year}`;
}

// ── События ─────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** Строка ответа /api/mbox/planner/events → событие. */
export function normalize(raw: Raw): CalEvent | null {
  const start = parseLocal(str(raw.starts_at));
  if (Number.isNaN(start.getTime())) return null;
  const allDay = raw.all_day === true;
  let end = parseLocal(str(raw.ends_at));
  if (Number.isNaN(end.getTime()) || end < start) end = allDay ? start : addMinutes(start, 60);
  return {
    id: str(raw.id),
    masterId: str(raw.master_id) || undefined,
    recurrenceId: str(raw.recurrence_id) || undefined,
    title: str(raw.title),
    description: str(raw.description) || undefined,
    start: localIso(start),
    end: localIso(end),
    allDay,
    location: str(raw.location) || undefined,
    color: str(raw.color) || undefined,
    reminderMinutesBefore: raw.reminder_minutes == null || raw.reminder_minutes === '' ? null : Number(raw.reminder_minutes),
    recurrenceRule: str(raw.recurrence_rule) || null,
    source: str(raw.source) || undefined,
    automation: raw.automation && typeof raw.automation === 'object' ? (raw.automation as Automation) : null,
    run: raw.run && typeof raw.run === 'object' ? (raw.run as CalEvent['run']) : null,
  };
}

/** Пункт системной автоматизации (/api/mbox/planner/automations) → событие только для чтения. */
export function normalizeSystem(raw: Raw): CalEvent | null {
  const start = parseLocal(str(raw.starts_at));
  if (Number.isNaN(start.getTime())) return null;
  let end = parseLocal(str(raw.ends_at));
  if (Number.isNaN(end.getTime()) || end <= start) end = addMinutes(start, 30);
  const status = (str(raw.status) || 'planned') as SystemStatus;
  // В строке «весь день», а не в часовой сетке: автоматизации MBOX — фон, они не должны теснить дела человека.
  // Время — в начале названия, подробности и статус — в листе по нажатию.
  return {
    id: `sys:${str(raw.id)}`,
    title: `${hhmm(start)} ${str(raw.title)}`,
    start: localIso(start),
    end: localIso(end),
    allDay: true,
    color: status === 'failed' ? 'red' : status === 'done' ? 'green' : 'gray',
    recurrenceRule: null,
    system: { source: str(raw.source), status, detail: str(raw.detail), tab: str(raw.tab) || undefined },
  };
}

/** Цвет события: имя из палитры → токен темы; старые записи — hex как есть. */
export function colorVar(c?: string): string {
  if (!c) return 'var(--note-blue)';
  if (c.startsWith('#') || c.startsWith('rgb')) return c;
  return `var(--note-${c})`;
}

/** Затрагивает ли событие день (для многодневных — каждый его день). */
export function onDay(e: CalEvent, day: Date): boolean {
  const s = startOfDay(parseLocal(e.start));
  const endD = parseLocal(e.end);
  // Конец в полночь следующего дня — событие того дня не касается.
  const lastDay = startOfDay(e.allDay || minutesOfDay(endD) > 0 || sameDay(endD, parseLocal(e.start)) ? endD : addDays(endD, -1));
  const d = startOfDay(day);
  return d >= s && d <= lastDay;
}

export function byStart(a: CalEvent, b: CalEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return parseLocal(a.start).getTime() - parseLocal(b.start).getTime() || a.title.localeCompare(b.title, 'ru');
}

export function timeRange(e: CalEvent): string {
  if (e.allDay) return 'Весь день';
  const s = parseLocal(e.start);
  const en = parseLocal(e.end);
  return sameDay(s, en) ? `${hhmm(s)}–${hhmm(en)}` : `${hhmm(s)} – ${dayLabel(en)}, ${hhmm(en)}`;
}

/** Серия (повторяющееся событие) — правка и удаление спрашивают, что именно. */
export const isRecurring = (e: CalEvent) => Boolean(e.masterId || e.recurrenceRule);
/** id строки, в которую пишем: у повторения — его серия. */
export const rowId = (e: CalEvent) => e.masterId || e.id;

// ── Повтор ──────────────────────────────────────────────────────────────────

export const REPEATS: { id: string; label: string; rule: string | null }[] = [
  { id: 'none', label: 'Не повторять', rule: null },
  { id: 'daily', label: 'Каждый день', rule: 'FREQ=DAILY' },
  { id: 'weekdays', label: 'По будням', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { id: 'weekly', label: 'Каждую неделю', rule: 'FREQ=WEEKLY' },
  { id: 'biweekly', label: 'Каждые две недели', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { id: 'monthly', label: 'Каждый месяц', rule: 'FREQ=MONTHLY' },
  { id: 'yearly', label: 'Каждый год', rule: 'FREQ=YEARLY' },
];

export function repeatOf(rule?: string | null): (typeof REPEATS)[number] {
  const r = (rule || '').replace(/^RRULE:/i, '').toUpperCase();
  return REPEATS.find((x) => x.rule === r) || (r ? { id: 'custom', label: 'Свой повтор', rule: r } : REPEATS[0]);
}

export const REMINDERS: { value: number | null; label: string }[] = [
  { value: null, label: 'Без напоминания' },
  { value: 0, label: 'В момент начала' },
  { value: 5, label: 'За 5 минут' },
  { value: 15, label: 'За 15 минут' },
  { value: 30, label: 'За 30 минут' },
  { value: 60, label: 'За час' },
  { value: 1440, label: 'За день' },
];

export const reminderLabel = (v?: number | null) =>
  REMINDERS.find((r) => r.value === (v ?? null))?.label || `За ${v} мин`;

// ── Раскладка дня ───────────────────────────────────────────────────────────
// Пересекающиеся события делят ширину колонки, как в «Календаре» macOS:
// группа пересекающихся — одна кучка, внутри неё — жадно по колонкам.

export interface Placed { e: CalEvent; top: number; height: number; col: number; cols: number }

export function layoutDay(events: CalEvent[], day: Date, minHeightMin = 20): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const items = events
    .map((e) => {
      const s = Math.max(parseLocal(e.start).getTime(), dayStart);
      const en = Math.min(parseLocal(e.end).getTime(), dayStart + 86400000);
      const top = (s - dayStart) / 60000;
      const bottom = Math.max((en - dayStart) / 60000, top + minHeightMin);
      return { e, top, bottom };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  const out: Placed[] = [];
  let cluster: { e: CalEvent; top: number; bottom: number; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.push({ e: c.e, top: c.top, height: c.bottom - c.top, col: c.col, cols });
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) flush();
    const taken = new Set(cluster.filter((c) => c.bottom > it.top).map((c) => c.col));
    let col = 0;
    while (taken.has(col)) col += 1;
    cluster.push({ ...it, col });
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  if (cluster.length) flush();
  return out;
}
