import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Bot, CalendarDays, Check, ChevronDown, MapPin, Repeat, Trash2, Zap } from 'lucide-react';
import { create, overlayRoot } from '../lib';
import { showToast } from '../ui/Toast';
import { DatePicker } from '../ui/DatePicker';
import { Menu, MenuItem, Sheet, type MenuAnchor } from '../ui/overlay';
import { createEvent, deleteEvent, updateEvent, type Draft, type Scope } from './api';
import { loadPeople, usePeople } from '../people';
import {
  addDays, addMinutes, COLORS, colorVar, dayIso, dayLabel, hhmm, isRecurring, parseLocal, reminderLabel, REMINDERS, repeatOf,
  REPEATS, type CalEvent,
} from './model';

/**
 * Редактор события (из shar-2) — лист. Календарь в MBOX личный, поэтому без «поделиться»:
 * главное — текст (первая строка — название, дальше заметка), настройки — чипы под ним.
 */

// ── «Только это / все» для серий ────────────────────────────────────────────

interface ScopeRequest { kind: 'edit' | 'delete'; resolve: (s: Scope | null) => void }
const useScope = create<{ req: ScopeRequest | null }>(() => ({ req: null }));

/** Для повторяющегося события: к чему применить правку или удаление. */
export function askScope(kind: 'edit' | 'delete'): Promise<Scope | null> {
  return new Promise((resolve) => {
    useScope.getState().req?.resolve(null);
    useScope.setState({ req: { kind, resolve } });
  });
}

function closeScope(s: Scope | null) {
  const req = useScope.getState().req;
  useScope.setState({ req: null });
  req?.resolve(s);
}

export function ScopeHost() {
  const req = useScope((s) => s.req);
  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeScope(null); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);
  if (!req) return null;
  const root = overlayRoot();
  if (!root) return null;
  const close = closeScope;
  const del = req.kind === 'delete';
  return createPortal(
    <div className="nx-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="nx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ncal-scope-title">
        <h2 id="ncal-scope-title">{del ? 'Удалить повторяющееся событие?' : 'Изменить повторяющееся событие?'}</h2>
        <p>{del ? 'Только это повторение или всю серию.' : 'Только это повторение, это и следующие или всю серию.'}</p>
        <div className="ncal-scope-actions">
          <button type="button" className="nx-primary" data-tone={del ? 'danger' : undefined} onClick={() => close('this')} autoFocus>Только это</button>
          {!del && <button type="button" className="nx-ghost" onClick={() => close('following')}>Это и следующие</button>}
          <button type="button" className="nx-ghost" data-tone={del ? 'danger' : undefined} onClick={() => close('all')}>Всю серию</button>
          <button type="button" className="nx-ghost" onClick={() => close(null)}>Отмена</button>
        </div>
      </div>
    </div>,
    root,
  );
}

// ── Редактор ────────────────────────────────────────────────────────────────

export type EditorState = { mode: 'new'; draft: Draft } | { mode: 'edit'; event: CalEvent };

export function newDraft(start: Date, end?: Date, allDay = false): Draft {
  return {
    title: '',
    start: `${dayIso(start)}T${hhmm(start)}:00`,
    end: `${dayIso(end || addMinutes(start, 60))}T${hhmm(end || addMinutes(start, 60))}:00`,
    allDay,
    color: 'blue',
    reminderMinutesBefore: allDay ? null : 15,
    recurrenceRule: null,
  };
}

const draftOf = (e: CalEvent): Draft => ({
  title: e.title, description: e.description, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
  color: e.color, reminderMinutesBefore: e.reminderMinutesBefore ?? null, recurrenceRule: e.recurrenceRule ?? null,
  automation: e.automation ?? null,
});

const runFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function withDate(iso: string, day: string) { return `${day}${iso.slice(10)}`; }
function withTime(iso: string, time: string) { return `${iso.slice(0, 10)}T${time}:00`; }

