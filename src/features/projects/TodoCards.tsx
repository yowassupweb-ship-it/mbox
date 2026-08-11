import { useEffect, useState } from "react";
import { CheckCheck, ChevronDown, Maximize2, Trash2, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { countUnseen, formatDelta, markAllSeen, markSeen, seenDelta } from "../../lib/seen";
import { todoPriorityLabel, todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "../../lib/labels";
import { orderTodos, positionBetween, todoPosition } from "../../lib/tree";
import type { Project, Todo } from "../../types";
import { Button, EmptyState, ManualForm, SaveButton, Select, TextArea, TextInput, type SaveState } from "../../ui";

const statusOptions = Object.entries(todoStatusLabels).map(([value, label]) => ({ value, label }));
const priorityOptions = Object.entries(todoPriorityLabels).map(([value, label]) => ({ value, label }));

export function TodoCardGrid({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [openTodo, setOpenTodo] = useState<Todo | null>(null);
  const [order, setOrder] = useState<Todo[]>(() => orderTodos(project.todos));
  const [dragId, setDragId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [seenVersion, setSeenVersion] = useState(0);

  useEffect(() => setOrder(orderTodos(project.todos)), [project.todos]);

  async function moveCard(fromId: string, toId: string) {
    if (fromId === toId) return;
    const current = [...order];
    const from = current.findIndex((todo) => todo.id === fromId);
    const to = current.findIndex((todo) => todo.id === toId);
    if (from < 0 || to < 0) return;

    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    setOrder(current);

    const before = current[to - 1] ? todoPosition(current[to - 1], to - 1) : undefined;
    const after = current[to + 1] ? todoPosition(current[to + 1], to + 1) : undefined;
    const position = positionBetween(before, after);

    // props при PATCH заменяются целиком — шлём слитый объект, иначе остальные факты о задаче потеряются.
    await saveEntity("/api/mbox/todos", moved.id, { props: { ...(moved.props || {}), position: String(position) } });
    onSaved();
  }

  if (!order.length) return <EmptyState text="Todo пока нет" />;

  // Многоколоночная кладка заполняет колонки сверху вниз, поэтому «выполненные в конце списка»
  // визуально уезжают вправо, а не вниз. Разносим на два отдельных блока.
  const active = order.filter((todo) => !["done", "archived"].includes(todo.status));
  const finished = order.filter((todo) => ["done", "archived"].includes(todo.status));

  const slot = (todo: Todo) => (
    <div
      key={todo.id}
      className={dragId === todo.id ? "todo-drag-slot is-dragging" : "todo-drag-slot"}
      draggable
      onDragStart={(event) => {
        setDragId(todo.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", todo.id);
      }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const fromId = event.dataTransfer.getData("text/plain") || dragId;
        setDragId(null);
        if (fromId) void moveCard(fromId, todo.id);
      }}
    >
      <TodoCard todo={todo} seenVersion={seenVersion} onOpen={() => setOpenTodo(todo)} onSaved={onSaved} />
    </div>
  );

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

      {active.length ? <div className="todo-note-grid">{active.map(slot)}</div> : <EmptyState text="Активных задач нет" />}

      {finished.length > 0 && (
        <section className="todo-done-block">
          <button className="todo-done-head" type="button" onClick={() => setShowDone((value) => !value)} aria-expanded={showDone}>
            <ChevronDown size={16} className={showDone ? "is-open" : ""} />
            <span>Выполнено</span>
            <b>{finished.length}</b>
          </button>
          {showDone && <div className="todo-note-grid">{finished.map(slot)}</div>}
        </section>
      )}

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
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("normal");
  const [status, setStatus] = useState("open");

  return (
    <ManualForm title="Добавить задачу" submitLabel="Создать" onSubmit={async () => {
      if (!title.trim()) throw new Error("empty_title");
      await saveEntity("/api/mbox/todos", "", { project_id: project.id, title: title.trim(), note, status, priority, access_level: "private" });
      setTitle("");
      setNote("");
      onSaved();
    }}>
      <TextInput label="Название" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Что нужно сделать" />
      <TextArea label="Заметка" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Подробности, ссылки, критерий готовности" rows={4} />
      <div className="todo-modal-controls">
        <Select label="Статус" hint={todoStatusHint[status]} value={status} onChange={(event) => setStatus(event.target.value)} options={statusOptions} />
        <Select label="Приоритет" value={priority} onChange={(event) => setPriority(event.target.value)} options={priorityOptions} />
      </div>
    </ManualForm>
  );
}
