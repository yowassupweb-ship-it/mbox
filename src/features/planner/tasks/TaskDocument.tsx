import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  AlertCircle, ArrowLeft, Bot, CalendarDays, Check, ChevronDown, Eye, Flag, FolderClosed, Loader2, MoreHorizontal, Pencil,
  Repeat, Search, Trash2, UserPlus,
} from 'lucide-react';
import { showToast } from '../ui/Toast';
import { displayName, myId, usePeople } from '../people';
import { Avatar } from '../ui/Avatar';
import { askConfirm, Menu, MenuItem, Sheet, type MenuAnchor } from '../ui/overlay';
import {
  assigneesOf, deleteTask, DONE_STATUS, isDone, PERSONAL, PRIORITIES, saveText, STATUSES, statusOf, taskMarkdown, updateTask, useTasks,
  type Priority, type Status, type Task,
} from './api';
import { renderMarkdown, toggleTaskLine } from './markdown';
import { repeatIdOf, repeatLabel, TASK_REPEATS } from './repeat';
import { DatePicker } from '../ui/DatePicker';
import { continueList, MarkdownToolbar, markdownShortcut } from './MarkdownToolbar';
import { pinTaskTab } from '../nav';

/**
 * Задача — документ, как заметка MBOX: первая строка — крупный заголовок, дальше markdown с панелью форматирования.
 * Два режима — «Просмотр» (чек-лист кликается прямо в тексте) и «Правка»; пустая задача сразу в правке.
 * Сохраняется само через 700 мс после последней правки и при уходе.
 * Сверху — свойства: выполнена, статус, исполнители (люди и агенты), срок, повтор, важность, список (проект).
 */

const SAVE_DELAY = 700;
type SaveState = 'saved' | 'pending' | 'saving' | 'error';
type MenuKind = 'status' | 'priority' | 'list' | 'more' | 'date' | 'repeat';

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
export function dueLabel(iso?: string | null): { text: string; late: boolean } | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  const text = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера' : dateFmt.format(d);
  return { text, late: diff < 0 };
}