export default function EventEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const original = state.mode === 'edit' ? state.event : null;
  const [d, setD] = useState<Draft>(() => (state.mode === 'new' ? state.draft : draftOf(state.event)));
  // Главное — текст: первая строка — название, дальше — заметка. Человек ставит
  // себе напоминание с заметкой; настройки — мелкие чипы под ним.
  const [text, setText] = useState(() => {
    const src = state.mode === 'new' ? state.draft : draftOf(state.event);
    return [src.title, src.description].filter((x) => x && x.trim()).join('\n');
  });
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ kind: 'repeat' | 'remind' | 'startDate' | 'endDate' | 'color' | 'agent'; anchor: MenuAnchor } | null>(null);
  const [showPlace, setShowPlace] = useState(() => Boolean(state.mode === 'edit' && state.event.location));
  // Автоматизация: в момент события агент получает задание. Пока выключена — поля не мешают обычному событию.
  const [autoOn, setAutoOn] = useState(() => Boolean(state.mode === 'edit' ? state.event.automation : state.draft.automation));
  const [autoAgent, setAutoAgent] = useState(() => (state.mode === 'edit' ? state.event.automation?.agent : state.draft.automation?.agent) || 'Claude');
  const [autoPrompt, setAutoPrompt] = useState(() => (state.mode === 'edit' ? state.event.automation?.prompt : state.draft.automation?.prompt) || '');
  const people = usePeople((s) => s.users);
  const agents = Object.values(people).filter((p) => p.kind === 'agent').map((p) => p.name);
  useEffect(() => { void loadPeople(); }, []);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  // Начало сдвигает конец на ту же длительность — как в «Календаре» macOS.
  const setStart = (start: string) => setD((cur) => {
    const dur = parseLocal(cur.end).getTime() - parseLocal(cur.start).getTime();
    const end = new Date(parseLocal(start).getTime() + Math.max(0, dur));
    return { ...cur, start, end: `${dayIso(end)}T${hhmm(end)}:00` };
  });

  const start = parseLocal(d.start);
  const end = parseLocal(d.end);
  const endBeforeStart = end < start;

  const save = async () => {
    if (busy || endBeforeStart) return;
    const [first, ...rest] = text.trim().split('\n');
    if (autoOn && !autoPrompt.trim()) { showToast('Напишите, что агенту сделать, — или выключите автоматизацию.', 'error'); return; }
    const draft: Draft = {
      ...d,
      automation: autoOn ? { agent: autoAgent, prompt: autoPrompt.trim(), ...(d.automation?.project_id ? { project_id: d.automation.project_id } : {}) } : null,
      title: (first || '').trim() || 'Событие',
      description: rest.join('\n').trim() || undefined,
      // Весь день: храним с полуночи до полуночи дня окончания.
      ...(d.allDay ? { start: `${d.start.slice(0, 10)}T00:00:00`, end: `${d.end.slice(0, 10)}T00:00:00` } : {}),
    };
    setBusy(true);
    try {
      if (!original) {
        await createEvent(draft);
      } else {
        let scope: Scope = 'all';
        if (isRecurring(original) && original.masterId) {
          const picked = await askScope('edit');
          if (!picked) { setBusy(false); return; }
          scope = picked;
        }
        await updateEvent(original, draft, scope);
      }
      onClose();
    } catch {
      showToast('Не сохранилось — нет связи с сервером.', 'error');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!original || busy) return;
    let scope: Scope = 'all';
    if (isRecurring(original) && original.masterId) {
      const picked = await askScope('delete');
      if (!picked) return;
      scope = picked;
    }
    setBusy(true);
    try { await deleteEvent(original, scope); onClose(); } catch { showToast('Не удалилось — нет связи с сервером.', 'error'); setBusy(false); }
  };

  const pop = (kind: NonNullable<typeof menu>['kind']) => (e: React.MouseEvent<HTMLElement>) =>
    setMenu({ kind, anchor: { element: e.currentTarget, align: 'start' } });
  const repeat = repeatOf(d.recurrenceRule);

  const footer = (
    <>
      {original && (
        <button type="button" className="nx-ghost ncal-delete" data-tone="danger" onClick={() => void remove()} disabled={busy}>
          <Trash2 size={15} aria-hidden="true" /> Удалить
        </button>
      )}
      <span className="ncal-foot-gap" />
      <span className="ncal-foot-hint">Ctrl+Enter — сохранить</span>
      <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
      <button type="button" className="nx-primary" onClick={() => void save()} disabled={busy || endBeforeStart}>
        {original ? 'Сохранить' : 'Добавить'}
      </button>
    </>
  );

  return (
    <Sheet title={original ? 'Событие' : 'Новое событие'} onClose={onClose} footer={footer} busy={busy}>
      <div className="ncal-form" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}>
        <textarea
          ref={textRef}
          className="ncal-note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'О чём напомнить?\nПервая строка — название, дальше — заметка'}
          aria-label="Название и заметка"
          rows={5}
          style={{ '--ev': colorVar(d.color) } as React.CSSProperties}
        />

        {/* Когда — главная настройка, одной строкой. */}
        <div className="ncal-when" data-invalid={endBeforeStart ? 'true' : undefined}>
          <CalendarDays size={15} aria-hidden="true" />
          <button type="button" className="ncal-pill" onClick={pop('startDate')}>{dayLabel(start)}</button>
          {!d.allDay && (
            <>
              <input className="ncal-time" type="time" step={300} value={hhmm(start)} aria-label="Время начала"
                onChange={(e) => e.target.value && setStart(withTime(d.start, e.target.value))} />
              <span className="ncal-dash">–</span>
              {dayIso(end) !== dayIso(start) && <button type="button" className="ncal-pill" onClick={pop('endDate')}>{dayLabel(end)}</button>}
              <input className="ncal-time" type="time" step={300} value={hhmm(end)} aria-label="Время окончания"
                onChange={(e) => e.target.value && set({ end: withTime(d.end, e.target.value) })} />
            </>
          )}
          {d.allDay && dayIso(end) !== dayIso(start) && <><span className="ncal-dash">–</span><button type="button" className="ncal-pill" onClick={pop('endDate')}>{dayLabel(end)}</button></>}
          <button type="button" className="ncal-pill" aria-pressed={d.allDay} onClick={() => set({ allDay: !d.allDay })}>Весь день</button>
        </div>
        {endBeforeStart && <p className="ncal-error" role="alert">Конец раньше начала.</p>}

        <div className="ncal-chips" role="toolbar" aria-label="Настройки">
          <button type="button" className="ncal-pill" data-on={d.reminderMinutesBefore != null ? 'true' : undefined} onClick={pop('remind')} aria-haspopup="menu">
            <Bell size={14} aria-hidden="true" /> {reminderLabel(d.reminderMinutesBefore)}
          </button>
          <button type="button" className="ncal-pill" data-on={repeat.id !== 'none' ? 'true' : undefined} onClick={pop('repeat')} aria-haspopup="menu">
            <Repeat size={14} aria-hidden="true" /> {repeat.label}
          </button>
          <button type="button" className="ncal-pill" onClick={pop('color')} aria-haspopup="menu" aria-label="Цвет">
            <span className="ncal-dot" style={{ '--ev': colorVar(d.color) } as React.CSSProperties} /> Цвет
          </button>
          {!showPlace && (
            <button type="button" className="ncal-pill" onClick={() => setShowPlace(true)}><MapPin size={14} aria-hidden="true" /> Место</button>
          )}
          <button type="button" className="ncal-pill" data-on={autoOn ? 'true' : undefined} aria-pressed={autoOn} onClick={() => setAutoOn(!autoOn)}
            title="В момент события агент получит задание — как будто вы написали ему в чат">
            <Zap size={14} aria-hidden="true" /> Автоматизация
          </button>
        </div>

        {autoOn && (
          <section className="ncal-auto" aria-label="Автоматизация">
            <div className="ncal-auto-head">
              <span>Кто сделает</span>
              <button type="button" className="ncal-pill" onClick={pop('agent')} aria-haspopup="menu"><Bot size={14} aria-hidden="true" /> {autoAgent} <ChevronDown size={13} aria-hidden="true" /></button>
            </div>
            <textarea className="ncal-auto-prompt" value={autoPrompt} onChange={(e) => setAutoPrompt(e.target.value)} rows={4}
              placeholder={'Что сделать в момент события. Например: «Собери сводку SEO за неделю и положи отчётом в проект»'} aria-label="Задание агенту" />
            <p className="ncal-hint">{repeat.id !== 'none' ? 'Задание уйдёт агенту в начале каждого повторения.' : 'Задание уйдёт агенту в начале события.'} Ответ придёт в чат.</p>
            {original?.run && (
              <p className="ncal-hint" data-tone={original.run.error ? 'danger' : undefined}>
                {original.run.error ? `Последний запуск не удался: ${original.run.error}` : `Запущено ${runFmt.format(new Date(original.run.fired_at.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')))}${original.run.inbox_id ? ` · сообщение #${original.run.inbox_id}` : ''}`}
              </p>
            )}
          </section>
        )}
        {original?.source && <p className="ncal-hint ncal-source"><Bot size={13} aria-hidden="true" /> Поставил {original.source}</p>}

        {showPlace && (
          <label className="ncal-place">
            <MapPin size={15} aria-hidden="true" />
            <input className="ncal-inline-input" value={d.location || ''} onChange={(e) => set({ location: e.target.value })} placeholder="Место или ссылка на встречу" autoFocus={!d.location} />
          </label>
        )}

      </div>

      {menu?.kind === 'repeat' && (
        <Menu anchor={menu.anchor} label="Повтор" onClose={() => setMenu(null)} compact>
          {REPEATS.map((r) => (
            <MenuItem key={r.id} icon={repeat.id === r.id ? <Check size={14} /> : <span className="ncal-menu-pad" />} onSelect={() => { set({ recurrenceRule: r.rule }); setMenu(null); }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'remind' && (
        <Menu anchor={menu.anchor} label="Напоминание" onClose={() => setMenu(null)} compact>
          {REMINDERS.map((r) => (
            <MenuItem key={String(r.value)} icon={(d.reminderMinutesBefore ?? null) === r.value ? <Check size={14} /> : <span className="ncal-menu-pad" />} onSelect={() => { set({ reminderMinutesBefore: r.value }); setMenu(null); }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'agent' && (
        <Menu anchor={menu.anchor} label="Агент" onClose={() => setMenu(null)} compact>
          {(agents.length ? agents : ['Claude', 'ChatGPT', 'Джарвис']).map((name) => (
            <MenuItem key={name} icon={autoAgent === name ? <Check size={14} /> : <span className="ncal-menu-pad" />} onSelect={() => { setAutoAgent(name); setMenu(null); }}>{name}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'color' && (
        <Menu anchor={menu.anchor} label="Цвет" onClose={() => setMenu(null)} compact>
          <div className="ncal-menu-colors" role="radiogroup" aria-label="Цвет">
            {COLORS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={(d.color || 'blue') === c.id} aria-label={c.label} title={c.label}
                className="ncal-swatch" style={{ '--ev': colorVar(c.id) } as React.CSSProperties} onClick={() => { set({ color: c.id }); setMenu(null); }} />
            ))}
          </div>
        </Menu>
      )}
      {(menu?.kind === 'startDate' || menu?.kind === 'endDate') && (
        <DatePicker
          anchor={menu.anchor}
          value={menu.kind === 'startDate' ? d.start : d.end}
          onPick={(iso) => {
            if (!iso) return;
            if (menu.kind === 'startDate') setStart(withDate(d.start, iso));
            else set({ end: withDate(d.end, iso) });
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </Sheet>
  );
}

// Для вида месяца и сетки: быстрое создание «на весь день» от дня.
export const allDayDraft = (day: Date) => newDraft(day, addDays(day, 0), true);
