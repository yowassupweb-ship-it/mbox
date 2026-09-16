import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { formatDateTime, formatSince } from "../../lib/format";
import { DocShell } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import type { TabsApi } from "./tabs";
import { useRemembered } from "./uiMemory";

export type Note = { id: string; title: string; content?: string; snippet?: string; pinned: boolean; project_id: string | null; tags: string[]; author: string; created_at: string; updated_at: string; size_bytes: number };

/** Список заметок общий для боковой панели и заголовков вкладок; вкладка заметки сообщает о правках. */
const notesStore = {
  list: [] as Note[],
  query: "",
  listeners: new Set<() => void>(),
};

async function refreshNotes() {
  try {
    const q = notesStore.query.trim();
    notesStore.list = (await fetchJson<{ notes: Note[] }>(`/api/mbox/notes${q ? `?q=${encodeURIComponent(q)}` : ""}`)).notes;
  } catch {
    // сеть моргнула — оставляем прежний список
  }
  notesStore.listeners.forEach((listener) => listener());
}

function patchListed(note: Note) {
  const index = notesStore.list.findIndex((item) => item.id === note.id);
  const listed = { ...note, snippet: (note.content ?? "").slice(0, 400) };
  if (index >= 0) notesStore.list[index] = { ...notesStore.list[index], ...listed };
  notesStore.list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  notesStore.listeners.forEach((listener) => listener());
}

export function noteTitle(key: string) {
  const note = notesStore.list.find((item) => `note:${item.id}` === key);
  return note ? note.title || "Без заголовка" : "";
}

export async function createNoteAndOpen(tabs: TabsApi, projectId: string | null = null) {
  const { note } = await fetchJson<{ note: Note }>("/api/mbox/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", project_id: projectId }),
  });
  notesStore.list.unshift({ ...note, snippet: "" });
  notesStore.listeners.forEach((listener) => listener());
  tabs.open(`note:${note.id}`, true);
}

