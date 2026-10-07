import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AlertCircle, Bot, CalendarDays, CalendarX, Check, ChevronDown, ChevronRight, CircleCheck, Columns2, Copy, ExternalLink, Flag, FolderClosed, PanelTop, Plus, RotateCcw, RotateCw, Search, Trash2 } from 'lucide-react';
import { showToast } from '../ui/Toast';
import { displayName, loadPeople, usePeople } from '../people';
import { Avatar } from '../ui/Avatar';
import { plural } from '../ui/format';
import { SearchField } from '../ui/SearchField';
import { SectionIcon } from '../ui/SectionIcon';
import { useLongPress } from '../ui/useLongPress';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '../ui/overlay';
import {
  assigneesOf, createTask, deleteTask, DONE_STATUS, isDone, isImportant, loadTasks, PERSONAL, STATUSES, statusOf, type Status, taskMarkdown,
  type Task, type TaskList, updateTask, useTasks,
} from './api';
import { checklistProgress, plainSnippet } from './markdown';
import { dueLabel } from './TaskDocument';
import { closeTaskTab, openTask, usePlannerNav } from '../nav';

/**
 * Список задач «Дел» (из shar-2) — в боковой панели: поиск, выбор списка и задачи по статусам. Здесь все задачи разом:
 * личные и задачи всех проектов, к которым есть доступ. Задача открывается вкладкой-документом (TaskTab).
 */

const FILTER_KEY = 'mbox.planner.taskList';
const readStored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key: string, value: string | null) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* без памяти */ } };

/** Фильтр списка: все, только личные или один проект. */
type ListFilter = 'all' | string;

const Row = memo(function Row({ t, list, active, onOpen, onMenu }: { t: Task; list?: TaskList; active: boolean; onOpen: (id: string) => void; onMenu: (t: Task, at: MenuAnchor) => void }) {
  const users = usePeople((s) => s.users);
  const done = isDone(t);
  const due = dueLabel(t.dueDate);
  const md = taskMarkdown(t);
  const progress = checklistProgress(md);
  const snippet = plainSnippet(md);
  const press = useLongPress((x, y) => onMenu(t, { x, y }));
  const people = assigneesOf(t);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    void updateTask(t.id, { status: done ? 'open' : 'done' }).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
  };
  return (
    <div role="button" tabIndex={0} className="ntl-row" data-task-id={t.id} aria-current={active ? 'true' : undefined} data-done={done ? 'true' : undefined} onClick={() => onOpen(t.id)} onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(t.id);
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); onMenu(t, { element: e.currentTarget, align: 'start' }); }
      }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(t, { x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <button type="button" className="ntl-check" onClick={toggle} aria-label={done ? 'Вернуть в работу' : 'Отметить выполненной'} aria-pressed={done}>
        {done && <Check size={12} strokeWidth={3} aria-hidden="true" />}
      </button>
      <span className="ntl-text">
        <span className="ntl-name">{t.title || 'Без названия'}</span>
        {snippet && <span className="ntl-snippet">{snippet}</span>}
        <span className="ntl-meta">
          {isImportant(t) && <span className="ntl-flag">{t.priority === 'urgent' ? 'Срочно' : 'Важно'}</span>}
          {due && <span data-tone={due.late && !done ? 'danger' : undefined}>{due.text}</span>}
          {t.repeat && <span>↻</span>}
          {progress.total > 0 && <span className="ntl-progress" style={{ '--p': `${Math.round((progress.done / progress.total) * 100)}%` } as CSSProperties}>{progress.done}/{progress.total}</span>}
          {list && <span className="ntl-tag" style={list.color ? ({ '--tone': list.color } as CSSProperties) : undefined}>{list.name}</span>}
          {t.claimActive && t.claimedBy && <span className="ntl-agent"><Bot size={11} aria-hidden="true" />{t.claimedBy}</span>}
        </span>
      </span>
      {people.length > 0 && (
        <span className="ntl-faces" aria-label={people.map((id) => displayName(users[id], id)).join(', ')}>
          {people.slice(0, 2).map((id) => <Avatar key={id} name={displayName(users[id], id) || '?'} seed={id} person size={22} />)}
        </span>
      )}
    </div>
  );
});

