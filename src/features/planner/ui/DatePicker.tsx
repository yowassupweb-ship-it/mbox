import { useMemo, useState } from 'react';
import { CalendarDays, CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { Menu, MenuItem, type MenuAnchor } from './overlay';

/**
 * Выбор срока — поповер в стиле macOS вместо системного календаря браузера
 * (у того свои цвета и шрифты, в тёмной теме он белый). Сверху — быстрые
 * сроки, ниже — месяц сеткой. Неделя с понедельника, выходные приглушены.
 */

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const pad = (n: number) => String(n).padStart(2, '0');
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoOf(d); };
/** Ближайший понедельник после сегодняшнего дня. */
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return isoOf(d); };

export function DatePicker({ anchor, value, onPick, onClose }: {
  anchor: MenuAnchor;
  value: string | null;
  onPick: (iso: string | null) => void;
  onClose: () => void;
}) {
  const selected = value ? value.slice(0, 10) : null;
  const [month, setMonth] = useState(() => {
    const base = selected ? new Date(`${selected}T12:00:00`) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const today = isoOf(new Date());

  const days = useMemo(() => {
    const first = new Date(month);
    const shift = (first.getDay() + 6) % 7; // понедельник — первый
    const start = new Date(first);
    start.setDate(1 - shift);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { iso: isoOf(d), day: d.getDate(), out: d.getMonth() !== month.getMonth(), weekend: i % 7 >= 5 };
    });
  }, [month]);
  // Шестая неделя целиком из следующего месяца — не показываем.
  const rows = days.slice(35).every((d) => d.out) ? days.slice(0, 35) : days;

  const pick = (iso: string | null) => { onPick(iso); onClose(); };
  const step = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  return (
    <Menu anchor={anchor} label="Срок" onClose={onClose}>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => pick(plusDays(0))}>Сегодня</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => pick(plusDays(1))}>Завтра</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => pick(nextMonday())}>В понедельник</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => pick(plusDays(7))}>Через неделю</MenuItem>
      {selected && <MenuItem icon={<CalendarX size={16} />} onSelect={() => pick(null)}>Без срока</MenuItem>}
      <div className="nx-menu-sep" />
      <div className="ndp">
        <div className="ndp-head">
          <b>{MONTHS[month.getMonth()]} {month.getFullYear()}</b>
          <button type="button" className="nx-icon-btn" onClick={() => step(-1)} aria-label="Предыдущий месяц"><ChevronLeft size={16} /></button>
          <button type="button" className="nx-icon-btn" onClick={() => step(1)} aria-label="Следующий месяц"><ChevronRight size={16} /></button>
        </div>
        <div className="ndp-grid" role="grid" aria-label={`${MONTHS[month.getMonth()]} ${month.getFullYear()}`}>
          {WEEK.map((w, i) => <span key={w} className="ndp-wd" data-weekend={i >= 5 ? 'true' : undefined}>{w}</span>)}
          {rows.map((d) => (
            <button
              key={d.iso}
              type="button"
              className="ndp-day"
              data-out={d.out ? 'true' : undefined}
              data-weekend={d.weekend ? 'true' : undefined}
              data-today={d.iso === today ? 'true' : undefined}
              aria-pressed={d.iso === selected}
              onClick={() => pick(d.iso)}
            >
              {d.day}
            </button>
          ))}
        </div>
      </div>
    </Menu>
  );
}
