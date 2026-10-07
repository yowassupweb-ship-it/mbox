/** Форматирование для интерфейса: время, даты, склонения, инициалы. */

/** Цвет аватара — одна из восьми категорий (доктрина §4.4), выбирается по id. */
const TINTS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'] as const;

export function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return `var(--note-${TINTS[Math.abs(h) % TINTS.length]})`;
}

export function initials(text: string): string {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayMonthShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayMonthYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : time.format(d);
}

/** Время в списке чатов: сегодня — часы, в этом году — дд.мм, раньше — дд.мм.гггг. */
export function formatListTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (startOfDay(d) === startOfDay(now)) return time.format(d);
  return d.getFullYear() === now.getFullYear() ? dayMonthShort.format(d) : fullDate.format(d);
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.getFullYear() === new Date().getFullYear() ? dayMonth.format(d) : dayMonthYear.format(d);
}

export function dayKey(iso: string): number {
  return startOfDay(new Date(iso));
}

export function lastSeenText(iso?: string, online?: boolean): string {
  if (online) return 'в сети';
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'был(а) только что';
  if (mins < 60) return `был(а) ${mins} мин назад`;
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return `был(а) сегодня в ${time.format(d)}`;
  if (days === 1) return `был(а) вчера в ${time.format(d)}`;
  return `был(а) ${dayMonth.format(d)}`;
}

/** Русское множественное: plural(3, ['участник', 'участника', 'участников']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function attachmentUrl(raw: unknown): string {
  const url = String(raw || '').trim();
  const m = url.match(/\/api\/uploads\/([^?#]+)/i);
  if (m?.[1]) {
    try { return `/api/uploads/${encodeURIComponent(decodeURIComponent(m[1]))}`; } catch { return url; }
  }
  return url;
}
