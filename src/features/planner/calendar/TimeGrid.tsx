import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Repeat } from 'lucide-react';
import {
  addDays, colorVar, hhmm, layoutDay, localIso, minutesOfDay, onDay, parseLocal, sameDay, startOfDay, weekdayIndex, WEEKDAYS,
  type CalEvent,
} from './model';

/**
 * Сетка дня и недели, как в «Календаре» macOS.
 *
 *  - протянуть по пустому месту — новое событие на этот отрезок;
 *  - двойной щелчок по пустому месту — событие на час;
 *  - событие тянется за тело (перенос, в том числе на другой день недели) и
 *    за нижний край (длительность); без движения — открывается;
 *  - шаг — 15 минут; красная линия — сейчас.
 */

export const HOUR = 48;
const SNAP = 15;
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const clampMin = (min: number) => Math.max(0, Math.min(24 * 60, min));

type Drag =
  | { kind: 'create'; day: number; from: number; to: number }
  | { kind: 'move'; e: CalEvent; dayShift: number; minShift: number; moved: boolean; colW?: number }
  | { kind: 'resize'; e: CalEvent; minShift: number; moved: boolean };

export interface TimeGridProps {
  days: Date[];
  events: CalEvent[];
  onCreate: (start: Date, end: Date, allDay?: boolean) => void;
  onOpen: (e: CalEvent) => void;
  onMove: (e: CalEvent, start: Date, end: Date) => void;
  onPickDay?: (d: Date) => void;
  /** Правый клик по событию — меню. */
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void;
  /** Delete / Backspace на событии в фокусе. */
  onDelete?: (e: CalEvent) => void;
}