function snippetOf(note: Note) {
  const lines = (note.snippet ?? note.content ?? "").split("\n").map((line) => line.replace(/^#+\s*|^[-*]\s+/, "").replace(/\*\*|`/g, "").trim()).filter(Boolean);
  return lines.slice(1).join(" · ").slice(0, 140);
}

export function NotesView({ tabs }: { tabs: TabsApi }) {
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(notesStore.query);

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    notesStore.listeners.add(rerender);
    return () => { notesStore.listeners.delete(rerender); };
  }, []);

  useEffect(() => {
    notesStore.query = query;
    const timer = window.setTimeout(() => void refreshNotes(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function togglePin(note: Note) {
    const { note: updated } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${note.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: !note.pinned }) });
    patchListed(updated);
  }

  const pinned = notesStore.list.filter((note) => note.pinned);
  const rest = notesStore.list.filter((note) => !note.pinned);

  function renderItem(note: Note) {
    const key = `note:${note.id}`;
    return (
      <div key={note.id} className={tabs.active === key ? "wb-note-item is-active" : "wb-note-item"} onClick={() => tabs.open(key)} onDoubleClick={() => tabs.open(key, true)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") tabs.open(key, true); }}>
        <div className="wb-note-item-title">{note.title || "Пустая заметка"}</div>
        {snippetOf(note) && <div className="wb-note-item-snippet">{snippetOf(note)}</div>}
        <div className="wb-note-item-meta">{formatSince(note.updated_at)}</div>
        <button type="button" className={note.pinned ? "wb-note-pin is-on" : "wb-note-pin"} onClick={(event) => { event.stopPropagation(); void togglePin(note); }} title={note.pinned ? "Открепить" : "Закрепить сверху"}>
          {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Заметки</span>
        <div className="wb-view-actions">
          <button type="button" onClick={() => void createNoteAndOpen(tabs)} title="Новая заметка (Ctrl+Alt+N)"><Plus size={14} /></button>
        </div>
      </header>
      <div className="wb-filter">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в заметках" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <div className="wb-view-body">
        {pinned.length > 0 && <div className="wb-menu-group-head is-static">Закреплённые</div>}
        {pinned.map(renderItem)}
        {pinned.length > 0 && rest.length > 0 && <div className="wb-menu-group-head is-static">Остальные</div>}
        {rest.map(renderItem)}
        {!notesStore.list.length && (
          <div className="wb-session-empty">
            <p>{query ? "Ничего не нашлось." : "Заметок пока нет."}</p>
            {!query && <button type="button" onClick={() => void createNoteAndOpen(tabs)}><Plus size={13} /> Новая заметка</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function NoteDocument({ noteId, data, tabs, tabKey, visible, onDirty }: {
  noteId: string;
  data: MboxData;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  // Только что созданная заметка уже лежит в списке целиком — редактор открывается без второго запроса.
  const cached = notesStore.list.find((item) => item.id === noteId && typeof item.content === "string");
  const [note, setNote] = useState<Note | null>(cached ?? null);
  const [missing, setMissing] = useState(false);
  const [content, setContent] = useState(cached?.content ?? "");
  // Режим по умолчанию зависит от содержимого (пустая — сразу правка), выбор человека — запоминается.
  const [autoMode, setAutoMode] = useState<"edit" | "preview">("edit");
  const [savedMode, setMode] = useRemembered<"edit" | "preview" | null>(`note:${noteId}:mode`, null);
  const mode = savedMode ?? autoMode;
  const [state, setState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const savedRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (cached) { savedRef.current = cached.content ?? ""; return; }
    let alive = true;
    fetchJson<{ note: Note }>(`/api/mbox/notes/${noteId}`)
      .then(({ note: loaded }) => {
        if (!alive) return;
        setNote(loaded);
        setContent(loaded.content ?? "");
        savedRef.current = loaded.content ?? "";
        if (loaded.content) setAutoMode("preview");
      })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (text: string) => {
    if (text === savedRef.current) { setState("saved"); return; }
    setState("saving");
    try {
      const { note: updated } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) });
      savedRef.current = text;
      setNote(updated);
      patchListed(updated);
      setState((current) => (current === "saving" ? "saved" : current));
    } catch {
      setState("error");
    }
  }, [noteId]);

  // Автосохранение: заметки пишутся на ходу, кнопка «Сохранить» только мешала бы.
  useEffect(() => {
    if (!note || content === savedRef.current) return;
    setState("pending");
    const timer = window.setTimeout(() => void save(content), 700);
    return () => window.clearTimeout(timer);
  }, [content, note, save]);

  useEffect(() => { onDirty(tabKey, state === "pending" || state === "saving" || state === "error"); }, [state, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  useEffect(() => {
    if (visible && mode === "edit") textareaRef.current?.focus();
  }, [visible, mode, note?.id]);

  useEffect(() => {
    if (!visible) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(content); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function update(patch: Partial<Note>) {
    const { note: updated } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    setNote(updated);
    patchListed(updated);
  }

  async function remove() {
    if (content.trim() && !window.confirm("Удалить заметку?")) return;
    await fetchJson(`/api/mbox/notes/${noteId}`, { method: "DELETE" });
    notesStore.list = notesStore.list.filter((item) => item.id !== noteId);
    notesStore.listeners.forEach((listener) => listener());
    onDirty(tabKey, false);
    tabs.close(tabKey);
  }

  if (missing) return <div className="wb-doc-missing">Заметка не найдена — возможно, её удалили.</div>;
  if (!note) return <div className="wb-doc-missing">Открываю заметку…</div>;

  const stateLabel = { saved: "сохранено", pending: "…", saving: "сохраняю…", error: "не сохранилось — Ctrl+S ещё раз" }[state];

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Заметки › {formatDateTime(note.updated_at)} <span className={`wb-save-state is-${state}`}>{stateLabel}</span></span>
          <div className="wb-doc-actions">
            <select className="wb-bar-select" value={note.project_id ?? ""} onChange={(event) => void update({ project_id: event.target.value || null })} title="Проект">
              <option value="">без проекта</option>
              {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <div className="wb-segmented">
              <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => { void save(content); setMode("preview"); }}><Eye size={13} /></button>
              <button type="button" className={mode === "edit" ? "is-on" : undefined} onClick={() => setMode("edit")}><Pencil size={13} /></button>
            </div>
            <button type="button" className={note.pinned ? "is-on" : undefined} onClick={() => void update({ pinned: !note.pinned })} title={note.pinned ? "Открепить" : "Закрепить сверху"}>{note.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
            <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить заметку"><Trash2 size={14} /></button>
          </div>
        </>
      )}
    >
      {mode === "edit" ? (
        <textarea
          ref={textareaRef}
          className="wb-note-editor"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onBlur={() => void save(content)}
          placeholder={"Первая строка станет заголовком.\n\nПиши как в блокноте: # заголовки, - списки, `код`, **жирный** — сохраняется само."}
          spellCheck
        />
      ) : (
        <article className="wb-reading" onDoubleClick={() => setMode("edit")}>
          {content.trim() ? <div className="wb-memory-body">{renderDocument(content)}</div> : <p className="wb-empty">Пустая заметка. Двойной клик — начать писать.</p>}
        </article>
      )}
    </DocShell>
  );
}
