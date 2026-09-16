import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronRight, Eye, Pencil, Plus, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "../../lib/labels";
import { markSeen, seenDelta } from "../../lib/seen";
import { orderTodos, positionBetween, todoPosition } from "../../lib/tree";
import type { Project, Todo } from "../../types";
import { DocShell, DrawerToggle, MetaStrip, useDrawer } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import { usePersistentState, type TabsApi } from "./tabs";
import { useDraft, useRemembered } from "./uiMemory";

// Порядок колонок как на прежней доске; «Готово» и «Архив» — одна колонка.
const COLUMNS = ["open", "next", "doing", "review", "blocked", "done"];
const matches = (column: string, status: string) => (column === "done" ? status === "done" || status === "archived" : status === column);
/** Служебные ключи props, которые ставит сам интерфейс или агенты для себя — человеку их не показываем. */
const HIDDEN_PROPS = new Set(["position"]);

function snippet(note: string) {
  const text = note.replace(/^#+\s*/gm, "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export function TodoBoard({ project, tabs, onSaved }: { project: Project; tabs: TabsApi; onSaved: () => void }) {
  const [order, setOrder] = useState<Todo[]>(() => orderTodos(project.todos));
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [showDone, setShowDone] = usePersistentState("mbox.board.showDone", false);
  const [title, setTitle, discardTitle] = useDraft(`board:${project.id}:add`, "");
  const [adding, setAdding] = usePersistentState(`mbox.board.adding.${project.id}`, false);
  const [, setSeenTick] = useState(0);

  useEffect(() => setOrder(orderTodos(project.todos)), [project.todos]);

  async function move(fromId: string, toStatus: string, beforeId?: string) {
    const current = [...order];
    const fromIndex = current.findIndex((todo) => todo.id === fromId);
    if (fromIndex < 0) return;
    const [moved] = current.splice(fromIndex, 1);
    const updated: Todo = { ...moved, status: matches(toStatus, moved.status) ? moved.status : toStatus };
    const column = current.filter((todo) => matches(toStatus, todo.status));
    const at = beforeId ? column.findIndex((todo) => todo.id === beforeId) : column.length;
    const index = at < 0 ? column.length : at;
    const position = positionBetween(column[index - 1] ? todoPosition(column[index - 1], 0) : undefined, column[index] ? todoPosition(column[index], 0) : undefined);
    const globalAt = beforeId ? current.findIndex((todo) => todo.id === beforeId) : current.length;
    current.splice(globalAt < 0 ? current.length : globalAt, 0, updated);
    setOrder(current);
    setOver(null);
    try {
      await saveEntity("/api/mbox/todos", moved.id, { status: updated.status, props: { ...(moved.props || {}), position: String(position) } });
      onSaved();
    } catch {
      setOrder(orderTodos(project.todos));
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const created = await saveEntity("/api/mbox/todos", "", { project_id: project.id, title: title.trim(), note: "", status: "open", priority: "normal", access_level: "private" }) as { todo?: { id: string; memory_bytes: number } };
    if (created.todo) markSeen(`todo:${created.todo.id}`, created.todo.memory_bytes);
    discardTitle("");
    setAdding(false);
    onSaved();
  }

  function open(todo: Todo, pin = false) {
    markSeen(`todo:${todo.id}`, todo.memory_bytes);
    setSeenTick((value) => value + 1);
    tabs.open(`todo:${todo.id}`, pin);
  }

  const active = order.filter((todo) => !["done", "archived"].includes(todo.status)).length;

  return (
    <div className="wb-board">
      <div className="wb-doc-bar">
        <span className="wb-doc-crumbs"><span className="wb-project-dot" style={{ ["--project-color" as string]: project.color || "#5b6b66" }} /> {project.name} › Задачи · {active} активных</span>
        <div className="wb-doc-actions">
          <button type="button" className={showDone ? "is-on" : undefined} onClick={() => setShowDone(!showDone)}>{showDone ? "Скрыть готовые" : "Показать готовые"}</button>
          <button type="button" className="is-primary" onClick={() => setAdding(true)}><Plus size={14} /> Задача</button>
        </div>
      </div>
      {adding && (
        <form className="wb-board-add" onSubmit={create}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Что нужно сделать — Enter создаст задачу в «В ожидании»" autoFocus onKeyDown={(event) => { if (event.key === "Escape") { setAdding(false); discardTitle(""); } }} />
          <button type="submit" disabled={!title.trim()}>Создать</button>
          <button type="button" onClick={() => { setAdding(false); discardTitle(""); }} aria-label="Отмена"><X size={14} /></button>
        </form>
      )}
      <div className="wb-board-columns">
        {COLUMNS.map((status) => {
          const items = order.filter((todo) => matches(status, todo.status));
          const collapsed = status === "done" && !showDone;
          return (
            <section
              key={status}
              className={["wb-board-column", `status-${status}`, over === status ? "is-over" : "", !items.length || collapsed ? "is-slim" : ""].filter(Boolean).join(" ")}
              onDragOver={(event) => { event.preventDefault(); setOver(status); }}
              onDragLeave={() => setOver((current) => (current === status ? null : current))}
              onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || dragId; setDragId(null); if (id) void move(id, status); }}
              title={todoStatusHint[status]}
            >
              <header>
                <i className={`wb-status-dot status-${status}`} />
                <span>{todoStatusLabel(status)}</span>
                <b>{items.length}</b>
              </header>
              {!collapsed && items.map((todo) => {
                const mark = seenDelta(`todo:${todo.id}`, todo.memory_bytes);
                return (
                  <article
                    key={todo.id}
                    className={["wb-card", tabs.active === `todo:${todo.id}` ? "is-active" : "", dragId === todo.id ? "is-dragging" : "", mark.state !== "seen" ? "is-unseen" : ""].filter(Boolean).join(" ")}
                    draggable
                    onDragStart={(event) => { setDragId(todo.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", todo.id); }}
                    onDragEnd={() => { setDragId(null); setOver(null); }}
                    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setOver(status); }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer.getData("text/plain") || dragId; setDragId(null); if (id && id !== todo.id) void move(id, status, todo.id); }}
                    onClick={() => open(todo)}
                    onDoubleClick={() => open(todo, true)}
                  >
                    <div className="wb-card-title">
                      {(todo.priority === "urgent" || todo.priority === "high") && <span className={`wb-priority priority-${todo.priority}`} title={todoPriorityLabels[todo.priority]}>!</span>}
                      {todo.title}
                    </div>
                    {todo.note && <div className="wb-card-snippet">{snippet(todo.note)}</div>}
                    <div className="wb-card-foot">
                      <span>#{todo.id}</span>
                      {mark.state !== "seen" && <span className="wb-card-new">{mark.state === "new" ? "новое" : "изменено"}</span>}
                      {todo.claimed_by && <span className="wb-card-agent" title={`Держит ${todo.claimed_by}`}><AgentAvatar name={todo.claimed_by} size={14} />{todo.claimed_by}</span>}
                    </div>
                  </article>
                );
              })}
              {collapsed && items.length > 0 && <button type="button" className="wb-board-more" onClick={() => setShowDone(true)}>показать {items.length}</button>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

type Draft = { title: string; note: string; status: string; priority: string; props: Record<string, string> };

export function TodoDocument({ project, todo, tabs, tabKey, visible, onDirty, onSaved }: {
  project: Project;
  todo: Todo;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
  onSaved: () => void;
}) {
  const initial = useMemo<Draft>(() => ({ title: todo.title, note: todo.note, status: todo.status, priority: todo.priority, props: { ...(todo.props || {}) } }), [todo]);
  const [draft, setDraft, discardDraft] = useDraft<Draft>(`todo:${todo.id}`, initial);
  const [mode, setMode] = useRemembered<"preview" | "edit">(`todo:${todo.id}:mode`, todo.note ? "preview" : "edit");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [drawerOpen, setDrawerOpen] = useDrawer("mbox.doc.todo.props");
  const [newKey, setNewKey] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  // Пришли свежие данные (агент обновил задачу) — подхватываем, если своих правок нет.
  useEffect(() => { if (!dirty) setDraft(initial); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);
  useEffect(() => { markSeen(`todo:${todo.id}`, todo.memory_bytes); }, [todo.id, todo.memory_bytes]);

  async function save(patch?: Partial<Draft>) {
    const next = { ...draft, ...patch };
    setState("saving");
    try {
      await saveEntity("/api/mbox/todos", todo.id, next);
      discardDraft(next);
      setState("idle");
      onSaved();
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    if (!visible) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function remove() {
    if (!window.confirm(`Удалить задачу «${todo.title}»?`)) return;
    await fetchJson(`/api/mbox/todos/${todo.id}`, { method: "DELETE" });
    discardDraft();
    onDirty(tabKey, false);
    tabs.close(tabKey);
    onSaved();
  }

  const visibleProps = Object.entries(draft.props).filter(([key]) => !HIDDEN_PROPS.has(key));
  const leaseActive = todo.claimed_by && todo.claimed_until && new Date(todo.claimed_until) > new Date();

  return (
    <DocShell
      drawerOpen={drawerOpen}
      onCloseDrawer={() => setDrawerOpen(false)}
      toolbar={(
        <>
          <span className="wb-doc-crumbs">
            <button type="button" className="wb-meta-link" onClick={() => tabs.open(`todos:${project.id}`, true)}>{project.name}</button> › задача #{todo.id}{dirty && <b className="wb-dirty-mark"> ●</b>}
          </span>
          <div className="wb-doc-actions">
            {/* Статус и приоритет сохраняются сразу — это действие, а не правка текста. */}
            <select className="wb-bar-select" value={draft.status} onChange={(event) => { setDraft({ ...draft, status: event.target.value }); void save({ status: event.target.value }); }} title={todoStatusHint[draft.status]}>
              {Object.entries(todoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select className="wb-bar-select" value={draft.priority} onChange={(event) => { setDraft({ ...draft, priority: event.target.value }); void save({ priority: event.target.value }); }} title="Приоритет">
              {Object.entries(todoPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <div className="wb-segmented">
              <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => setMode("preview")} title="Просмотр"><Eye size={13} /></button>
              <button type="button" className={mode === "edit" ? "is-on" : undefined} onClick={() => setMode("edit")} title="Правка"><Pencil size={13} /></button>
            </div>
            <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} label="Свойства" count={visibleProps.length} />
            {dirty && <button type="button" onClick={() => setDraft(initial)} title="Отменить правки"><X size={14} /></button>}
            {dirty && <button type="button" className="is-primary" disabled={state === "saving"} onClick={() => void save()}><Save size={14} /> {state === "saving" ? "Сохраняю…" : "Сохранить"}</button>}
            <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить задачу"><Trash2 size={14} /></button>
          </div>
        </>
      )}
      drawer={(
        <section>
          <h3><SlidersHorizontal size={11} /> Свойства</h3>
          <div className="wb-kv">
            {visibleProps.map(([key, value]) => (
              <div key={key} className="wb-kv-row">
                <span title={key}>{key}</span>
                <input value={value} onChange={(event) => setDraft({ ...draft, props: { ...draft.props, [key]: event.target.value } })} />
                <button type="button" onClick={() => { const props = { ...draft.props }; delete props[key]; setDraft({ ...draft, props }); }} aria-label={`Убрать ${key}`}><X size={12} /></button>
              </div>
            ))}
            {!visibleProps.length && <p className="wb-empty">Свойств нет. Сюда агенты кладут факты: контекст, критерий готовности, зависимости.</p>}
            <form className="wb-kv-add" onSubmit={(event) => { event.preventDefault(); const key = newKey.trim(); if (!key) return; setDraft({ ...draft, props: { ...draft.props, [key]: draft.props[key] ?? "" } }); setNewKey(""); }}>
              <input value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder="новое свойство" />
              <button type="submit" disabled={!newKey.trim()}><Plus size={12} /></button>
            </form>
          </div>
        </section>
      )}
    >
      {state === "error" && <div className="wb-banner is-error">Не сохранилось — попробуйте ещё раз (Ctrl+S).</div>}
      <article className="wb-reading">
        <textarea
          className="wb-title-input"
          value={draft.title}
          rows={1}
          onChange={(event) => setDraft({ ...draft, title: event.target.value.replace(/\n/g, " ") })}
          onInput={(event) => { const el = event.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
          ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
          placeholder="Название задачи"
        />
        <MetaStrip items={[
          leaseActive ? <span className="wb-meta-agent"><AgentAvatar name={todo.claimed_by} size={14} /> держит {todo.claimed_by}</span> : todo.claimed_by ? `брал ${todo.claimed_by}` : null,
          todo.heartbeat_at ? `активность ${formatSince(todo.heartbeat_at)}` : null,
        ]} />
        {mode === "edit" ? (
          <textarea className="wb-note-editor is-inline" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Описание, критерий готовности, ход работы. Markdown: # заголовки, - списки, `код`." autoFocus={!todo.note} />
        ) : draft.note.trim() ? (
          <div className="wb-memory-body" onDoubleClick={() => setMode("edit")}>{renderDocument(draft.note)}</div>
        ) : (
          <button type="button" className="wb-empty-action" onClick={() => setMode("edit")}><ChevronRight size={12} /> Добавить описание</button>
        )}
      </article>
    </DocShell>
  );
}
