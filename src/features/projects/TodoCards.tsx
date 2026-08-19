import { type FormEvent, useEffect, useState } from "react";
import { CheckCheck, Maximize2, Plus, Trash2, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { countUnseen, formatDelta, markAllSeen, markSeen, seenDelta } from "../../lib/seen";
import { todoPriorityLabel, todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "../../lib/labels";
import { orderTodos, positionBetween, todoPosition } from "../../lib/tree";
import type { Project, Todo } from "../../types";
import { Button, EmptyState, ErrorText, ManualForm, SaveButton, Select, TextArea, TextInput, type SaveState } from "../../ui";

const statusOptions = Object.entries(todoStatusLabels).map(([value, label]) => ({ value, label }));
const priorityOptions = Object.entries(todoPriorityLabels).map(([value, label]) => ({ value, label }));

// Явный порядок колонок кабана: В ожидании → В работе → Заблокирована → На проверке →
// Переработка → Готово. «Готово» и «Архив» — один бакет («Готово = архив»), отдельной
// колонки под архив нет: карточка со статусом archived показывается в «Готово», а всё,
// что туда перетащили, встаёт как done — canonical-статус у объединённой колонки один.
const kanbanColumns = ["open", "doing", "blocked", "review", "next", "done"];
const columnMatchesStatus = (columnStatus: string, todoStatus: string) =>
  columnStatus === "done" ? todoStatus === "done" || todoStatus === "archived" : todoStatus === columnStatus;

export function TodoCardGrid({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [openTodo, setOpenTodo] = useState<Todo | null>(null);
  const [order, setOrder] = useState<Todo[]>(() => orderTodos(project.todos));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [seenVersion, setSeenVersion] = useState(0);

  useEffect(() => setOrder(orderTodos(project.todos)), [project.todos]);

  /**
   * Карточка меняет статус (колонку) и/или позицию внутри неё одним драгом — как в Шаре.
   * Позиция — общее число на весь проект (см. lib/tree), поэтому «соседи» для перерасчёта
   * берутся из уже отфильтрованной по статусу колонки: другие статусы между ними не мешают.
   */
  async function moveCard(fromId: string, toStatus: string, beforeId?: string) {
    const current = [...order];
    const fromIndex = current.findIndex((todo) => todo.id === fromId);
    if (fromIndex < 0) return;
    const [moved] = current.splice(fromIndex, 1);
    const updated: Todo = moved.status === toStatus ? moved : { ...moved, status: toStatus };

    const columnItems = current.filter((todo) => columnMatchesStatus(toStatus, todo.status));
    const insertAt = beforeId ? columnItems.findIndex((todo) => todo.id === beforeId) : -1;
    const boundedInsertAt = insertAt < 0 ? columnItems.length : insertAt;
    const before = columnItems[boundedInsertAt - 1] ? todoPosition(columnItems[boundedInsertAt - 1], 0) : undefined;
    const after = columnItems[boundedInsertAt] ? todoPosition(columnItems[boundedInsertAt], 0) : undefined;
    const position = positionBetween(before, after);

    const globalTarget = beforeId ? current.findIndex((todo) => todo.id === beforeId) : current.length;
    current.splice(globalTarget < 0 ? current.length : globalTarget, 0, updated);
    setOrder(current);
    setOverColumn(null);

    try {
      await saveEntity("/api/mbox/todos", moved.id, { status: toStatus, props: { ...(moved.props || {}), position: String(position) } });
      onSaved();
    } catch {
      setOrder(orderTodos(project.todos));
    }
  }

  if (!order.length) return <EmptyState text="Todo пока нет" />;

  const marks = order.map((todo) => ({ key: `todo:${todo.id}`, bytes: todo.memory_bytes }));
  const unseen = countUnseen(marks);

  return (
    <>
      {unseen > 0 && (
        <div className="todo-board-tools">
          <span className="muted">{unseen} непрочитанных</span>
          <Button variant="ghost" icon={CheckCheck} onClick={() => { markAllSeen(marks); setSeenVersion((value) => value + 1); }}>
            Прочитать всё
          </Button>
        </div>
      )}

      <div className="todo-kanban" role="group" aria-label="Доска задач по статусам">
        {kanbanColumns.map((status) => {
          const items = order.filter((todo) => columnMatchesStatus(status, todo.status));
          return (
            <div className="todo-kanban-column" key={status}>
              <div className={`todo-kanban-head status-${status}`}>
                <span className="todo-kanban-dot" />
                <span>{todoStatusLabel(status)}</span>
                <b>{items.length}</b>
              </div>
              <div
                className={overColumn === status ? "todo-kanban-drop is-over" : "todo-kanban-drop"}
                onDragOver={(event) => { event.preventDefault(); setOverColumn(status); }}
                onDragLeave={() => setOverColumn((current) => (current === status ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const fromId = event.dataTransfer.getData("text/plain") || dragId;
                  setDragId(null);
                  if (fromId) void moveCard(fromId, status);
                }}
              >
                {items.length ? items.map((todo) => (
                  <div
                    key={todo.id}
                    className={dragId === todo.id ? "todo-drag-slot is-dragging" : "todo-drag-slot"}
                    draggable
                    onDragStart={(event) => {
                      setDragId(todo.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", todo.id);
                    }}
                    onDragEnd={() => { setDragId(null); setOverColumn(null); }}
                    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setOverColumn(status); }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const fromId = event.dataTransfer.getData("text/plain") || dragId;
                      setDragId(null);
                      if (fromId) void moveCard(fromId, status, todo.id);
                    }}
                  >
                    <TodoCard todo={todo} seenVersion={seenVersion} onOpen={() => setOpenTodo(todo)} onSaved={onSaved} />
                  </div>
                )) : <p className="todo-kanban-empty">Нет задач</p>}
              </div>
            </div>
          );
        })}
      </div>

      {openTodo && (
        <TodoModal
          key={openTodo.id}
          todo={openTodo}
          projectName={project.name}
          onClose={() => setOpenTodo(null)}
          onSaved={() => { onSaved(); setOpenTodo(null); }}
        />
      )}
    </>
  );
}

function TodoCard({ todo, seenVersion, onOpen, onSaved }: { todo: Todo; seenVersion: number; onOpen: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(todo.status);
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState(() => seenDelta(`todo:${todo.id}`, todo.memory_bytes));

  useEffect(() => setStatus(todo.status), [todo.status]);
  useEffect(() => setMark(seenDelta(`todo:${todo.id}`, todo.memory_bytes)), [todo.id, todo.memory_bytes, seenVersion]);

  function open() {
    markSeen(`todo:${todo.id}`, todo.memory_bytes);
    setMark({ state: "seen", delta: 0 });
    onOpen();
  }

  async function changeStatus(next: string) {
    setStatus(next);
    setBusy(true);
    try {
      await saveEntity("/api/mbox/todos", todo.id, { status: next });
      onSaved();
    } catch {
      setStatus(todo.status);
    } finally {
      setBusy(false);
    }
  }

  const done = ["done", "archived"].includes(status);

  return (
    <article className={[
      "todo-note-card",
      done ? "is-done" : "",
      status === "doing" ? "is-doing" : "",
      !done && mark.state === "new" ? "is-fresh" : "",
      mark.state === "changed" ? "is-changed" : "",
    ].filter(Boolean).join(" ")}>
      <div className="todo-note-card-head">
        {status === "doing" && <span className="todo-spinner" aria-label="В работе" />}
        <strong title={todo.title}>{todo.title}</strong>
        {mark.state !== "seen" && (
          <span className={`diff-badge ${mark.state === "new" ? "is-new" : mark.delta > 0 ? "is-plus" : "is-minus"}`}
                title={mark.state === "new" ? "Ещё не открывали" : "Изменилось с прошлого просмотра, в байтах"}>
            {mark.state === "new" ? "новое" : formatDelta(mark.delta)}
          </span>
        )}
        <button className="todo-card-expand" type="button" onClick={open} aria-label="Открыть на весь экран" title="Открыть на весь экран">
          <Maximize2 size={15} />
        </button>
      </div>

      {todo.note && <p className="todo-note-card-body">{todo.note}</p>}

      <div className="todo-note-card-meta">
        <span className={`todo-chip status-${status}`}>{todoStatusLabel(status)}</span>
        <span className={`todo-chip priority-${todo.priority}`}>{todoPriorityLabel(todo.priority)}</span>
        {todo.claimed_by && (
          <span className="todo-chip todo-claimed" title={`Взял в работу: ${todo.claimed_by}`}>
            <AgentAvatar name={todo.claimed_by} size={16} />
            {todo.claimed_by}
          </span>
        )}
        <span className="todo-chip muted">{formatBytes(todo.memory_bytes)}</span>
      </div>

      <div className="todo-card-actions">
        <Select
          aria-label="Статус"
          value={status}
          disabled={busy}
          onChange={(event) => changeStatus(event.target.value)}
          options={statusOptions}
        />
        <Button variant="ghost" onClick={open}>Открыть</Button>
      </div>
    </article>
  );
}

function TodoModal({ todo, projectName, onClose, onSaved }: { todo: Todo; projectName: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [status, setStatus] = useState(todo.status);
  const [priority, setPriority] = useState(todo.priority);
  const [state, setState] = useState<SaveState>("idle");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  async function save() {
    setState("saving");
    try {
      await saveEntity("/api/mbox/todos", todo.id, { title, note, status, priority });
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  async function remove() {
    if (!window.confirm(`Удалить todo «${todo.title}»?`)) return;
    try {
      await fetchJson(`/api/mbox/todos/${todo.id}`, { method: "DELETE" });
      onSaved();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="todo-modal-scrim" role="dialog" aria-modal="true" aria-label={todo.title} onClick={onClose}>
      <div className="todo-modal" onClick={(event) => event.stopPropagation()}>
        <header className="todo-modal-head">
          <div className="todo-modal-title">
            <span className="muted">{projectName} · todo #{todo.id}</span>
            <strong>{title || "Без названия"}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>

        <div className="todo-modal-body">
          <TextInput label="Название" value={title} onChange={(event) => setTitle(event.target.value)} />
          <TextArea label="Заметка" value={note} onChange={(event) => setNote(event.target.value)} rows={14} />
          <div className="todo-modal-controls">
            <Select label="Статус" hint={todoStatusHint[status]} value={status} onChange={(event) => setStatus(event.target.value)} options={statusOptions} />
            <Select label="Приоритет" value={priority} onChange={(event) => setPriority(event.target.value)} options={priorityOptions} />
          </div>
          {todo.claimed_by && (
            <p className="muted">В работе у {todo.claimed_by}{todo.claimed_until ? `, лиз до ${todo.claimed_until}` : ""}</p>
          )}
        </div>

        <footer className="todo-modal-foot">
          <Button variant="danger" icon={Trash2} onClick={remove}>Удалить</Button>
          <div className="todo-modal-foot-right">
            <Button variant="ghost" onClick={onClose}>Отмена</Button>
            <SaveButton state={state} onClick={save} />
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Только добавление. Правка живёт в карточке — искать задачу по id человек не должен. */
export function AddTodoForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("normal");
  const [status, setStatus] = useState("open");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setError("Название не может быть пустым"); return; }
    setState("saving");
    setError("");
    try {
      await saveEntity("/api/mbox/todos", "", { project_id: project.id, title: title.trim(), note, status, priority, access_level: "private" });
      setTitle("");
      setNote("");
      setStatus("open");
      setPriority("normal");
      setState("idle");
      setOpen(false);
      onSaved();
    } catch {
      setState("error");
      setError("Не удалось создать");
    }
  }

  return (
    <div className="todo-quick-box">
      <Button className="add-secret-action" icon={Plus} onClick={() => setOpen((value) => !value)} aria-expanded={open}>Добавить задачу</Button>
      {open && (
        <form className="todo-quick" onSubmit={submit}>
          <TextInput label="Название" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Что нужно сделать" autoFocus />
          <TextArea label="Заметка" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Подробности, критерий готовности" rows={2} />
          <div className="todo-quick-controls">
            <Select label="Статус" hint={todoStatusHint[status]} value={status} onChange={(event) => setStatus(event.target.value)} options={statusOptions} />
            <Select label="Приоритет" value={priority} onChange={(event) => setPriority(event.target.value)} options={priorityOptions} />
            <SaveButton state={state} idleLabel="Создать" type="submit" className="todo-quick-submit" />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
        </form>
      )}
    </div>
  );
}