export function TaskList() {
  const tasks = useTasks((s) => s.tasks);
  const lists = useTasks((s) => s.lists);
  const phase = useTasks((s) => s.phase);
  const activeId = usePlannerNav((s) => s.activeTask);
  const [filter, setFilter] = useState<ListFilter>(() => readStored(FILTER_KEY) || 'all');
  const [fresh, setFresh] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ task: Task; anchor: MenuAnchor } | null>(null);
  const [listMenu, setListMenu] = useState<MenuAnchor | null>(null);
  const onMenu = useCallback((task: Task, anchor: MenuAnchor) => setMenu({ task, anchor }), []);

  useEffect(() => { void loadPeople().then(() => loadTasks()); }, []);

  const open = useCallback((id: string) => openTask(id), []);
  const pickList = (value: ListFilter) => { writeStored(FILTER_KEY, value === 'all' ? null : value); setFilter(value); };

  const listsById = useMemo(() => Object.fromEntries(lists.map((l) => [l.id, l])), [lists]);
  const filterName = filter === 'all' ? 'Все списки' : listsById[filter]?.name || 'Список';

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const t = await createTask({ listId: filter === 'all' ? PERSONAL : filter });
      setFresh(t.id);
      openTask(t.id, 'tab');
    } catch {
      showToast('Задача не создалась — нет связи с сервером.', 'error');
    } finally {
      setCreating(false);
    }
  };

  // Ушли с только что созданной задачи, так ничего и не написав, — убираем её (и её вкладку), чтобы не копились «пустышки».
  useEffect(() => {
    if (!fresh || activeId === fresh) return undefined;
    const timer = window.setTimeout(() => {
      const left = useTasks.getState().tasks[fresh];
      if (left && !left.title.trim() && !taskMarkdown(left).trim()) {
        closeTaskTab(fresh);
        void deleteTask(fresh).catch(() => {});
      }
      setFresh(null);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeId, fresh]);

  const visible = useMemo(() => Object.values(tasks).filter((t) => {
    if (filter !== 'all' && t.listId !== filter) return false;
    if (deferred && !`${t.title} ${taskMarkdown(t)}`.toLowerCase().includes(deferred)) return false;
    return true;
  }), [tasks, filter, deferred]);

  const groups = useMemo(() => {
    // Сначала со сроком (раньше — выше), важные — выше в пределах дня, потом свежие.
    const weight = (t: Task) => (t.priority === 'urgent' ? 0 : t.priority === 'high' ? 1 : 2);
    const byDue = (a: Task, b: Task) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1)
      || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
      || weight(a) - weight(b)
      || String(b.updatedAt).localeCompare(String(a.updatedAt));
    const openTasks = visible.filter((t) => !isDone(t));
    const out = STATUSES.map((s) => ({ ...s, items: openTasks.filter((t) => statusOf(t) === s.id).sort(byDue) })).filter((g) => g.items.length);
    const done = visible.filter(isDone).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { open: out, done };
  }, [visible]);

  const openCount = groups.open.reduce((n, g) => n + g.items.length, 0);
  // В общем списке подпись проекта у строки нужна; в отфильтрованном по одному списку — лишняя.
  const listOf = (t: Task) => (filter === 'all' ? listsById[t.listId] : undefined);

  let body;
  if (phase === 'loading' && !Object.keys(tasks).length) {
    body = (
      <div aria-busy="true" aria-label="Загружаю задачи">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="nx-skel-row"><span className="nx-skel ntl-skel-check" /><span className="nx-skel nx-skel-line" style={{ '--w': `${40 + ((i * 19) % 45)}%` } as CSSProperties} /></div>
        ))}
      </div>
    );
  } else if (phase === 'error' && !Object.keys(tasks).length) {
    body = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил задачи</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void loadTasks()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
      </div>
    );
  } else if (!visible.length) {
    body = (
      <div className="nx-state">
        {deferred ? <Search size={28} aria-hidden="true" /> : <SectionIcon name="todo" size={64} />}
        <h2>{deferred ? 'Ничего не нашёл' : 'Задач нет'}</h2>
        <p>{deferred ? 'Ищу по названию и тексту задачи.' : 'Новая задача — кнопка «Задача» сверху.'}</p>
      </div>
    );
  } else {
    body = (
      <>
        {groups.open.map((g) => (
          <section key={g.id} className="ntl-group" style={{ '--tone': g.tone } as CSSProperties} aria-label={g.label}>
            <h3 className="ntl-group-head"><i aria-hidden="true" />{g.label}<span>{g.items.length}</span></h3>
            {g.items.map((t) => <Row key={t.id} t={t} list={listOf(t)} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}
          </section>
        ))}
        {groups.done.length > 0 && (
          <section className="ntl-group" aria-label="Выполненные">
            <button type="button" className="ntl-group-head ntl-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              <ChevronRight size={14} aria-hidden="true" />Выполненные<span>{groups.done.length}</span>
            </button>
            {showDone && groups.done.slice(0, 200).map((t) => <Row key={t.id} t={t} list={listOf(t)} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}
          </section>
        )}
      </>
    );
  }

  return (
    <div className="ntl ntl-side" aria-label="Задачи">
      <header className="ntl-head">
        <div className="ntl-filters">
          <button type="button" className="ntd-chip ntl-list-pick" onClick={(e) => setListMenu({ element: e.currentTarget, align: 'start' })} aria-haspopup="menu" title={`Какой список показывать · ${openCount} ${plural(openCount, ['открытая', 'открытых', 'открытых'])}`}>
            <FolderClosed size={14} aria-hidden="true" /><span>{filterName}</span><b>{openCount}</b><ChevronDown size={13} aria-hidden="true" />
          </button>
          <button type="button" className="nx-primary ntl-new" onClick={() => void create()} disabled={creating}>
            <Plus size={16} aria-hidden="true" /> Задача
          </button>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Поиск по задачам" />
      </header>
      <div className="ntl-list nx-scroll-y">{body}</div>

      {menu && <TaskMenu task={menu.task} anchor={menu.anchor} onClose={() => setMenu(null)} onDeleted={(id) => closeTaskTab(id)} />}
      {listMenu && (
        <Menu anchor={listMenu} label="Список" onClose={() => setListMenu(null)}>
          <MenuItem icon={filter === 'all' ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => { setListMenu(null); pickList('all'); }}>Все списки</MenuItem>
          <div className="nx-menu-sep" />
          {lists.map((l) => (
            <MenuItem key={l.id} icon={filter === l.id ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': l.color || 'var(--note-gray)', margin: '0 4px' } as CSSProperties} />} onSelect={() => { setListMenu(null); pickList(l.id); }}>{l.name}</MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Дата через n дней по местному времени (toISOString дал бы вчерашний день до 3 ночи по Москве). */
const isoDay = (plusDays: number) => { const d = new Date(); d.setDate(d.getDate() + plusDays); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Контекстное меню задачи — как в macOS: действие, статусы, сроки, удаление в самом низу. */
function TaskMenu({ task, anchor, onClose, onDeleted }: {
  task: Task; anchor: MenuAnchor; onClose: () => void; onDeleted: (id: string) => void;
}) {
  const done = isDone(task);
  const status = statusOf(task);
  const apply = (patch: Partial<Task>) => {
    onClose();
    void updateTask(task.id, patch).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
  };
  const remove = async () => {
    onClose();
    if (!(await askConfirm({ title: `Удалить «${task.title || 'Без названия'}»?`, text: task.listId === PERSONAL ? 'Вернуть не получится.' : 'Задача пропадёт из проекта — и у агентов тоже. Вернуть не получится.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteTask(task.id); onDeleted(task.id); } catch { showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };
  const copyLink = async () => {
    onClose();
    try { await navigator.clipboard.writeText(`${window.location.origin}/?tab=todo:${task.id}`); showToast('Ссылка скопирована', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
  };
  return (
    <Menu anchor={anchor} label={task.title || 'Задача'} onClose={onClose}>
      <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { onClose(); openTask(task.id); }}>Открыть</MenuItem>
      <MenuItem icon={<PanelTop size={16} />} onSelect={() => { onClose(); openTask(task.id, 'tab'); }}>Открыть в новой вкладке</MenuItem>
      <MenuItem icon={<Columns2 size={16} />} onSelect={() => { onClose(); openTask(task.id, 'split'); }}>Открыть во второй области</MenuItem>
      <MenuItem icon={done ? <RotateCcw size={16} /> : <CircleCheck size={16} />} onSelect={() => apply({ status: done ? 'open' : 'done' })}>
        {done ? 'Вернуть в работу' : 'Отметить выполненной'}
      </MenuItem>
      <div className="nx-menu-sep" />
      <div className="nx-menu-label">Статус</div>
      {[...STATUSES, DONE_STATUS].map((st) => (
        <MenuItem
          key={st.id}
          icon={st.id === status ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': st.tone, margin: '0 4px' } as CSSProperties} />}
          onSelect={() => apply({ status: st.id as Status })}
        >
          {st.label}
        </MenuItem>
      ))}
      <div className="nx-menu-sep" />
      <div className="nx-menu-label">Срок</div>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(0) })}>Сегодня</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(1) })}>Завтра</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(7) })}>Через неделю</MenuItem>
      {task.dueDate && <MenuItem icon={<CalendarX size={16} />} onSelect={() => apply({ dueDate: null })}>Убрать срок</MenuItem>}
      <div className="nx-menu-sep" />
      <MenuItem icon={<Flag size={16} />} onSelect={() => apply({ priority: isImportant(task) ? 'normal' : 'high' })}>
        {isImportant(task) ? 'Снять «Важно»' : 'Пометить важной'}
      </MenuItem>
      {task.listId !== PERSONAL && <MenuItem icon={<Copy size={16} />} onSelect={() => void copyLink()}>Скопировать ссылку</MenuItem>}
      <div className="nx-menu-sep" />
      <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => void remove()}>Удалить</MenuItem>
    </Menu>
  );
}