export default function TaskDocument({ task, onBack, onGone }: {
  task: Task;
  onBack: () => void;
  onGone: () => void;
}) {
  const initial = useMemo(() => ({ title: task.title || '', md: taskMarkdown(task) }),
    // Документ живёт, пока открыта эта задача: чужие правки текста подхватываем ниже.
    [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(initial.title);
  const [md, setMd] = useState(initial.md);
  const [mode, setMode] = useState<'edit' | 'preview'>(() => (initial.title || initial.md.trim() ? 'preview' : 'edit'));
  const [state, setState] = useState<SaveState>('saved');
  const saved = useRef(initial);
  const latest = useRef(initial);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: MenuAnchor } | null>(null);
  const [people, setPeople] = useState(false);
  const users = usePeople((s) => s.users);
  const lists = useTasks((s) => s.lists);

  useEffect(() => { latest.current = { title, md }; }, [title, md]);

  const save = useCallback(async () => {
    const cur = latest.current;
    if (cur.title === saved.current.title && cur.md === saved.current.md) { setState('saved'); return; }
    setState('saving');
    try {
      await saveText(task.id, cur.title.trim(), cur.md);
      saved.current = cur;
      setState(latest.current === cur ? 'saved' : 'pending');
    } catch {
      setState('error');
    }
  }, [task.id]);

  // Автосохранение. Первая правка закрепляет вкладку-превью: следующий клик в списке её не заменит.
  useEffect(() => {
    if (title === saved.current.title && md === saved.current.md) return undefined;
    pinTaskTab(task.id);
    setState('pending');
    const t = window.setTimeout(() => void save(), SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [title, md, save, task.id]);

  // Уход с задачи: досохранить. Пустую новую убирает экран списка — при смене задачи, а не здесь:
  // StrictMode вызывает эту очистку сразу после монтирования, и новая задача удалялась бы на глазах.
  useEffect(() => () => {
    const cur = latest.current;
    if (cur.title === saved.current.title && cur.md === saved.current.md) return;
    const save = (): Promise<unknown> => saveText(task.id, cur.title.trim(), cur.md);
    // Раньше ошибка глоталась: задача закрывалась, а текст тихо терялся.
    void save().catch(() => showToast('Задача не сохранилась', 'error', { label: 'Повторить', run: () => { void save().catch(() => showToast('Задача снова не сохранилась — проверьте связь', 'error')); } }));
  }, [task.id]);

  // Чужая правка текста (агент, канбан проекта): без своих несохранённых — берём.
  const remoteMd = taskMarkdown(task);
  useEffect(() => {
    const mine = latest.current.title !== saved.current.title || latest.current.md !== saved.current.md;
    if (mine) return;
    if (task.title === saved.current.title && remoteMd === saved.current.md) return;
    saved.current = { title: task.title || '', md: remoteMd };
    setTitle(task.title || '');
    setMd(remoteMd);
  }, [task.title, remoteMd]);

  const finishEditing = useCallback(() => { void save(); setMode('preview'); }, [save]);

  // Ctrl+S — сохранить сейчас; Esc в правке — «Готово» (если не открыт лист или меню).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      if (e.key === 'Escape' && mode === 'edit' && !document.querySelector('#planner-overlays .nx-scrim, #planner-overlays .nx-menu')) { e.preventDefault(); finishEditing(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, mode, finishEditing]);

  // В правке — фокус в заголовок (пустой) или в текст.
  useEffect(() => {
    if (mode !== 'edit') return;
    (latest.current.title ? bodyRef.current : titleRef.current)?.focus();
  }, [mode, task.id]);

  // Высота полей по содержимому — страница прокручивается целиком, как документ.
  useEffect(() => {
    for (const el of [titleRef.current, bodyRef.current]) {
      if (!el) continue;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title, md, mode]);

  // Успех видно по самой задаче — всплывашки только об ошибках, иначе их сыпалось по штуке на клик.
  const patch = async (p: Partial<Task>) => {
    try { await updateTask(task.id, p); } catch { showToast('Не сохранилось — нет связи с сервером.', 'error'); }
  };

  const remove = async () => {
    const text = task.listId === PERSONAL ? 'Вернуть не получится.' : 'Задача пропадёт из проекта — и у агентов тоже. Вернуть не получится.';
    if ((title.trim() || md.trim()) && !(await askConfirm({ title: 'Удалить задачу?', text, confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteTask(task.id); onGone(); } catch { showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };

  const onTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'ArrowDown') {
      e.preventDefault();
      const el = bodyRef.current;
      el?.focus();
      el?.setSelectionRange(0, 0);
    }
  };
  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (markdownShortcut(e) || continueList(e)) return;
    const el = e.currentTarget;
    if ((e.key === 'Backspace' || e.key === 'ArrowUp') && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      const t = titleRef.current;
      t?.focus();
      t?.setSelectionRange(t.value.length, t.value.length);
    }
  };

  const repeat = repeatIdOf(task);
  const status = statusOf(task);
  const statusInfo = [...STATUSES, DONE_STATUS].find((s) => s.id === status) || STATUSES[2];
  const done = isDone(task);
  const assignees = task.assignees;
  const due = dueLabel(task.dueDate);
  const list = lists.find((l) => l.id === task.listId);
  const priority = PRIORITIES.find((p) => p.id === task.priority) || PRIORITIES[2];
  const me = myId();
  const nameOf = (id: string) => (id === me ? 'Мне' : displayName(users[id], id));
  const open = (kind: MenuKind) => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: { element: e.currentTarget, align: kind === 'more' ? 'end' : 'start' } });

  return (
    <section className="ntd" aria-label={title || 'Задача'}>
      <header className="ntd-bar">
        <button type="button" className="nx-icon-btn ntd-back" onClick={onBack} aria-label="К списку задач"><ArrowLeft size={20} aria-hidden="true" /></button>
        {/* Одна кнопка режима, как «Править / Готово» в iOS: всегда видно, в каком режиме документ и как из него выйти. */}
        {mode === 'preview' ? (
          <button type="button" className="nx-ghost ntd-mode" onClick={() => setMode('edit')}>
            <Pencil size={15} aria-hidden="true" /> Редактировать
          </button>
        ) : (
          <button type="button" className="nx-primary ntd-mode" onClick={finishEditing}>
            <Eye size={15} aria-hidden="true" /> Готово
          </button>
        )}
        <span className="ntd-save" aria-live="polite">
          {state === 'error' ? <span data-tone="danger"><AlertCircle size={13} aria-hidden="true" /> Не сохранилось — Ctrl+S</span>
            : state === 'saving' || state === 'pending' ? <span><Loader2 size={13} className="nx-spin" aria-hidden="true" /> Сохраняю</span>
              : <span><Check size={13} aria-hidden="true" /> Сохранено</span>}
        </span>
        <button type="button" className="nx-icon-btn" onClick={open('more')} aria-label="Ещё действия" aria-haspopup="menu"><MoreHorizontal size={18} /></button>
      </header>

      <div className="ntd-props" role="group" aria-label="Свойства задачи">
        <button type="button" className="ntd-chip" data-done={done ? 'true' : undefined} onClick={() => void patch({ status: done ? 'open' : 'done' })}>
          <span className="ntd-done-box" aria-hidden="true">{done && <Check size={12} strokeWidth={3} />}</span>
          {done ? 'Выполнена' : 'Выполнить'}
        </button>
        <button type="button" className="ntd-chip" style={{ '--tone': statusInfo.tone } as CSSProperties} onClick={open('status')} aria-haspopup="menu">
          <i className="ntd-dot" aria-hidden="true" />{statusInfo.label}<ChevronDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="ntd-chip" onClick={() => setPeople(true)} aria-label="Исполнители">
          <span className="ntd-chip-label">Исполнитель</span>
          {assignees.length ? (
            <span className="ntd-faces">
              {assignees.slice(0, 3).map((id) => <Avatar key={id} name={displayName(users[id], id) || '?'} seed={id} person size={20} />)}
            </span>
          ) : <UserPlus size={14} aria-hidden="true" />}
          {assignees.length === 1 ? nameOf(assignees[0]) : assignees.length ? `${assignees.length} исполнителя` : 'не назначен'}
        </button>
        {task.claimActive && task.claimedBy && (
          <span className="ntd-chip" data-static="true" title="Агент взял задачу в работу (claim) и держит её">
            <Bot size={14} aria-hidden="true" />{task.claimedBy} работает
          </span>
        )}
        <button type="button" className="ntd-chip" data-tone={due?.late && !done ? 'danger' : undefined} onClick={open('date')} aria-haspopup="menu">
          <CalendarDays size={14} aria-hidden="true" />
          {due ? due.text : 'Срок'}
        </button>
        <button type="button" className="ntd-chip" data-on={repeat !== 'none' ? 'true' : undefined} onClick={open('repeat')} aria-haspopup="menu" title="Повторять задачу: выполненная переносится на следующий срок">
          <Repeat size={14} aria-hidden="true" />{repeat !== 'none' ? repeatLabel(repeat) : 'Повтор'}
        </button>
        <button type="button" className="ntd-chip" data-priority={task.priority} onClick={open('priority')} aria-haspopup="menu">
          <Flag size={14} aria-hidden="true" />{priority.label}
        </button>
        {lists.length > 0 && (
          <button type="button" className="ntd-chip" onClick={open('list')} aria-haspopup="menu" style={list?.color ? ({ '--tone': list.color } as CSSProperties) : undefined}>
            <FolderClosed size={14} aria-hidden="true" />{list?.name || 'Без списка'}
          </button>
        )}
      </div>

      {mode === 'edit' && <MarkdownToolbar targetRef={bodyRef} />}

      <div className="ntd-scroll nx-scroll-y">
        {mode === 'edit' ? (
          <div className="ntd-page">
            <textarea
              ref={titleRef}
              className="ntd-title"
              rows={1}
              value={title}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={onTitleKey}
              onBlur={() => void save()}
              placeholder="Что нужно сделать"
              aria-label="Заголовок задачи"
            />
            <textarea
              ref={bodyRef}
              className="ntd-body"
              value={md}
              onChange={(e) => setMd(e.target.value)}
              onKeyDown={onBodyKey}
              onBlur={() => void save()}
              placeholder={'Подробности, чек-лист, ссылки. Панель сверху или Ctrl+B, Ctrl+Shift+9 — чек-лист. Сохраняется само.'}
              aria-label="Текст задачи"
            />
          </div>
        ) : (
          <article className="ntd-page ntd-read" onDoubleClick={() => setMode('edit')}>
            <h1 className="ntd-title-view" data-done={done ? 'true' : undefined}>{title || 'Без названия'}</h1>
            {md.trim()
              ? <div className="ntd-md">{renderMarkdown(md, { onToggleTask: (line) => setMd((cur) => toggleTaskLine(cur, line)) })}</div>
              : <p className="ntd-empty">Описания нет. Двойной клик или «Редактировать» — добавить подробности и чек-лист.</p>}
          </article>
        )}
      </div>

      {menu?.kind === 'status' && (
        <Menu anchor={menu.anchor} label="Статус" onClose={() => setMenu(null)}>
          {[...STATUSES, DONE_STATUS].map((s) => (
            <MenuItem key={s.id} icon={s.id === status ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': s.tone } as CSSProperties} />} onSelect={() => { setMenu(null); void patch({ status: s.id as Status }); }}>{s.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'priority' && (
        <Menu anchor={menu.anchor} label="Важность" onClose={() => setMenu(null)}>
          {PRIORITIES.map((p) => (
            <MenuItem key={p.id} icon={p.id === task.priority ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => { setMenu(null); void patch({ priority: p.id as Priority }); }}>{p.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'repeat' && (
        <Menu anchor={menu.anchor} label="Повтор" onClose={() => setMenu(null)}>
          {TASK_REPEATS.map((r) => (
            <MenuItem key={r.id} icon={r.id === repeat ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => {
              setMenu(null);
              // Повтору нужен срок, от которого считать: без срока — с сегодняшнего дня.
              const today = new Date();
              const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
              void patch({ repeat: r.id === 'none' ? null : r.id, ...(r.id !== 'none' && !task.dueDate ? { dueDate: iso } : {}) });
            }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'date' && (
        <DatePicker anchor={menu.anchor} value={task.dueDate} onPick={(iso) => void patch({ dueDate: iso })} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === 'list' && (
        <Menu anchor={menu.anchor} label="Список" onClose={() => setMenu(null)}>
          {lists.map((l) => (
            <MenuItem key={l.id} icon={l.id === task.listId ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': l.color || 'var(--note-gray)' } as CSSProperties} />} onSelect={() => { setMenu(null); void patch({ listId: l.id }); }}>{l.name}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'more' && (
        <Menu anchor={menu.anchor} label="Задача" onClose={() => setMenu(null)}>
          <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { setMenu(null); void remove(); }}>Удалить задачу</MenuItem>
        </Menu>
      )}
      {people && <PeopleSheet title="Исполнители" selected={assignees} onClose={() => setPeople(false)} onSave={(ids) => { setPeople(false); void patch({ assignees: ids }); }} />}
    </section>
  );
}

/** Выбор исполнителей: люди и агенты MBOX, можно несколько. */
function PeopleSheet({ title, selected, onClose, onSave }: { title: string; selected: string[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const users = usePeople((s) => s.users);
  const [pick, setPick] = useState<string[]>(selected);
  const [query, setQuery] = useState('');
  const me = myId();
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.id === me) - Number(a.id === me) || Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name, 'ru'));
  }, [users, query, me]);
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" onClick={() => onSave(pick)}>Готово{pick.length ? ` · ${pick.length}` : ''}</button>
        </>
      )}
    >
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти человека или агента</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти человека или агента" autoComplete="off" autoFocus />
      </label>
      <div className="ntd-people">
        {list.map((u) => (
          <button key={u.id} type="button" className="nx-pick" aria-pressed={pick.includes(u.id)} onClick={() => toggle(u.id)}>
            <Avatar name={u.name} seed={u.id} person size={32} />
            <span className="nx-pick-text"><span>{u.id === me ? `${u.name} (я)` : u.name}</span>{u.kind === 'agent' && <small>агент</small>}</span>
            {pick.includes(u.id) && <Check size={16} className="ntd-picked" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
