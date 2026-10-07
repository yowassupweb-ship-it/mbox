export const pad = (value: number) => String(value).padStart(2, "0");
export function localIso(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`; }
export function parseLocal(value: string) { const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(value); }
export function startOfWeek(date: Date) { const out = new Date(date.getFullYear(), date.getMonth(), date.getDate()); out.setDate(out.getDate() - ((out.getDay() + 6) % 7)); return out; }
export function addDays(date: Date, days: number) { const out = new Date(date); out.setDate(out.getDate() + days); return out; }
export function dayKey(date: Date) { return localIso(date).slice(0, 10); }
export function weekDays(anchor: Date) { const first = startOfWeek(anchor); return Array.from({ length: 7 }, (_, index) => addDays(first, index)); }