export default function TimeGrid({ days, events, onCreate, onOpen, onMove, onPickDay, onMenu, onDelete }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<{ d: Drag; x: number; y: number; pointer: number } | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Линия «сейчас» двигается раз в минуту — это часы на экране, не опрос сервера.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(t);
  }, []);

  // При открытии — к рабочему утру или к текущему часу, если сегодня на экране.
  const firstDay = days[0]?.getTime();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showsToday = days.some((d) => sameDay(d, new Date()));
    const hour = showsToday ? Math.max(0, new Date().getHours() - 1.5) : 8;
    el.scrollTop = hour * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, days.length]);

  const allDay = useMemo(() => days.map((d) => events.filter((e) => (e.allDay || spansDays(e)) && onDay(e, d))), [days, events]);
  const timed = useMemo(() => days.map((d) => layoutDay(events.filter((e) => !e.allDay && !spansDays(e) && onDay(e, d)), d)), [days, events]);

  // ── Указатель ───────────────────────────────────────────────────────────
  const pointToSlot = (x: number, y: number) => {
    const rect = colsRef.current!.getBoundingClientRect();
    const day = Math.max(0, Math.min(days.length - 1, Math.floor(((x - rect.left) / rect.width) * days.length)));
    const min = clampMin(((y - rect.top) / HOUR) * 60);
    return { day, min };
  };

  const begin = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    colsRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { d, x: e.clientX, y: e.clientY, pointer: e.pointerId };
    setDrag(d);
  };

  const onColsDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.ncal-ev')) return;
    const { day, min } = pointToSlot(e.clientX, e.clientY);
    const from = Math.floor(min / SNAP) * SNAP;
    begin(e, { kind: 'create', day, from, to: from + SNAP });
  };

  const onMoveP = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointer !== e.pointerId) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
    let next: Drag = st.d;
    if (st.d.kind === 'create') {
      const { min } = pointToSlot(e.clientX, e.clientY);
      next = { ...st.d, to: Math.max(st.d.from + SNAP, snap(min)) };
      if (snap(min) < st.d.from) next = { ...st.d, to: st.d.from + SNAP };
    } else if (st.d.kind === 'move') {
      const rect = colsRef.current!.getBoundingClientRect();
      const colW = rect.width / days.length;
      next = { ...st.d, dayShift: Math.round(dx / colW), minShift: snap((dy / HOUR) * 60), moved: st.d.moved || moved, colW };
    } else {
      next = { ...st.d, minShift: snap((dy / HOUR) * 60), moved: st.d.moved || moved };
    }
    dragRef.current = { ...st, d: next };
    setDrag(next);
  };

  const onUp = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointer !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    const d = st.d;
    if (d.kind === 'create') {
      // Щелчок без протягивания ничего не создаёт — для этого двойной щелчок.
      if (d.to - d.from <= SNAP && Math.abs(e.clientY - st.y) < 4) return;
      const base = startOfDay(days[d.day]);
      onCreate(new Date(base.getTime() + d.from * 60000), new Date(base.getTime() + d.to * 60000));
      return;
    }
    // Без движения — открыть. Чужое событие (им поделились) не двигается.
    if (!d.moved) { onOpen(d.e); return; }
    const s = parseLocal(d.e.start);
    const en = parseLocal(d.e.end);
    if (d.kind === 'move') {
      const ns = new Date(addDays(s, d.dayShift).getTime() + d.minShift * 60000);
      const ne = new Date(addDays(en, d.dayShift).getTime() + d.minShift * 60000);
      if (d.dayShift || d.minShift) onMove(d.e, ns, ne);
    } else {
      const ne = new Date(Math.max(en.getTime() + d.minShift * 60000, s.getTime() + SNAP * 60000));
      if (d.minShift) onMove(d.e, s, ne);
    }
  };

  const onDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.ncal-ev')) return;
    const { day, min } = pointToSlot(e.clientX, e.clientY);
    const from = Math.floor(min / 30) * 30;
    const base = startOfDay(days[day]);
    onCreate(new Date(base.getTime() + from * 60000), new Date(base.getTime() + (from + 60) * 60000));
  };

  const cols = { '--days': days.length } as CSSProperties;
  const nowMin = minutesOfDay(now);

  return (
    <div className="ncal-grid" style={cols}>
      <div className="ncal-grid-head">
        <div className="ncal-gutter" />
        {days.map((d) => {
          const today = sameDay(d, now);
          return (
            <button key={d.getTime()} type="button" className="ncal-dayhead" data-today={today ? 'true' : undefined}
              data-weekend={weekdayIndex(d) >= 5 ? 'true' : undefined} onClick={() => onPickDay?.(d)}
              aria-label={d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}>
              <span className="ncal-dayhead-wd">{WEEKDAYS[weekdayIndex(d)]}</span>
              <span className="ncal-dayhead-num">{d.getDate()}</span>
            </button>
          );
        })}
      </div>

      <div className="ncal-allday" onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.ncal-chip-ev')) return;
        const rect = (e.currentTarget as HTMLElement).querySelector('.ncal-allday-cols')!.getBoundingClientRect();
        const idx = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * days.length)));
        onCreate(startOfDay(days[idx]), startOfDay(days[idx]), true);
      }}>
        <div className="ncal-gutter ncal-allday-label">весь день</div>
        <div className="ncal-allday-cols">
          {allDay.map((list, i) => (
            <div key={days[i].getTime()} className="ncal-allday-col">
              {list.map((e) => <Chip key={e.id} e={e} onOpen={onOpen} onMenu={onMenu} onDelete={onDelete} />)}
            </div>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="ncal-grid-body nx-scroll-y">
        <div className="ncal-grid-inner" style={{ height: HOUR * 24 }}>
          <div className="ncal-gutter ncal-hours" aria-hidden="true">
            {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? `${String(h).padStart(2, '0')}:00` : ''}</span>)}
          </div>
          <div
            ref={colsRef}
            className="ncal-cols"
            onPointerDown={onColsDown}
            onPointerMove={onMoveP}
            onPointerUp={onUp}
            onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
            onDoubleClick={onDouble}
            data-dragging={drag ? drag.kind : undefined}
          >
            {days.map((d, i) => (
              <div key={d.getTime()} className="ncal-col" data-weekend={weekdayIndex(d) >= 5 ? 'true' : undefined}>
                {timed[i].map((p) => {
                  const dragging = drag && drag.kind !== 'create' && drag.e.id === p.e.id;
                  let top = (p.top / 60) * HOUR;
                  let height = (p.height / 60) * HOUR;
                  let shiftX = 0;
                  if (dragging && drag.kind === 'move') { top += (drag.minShift / 60) * HOUR; shiftX = drag.dayShift * (drag.colW || 0); }
                  if (dragging && drag.kind === 'resize') height = Math.max((SNAP / 60) * HOUR, height + (drag.minShift / 60) * HOUR);
                  return (
                    <EventBlock
                      key={p.e.id}
                      e={p.e}
                      style={{
                        top, height,
                        left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
                        width: `calc(${(1 / p.cols) * 100}% - 3px)`,
                        transform: shiftX ? `translateX(${shiftX}px)` : undefined,
                      }}
                      dragging={Boolean(dragging)}
                      preview={dragging ? previewTime(p.e, drag) : undefined}
                      onOpen={onOpen}
                      onMenu={onMenu}
                      onDelete={onDelete}
                      onDown={(ev, kind) => {
                        begin(ev, kind === 'resize'
                          ? { kind: 'resize', e: p.e, minShift: 0, moved: false }
                          : { kind: 'move', e: p.e, dayShift: 0, minShift: 0, moved: false });
                      }}
                    />
                  );
                })}
                {drag?.kind === 'create' && drag.day === i && (
                  <div className="ncal-ev ncal-ghost" style={{ top: (drag.from / 60) * HOUR, height: ((drag.to - drag.from) / 60) * HOUR }}>
                    <span className="ncal-ev-time">{fmtMin(drag.from)}–{fmtMin(drag.to)}</span>
                  </div>
                )}
                {sameDay(d, now) && <div className="ncal-now" style={{ top: (nowMin / 60) * HOUR }} aria-hidden="true" />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Событие на несколько дней с временем — показываем в полосе «весь день». */
function spansDays(e: CalEvent) {
  const s = parseLocal(e.start);
  const en = parseLocal(e.end);
  return !sameDay(s, en) && !(minutesOfDay(en) === 0 && sameDay(addDays(s, 1), en));
}

const fmtMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function previewTime(e: CalEvent, d: Drag): string | undefined {
  if (d.kind === 'create') return undefined;
  const s = parseLocal(e.start);
  const en = parseLocal(e.end);
  if (d.kind === 'move') return `${hhmm(new Date(s.getTime() + d.minShift * 60000))}–${hhmm(new Date(en.getTime() + d.minShift * 60000))}`;
  return `${hhmm(s)}–${hhmm(new Date(en.getTime() + d.minShift * 60000))}`;
}

const EventBlock = memo(function EventBlock({ e, style, dragging, preview, onDown, onOpen, onMenu, onDelete }: {
  e: CalEvent; style: CSSProperties; dragging: boolean; preview?: string;
  onDown: (ev: React.PointerEvent, kind: 'move' | 'resize') => void;
  onOpen: (e: CalEvent) => void;
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void;
  onDelete?: (e: CalEvent) => void;
}) {
  const s = parseLocal(e.start);
  const short = (parseLocal(e.end).getTime() - s.getTime()) / 60000 <= 30;
  return (
    <div
      className="ncal-ev"
      role="button"
      tabIndex={0}
      data-short={short ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      style={{ ...style, '--ev': colorVar(e.color) } as CSSProperties}
      onPointerDown={(ev) => { ev.stopPropagation(); onDown(ev, 'move'); }}
      onContextMenu={(ev) => { if (!onMenu) return; ev.preventDefault(); ev.stopPropagation(); onMenu(e, { x: ev.clientX, y: ev.clientY }); }}
      onKeyDown={(ev) => eventKeys(ev, e, onOpen, onMenu, onDelete)}
      aria-label={`${e.title || 'Без названия'}, ${hhmm(s)}`}
      data-event-id={e.id}
    >
      <span className="ncal-ev-title">
        {e.title || 'Без названия'}
        {e.masterId && <Repeat size={10} aria-hidden="true" />}
      </span>
      <span className="ncal-ev-time">{preview || `${hhmm(s)}${short ? '' : `–${hhmm(parseLocal(e.end))}`}`}</span>
      {e.location && !short && <span className="ncal-ev-place">{e.location}</span>}
      <span className="ncal-ev-resize" onPointerDown={(ev) => { ev.stopPropagation(); onDown(ev, 'resize'); }} aria-hidden="true" />
    </div>
  );
});

/** Клавиши на событии: Enter — открыть, Delete — удалить, меню — как правый клик. */
function eventKeys(ev: React.KeyboardEvent, e: CalEvent, onOpen: (e: CalEvent) => void,
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void, onDelete?: (e: CalEvent) => void) {
  if (ev.key === 'Enter') { ev.preventDefault(); onOpen(e); return; }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && onDelete) { ev.preventDefault(); onDelete(e); return; }
  if ((ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) && onMenu) {
    ev.preventDefault();
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    onMenu(e, { x: r.left + 12, y: r.bottom });
  }
}

export function Chip({ e, onOpen, draggable, onMenu, onDelete }: {
  e: CalEvent; onOpen: (e: CalEvent) => void; draggable?: boolean;
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void; onDelete?: (e: CalEvent) => void;
}) {
  const s = parseLocal(e.start);
  return (
    <button
      type="button"
      className="ncal-chip-ev"
      data-allday={e.allDay || spansDays(e) ? 'true' : undefined}
      data-task={e.taskId ? 'true' : undefined}
      data-done={e.done ? 'true' : undefined}
      style={{ '--ev': colorVar(e.color) } as CSSProperties}
      onClick={(ev) => { ev.stopPropagation(); onOpen(e); }}
      onDoubleClick={(ev) => ev.stopPropagation()}
      onContextMenu={(ev) => { if (!onMenu) return; ev.preventDefault(); ev.stopPropagation(); onMenu(e, { x: ev.clientX, y: ev.clientY }); }}
      onKeyDown={(ev) => { if (ev.key !== 'Enter') eventKeys(ev, e, onOpen, onMenu, onDelete); }}
      draggable={draggable}
      onDragStart={(ev) => { ev.dataTransfer.setData('text/x-ncal', e.id); ev.dataTransfer.effectAllowed = 'move'; }}
      title={e.title}
    >
      {!(e.allDay || spansDays(e)) && <span className="ncal-chip-time">{hhmm(s)}</span>}
      <span className="ncal-chip-title">{e.title || 'Без названия'}</span>
    </button>
  );
}

export { localIso };
