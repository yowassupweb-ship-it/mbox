import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, GitCompare, History, Link2, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Share2, Trash2, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { serverOrigin } from "../../lib/serverOrigin";
import { formatDateTime, formatSince } from "../../lib/format";
import { askText } from "../../ui/askText";
import { DocShell, DrawerToggle, useDrawer } from "./docLayout";
import { DiffLines, lineDiff } from "./LocalFileDocument";
import { renderDocument } from "./MemoryDocument";
import type { TabsApi } from "./tabs";
import { useRemembered } from "./uiMemory";
import { MarkdownToolbar, markdownShortcut, toggleTask, useImageInsert } from "./MarkdownToolbar";
import { CodeEditor } from "./CodeEditor";
import { DocumentContextMenu, openDocumentMenu, useDocumentFind } from "./DocumentTools";
import { createNoteTab, mergeNoteTabs, noteTabsOf, sameNoteTabs, type NoteTab } from "./noteTabs";

export type NoteColor = "default" | "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "gray";
export type NoteTheme = "light" | "graphite" | "black";
export type Note = { id: string; title: string; content?: string; tabs?: NoteTab[]; snippet?: string; pinned: boolean; color: NoteColor; theme: NoteTheme; project_id: string | null; tags: string[]; author: string; created_at: string; updated_at: string; size_bytes: number };
type NoteVersion = { id: string; title: string; sha: string; size_bytes: number; author: string; source: string; created_at: string };
type NoteVersionFull = NoteVersion & { content: string; tabs: NoteTab[] };

const VERSION_SOURCE_LABEL: Record<string, string> = { mbox: "MBOX", agent: "агент", share: "по ссылке", baseline: "начало" };

/** Текст всей заметки для сравнения. Вкладки разделяем заголовком — иначе правка во второй вкладке
 *  выглядела бы как правка первой, и дифф врал бы про то, что именно поменялось. */
function versionText(tabs: NoteTab[]) {
  if (tabs.length <= 1) return tabs[0]?.content ?? "";
  return tabs.map((tab) => `—— ${tab.title} ——\n${tab.content}`).join("\n\n");
}

const NOTE_COLORS: Array<{ value: NoteColor; label: string }> = [
  { value: "default", label: "Без метки" },
  { value: "red", label: "Красная" },
  { value: "orange", label: "Оранжевая" },
  { value: "yellow", label: "Жёлтая" },
  { value: "green", label: "Зелёная" },
  { value: "cyan", label: "Бирюзовая" },
  { value: "blue", label: "Синяя" },
  { value: "purple", label: "Фиолетовая" },
  { value: "gray", label: "Серая" },
];

const NOTE_THEME_ORDER: NoteTheme[] = ["light", "graphite", "black"];
const NOTE_THEME_LABEL: Record<NoteTheme, string> = { light: "светлая", graphite: "графитовая", black: "чёрная" };

function nextNoteTheme(theme: NoteTheme) {
  return NOTE_THEME_ORDER[(NOTE_THEME_ORDER.indexOf(theme) + 1) % NOTE_THEME_ORDER.length];
}

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
      <div key={note.id} data-note-color={note.color || "default"} className={tabs.active === key ? "wb-note-item is-active" : "wb-note-item"} onClick={() => tabs.open(key)} onDoubleClick={() => tabs.open(key, true)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") tabs.open(key, true); }}>
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
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>(() => noteTabsOf(cached));
  const [rememberedTabId, setActiveTabId] = useRemembered<string | null>(`note:${noteId}:active-tab`, null);
  const activeTab = noteTabs.find((tab) => tab.id === rememberedTabId) ?? noteTabs[0];
  const activeTabId = activeTab?.id ?? "main";
  const content = activeTab?.content ?? "";
  const setContent = useCallback((next: string | ((current: string) => string)) => {
    setNoteTabs((current) => current.map((tab) => tab.id === activeTabId ? { ...tab, content: typeof next === "function" ? next(tab.content) : next } : tab));
  }, [activeTabId]);
  // Режим по умолчанию зависит от содержимого (пустая — сразу правка), выбор человека — запоминается.
  const [autoMode, setAutoMode] = useState<"edit" | "preview">("edit");
  const [savedMode, setMode] = useRemembered<"edit" | "preview" | null>(`note:${noteId}:mode`, null);
  const mode = savedMode ?? autoMode;
  const [state, setState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const savedRef = useRef<NoteTab[]>(noteTabsOf(cached));
  // Версия заметки, от которой идут правки: заметку могут одновременно править по ссылке (/n/…).
  const baseUpdatedRef = useRef(cached?.updated_at ?? "");
  const tabsRef = useRef(noteTabs);
  tabsRef.current = noteTabs;
  const savingRef = useRef(false);
  const [mergeNotice, setMergeNotice] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageError, setImageError] = useState("");
  const [shared, setShared] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [viewing, setViewing] = useState<NoteVersionFull | null>(null);
  const [compare, setCompare] = useState(true);
  const [drawerOpen, setDrawerOpen] = useDrawer(`mbox.doc.note.history:${noteId}`);
  const images = useImageInsert(textareaRef, `notes/${noteId}`, (message) => { setImageError(message); window.setTimeout(() => setImageError(""), 8000); });
  const find = useDocumentFind({ editorRef: textareaRef, previewRef, text: content, enabled: visible });

  useEffect(() => {
    if (cached) { savedRef.current = noteTabsOf(cached); return; }
    let alive = true;
    fetchJson<{ note: Note }>(`/api/mbox/notes/${noteId}`)
      .then(({ note: loaded }) => {
        if (!alive) return;
        const loadedTabs = noteTabsOf(loaded);
        setNote(loaded);
        setNoteTabs(loadedTabs);
        savedRef.current = loadedTabs;
        baseUpdatedRef.current = loaded.updated_at;
        if (loadedTabs.some((tab) => tab.content)) setAutoMode("preview");
      })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Чужая версия (правка по ссылке): без своих правок — взять, со своими — слить построчно. */
  const absorbRemote = useCallback((remote: Note) => {
    const remoteTabs = noteTabsOf(remote);
    const local = tabsRef.current;
    if (sameNoteTabs(local, savedRef.current)) {
      if (!sameNoteTabs(remoteTabs, local)) setNoteTabs(remoteTabs);
    } else {
      const merged = mergeNoteTabs(savedRef.current, local, remoteTabs);
      if (merged.conflict) {
        setMergeNotice("Заметку одновременно поправили по ссылке в том же месте — оставлена ваша версия фрагмента");
        window.setTimeout(() => setMergeNotice(""), 10000);
      }
      if (!sameNoteTabs(merged.tabs, local)) setNoteTabs(merged.tabs);
    }
    savedRef.current = remoteTabs;
    baseUpdatedRef.current = remote.updated_at;
    setNote(remote);
    patchListed(remote);
  }, []);

  // Список версий тянем только когда панель открыта: у закрытой панели он никому не нужен, а заметок много.
  const loadVersions = useCallback(async () => {
    try {
      setVersions((await fetchJson<{ versions: NoteVersion[] }>(`/api/mbox/notes/${noteId}/versions`)).versions);
    } catch { /* история не критична: заметка открывается и без неё */ }
  }, [noteId]);

  // Пересобираем список и после своих сохранений, и после чужих правок по ссылке — обе меняют updated_at.
  useEffect(() => { if (drawerOpen) void loadVersions(); }, [drawerOpen, loadVersions, note?.updated_at]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const currentTabs = tabsRef.current;
        if (sameNoteTabs(currentTabs, savedRef.current)) { setState("saved"); return; }
        setState("saving");
        const response = await fetch(`/api/mbox/notes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabs: currentTabs, base_updated_at: baseUpdatedRef.current }) });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 && data.note) { absorbRemote(data.note); continue; }
        if (!response.ok) throw new Error(data.error || `request_failed:${response.status}`);
        const savedTabs = noteTabsOf(data.note);
        savedRef.current = savedTabs;
        baseUpdatedRef.current = data.note.updated_at;
        setNote(data.note);
        patchListed(data.note);
        setState(sameNoteTabs(tabsRef.current, currentTabs) ? "saved" : "pending");
        return;
      }
      setState("pending");
    } catch {
      setState("error");
    } finally {
      savingRef.current = false;
    }
  }, [noteId, absorbRemote]);

  /** Перечитать заметку с сервера. `force` — по кнопке: берём текст, даже если updated_at совпал. */
  const pullRemote = useCallback(async (force = false) => {
    if (savingRef.current) return;
    try {
      const { note: remote } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${noteId}`);
      if (force || remote.updated_at !== baseUpdatedRef.current) absorbRemote(remote);
    } catch {
      // нет сети — попробуем в следующий раз
    }
  }, [noteId, absorbRemote]);

  // Правки по ссылке появляются здесь сами, пока заметка открыта и видна.
  useEffect(() => {
    if (!visible || !note) return;
    const timer = window.setInterval(() => { if (!document.hidden) void pullRemote(); }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, note?.id, pullRemote]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Правка агента приходит вебсокетом (`entity_changed`, сущность notes) — раньше по ней
   * обновлялся только список слева, а открытая заметка ждала следующего пятисекундного опроса
   * или не обновлялась вовсе. Теперь сигнал доходит и до документа.
   * Заодно перечитываем при возврате к окну и когда вкладку снова делают активной.
   */
  useEffect(() => {
    if (!note) return;
    const onEntity = (event: Event) => {
      const entity = (event as CustomEvent<string>).detail;
      if (!entity || entity === "notes") void pullRemote();
    };
    const onFocus = () => void pullRemote();
    window.addEventListener(ENTITY_CHANGED_EVENT, onEntity);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(ENTITY_CHANGED_EVENT, onEntity);
      window.removeEventListener("focus", onFocus);
    };
  }, [note?.id, pullRemote]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (visible && note) void pullRemote(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Автосохранение: заметки пишутся на ходу, кнопка «Сохранить» только мешала бы.
  useEffect(() => {
    if (!note || sameNoteTabs(noteTabs, savedRef.current)) return;
    setState("pending");
    const timer = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(timer);
  }, [noteTabs, note, save]);

  useEffect(() => { onDirty(tabKey, state === "pending" || state === "saving" || state === "error"); }, [state, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  useEffect(() => {
    if (visible && mode === "edit") (content.split("\n")[0].trim() ? textareaRef.current : titleRef.current)?.focus();
  }, [visible, mode, note?.id, activeTabId]);

  useEffect(() => {
    if (!visible) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
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
    if (noteTabs.some((tab) => tab.content.trim()) && !window.confirm("Удалить заметку?")) return;
    await fetchJson(`/api/mbox/notes/${noteId}`, { method: "DELETE" });
    notesStore.list = notesStore.list.filter((item) => item.id !== noteId);
    notesStore.listeners.forEach((listener) => listener());
    onDirty(tabKey, false);
    tabs.close(tabKey);
  }

  // Как в «Заметках» iPhone: первая строка — крупный заголовок, остальное — текст. Хранится одной строкой.
  const breakAt = content.indexOf("\n");
  const titleText = breakAt < 0 ? content : content.slice(0, breakAt);
  const bodyText = breakAt < 0 ? "" : content.slice(breakAt + 1);
  const setParts = (title: string, body: string) => setContent(body ? `${title}\n${body}` : title);
  const focusAt = (el: HTMLInputElement | HTMLTextAreaElement | null, position: number) => requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(position, position); });

  function onTitleKey(event: React.KeyboardEvent<HTMLInputElement>) {
    const el = event.currentTarget;
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      // Enter в заголовке переносит хвост заголовка в начало текста — как новая строка.
      event.preventDefault();
      const head = titleText.slice(0, el.selectionStart ?? titleText.length);
      const tail = titleText.slice(el.selectionEnd ?? titleText.length);
      setContent(`${head}\n${tail}${bodyText ? `${tail ? "\n" : ""}${bodyText}` : ""}`);
      focusAt(textareaRef.current, 0);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(textareaRef.current, 0);
    }
  }

  function onBodyKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (markdownShortcut(event)) return;
    const el = event.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    if (event.key === "Backspace" && atStart) {
      // Backspace в самом начале текста подтягивает первую строку текста в заголовок.
      event.preventDefault();
      const firstBreak = bodyText.indexOf("\n");
      const firstLine = firstBreak < 0 ? bodyText : bodyText.slice(0, firstBreak);
      setParts(titleText + firstLine, firstBreak < 0 ? "" : bodyText.slice(firstBreak + 1));
      focusAt(titleRef.current, titleText.length);
    } else if (event.key === "ArrowUp" && !bodyText.slice(0, el.selectionStart).includes("\n")) {
      event.preventDefault();
      focusAt(titleRef.current, Math.min(el.selectionStart, titleText.length));
    }
  }

  function onTitlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    // Многострочная вставка в заголовок: первая строка — в заголовок, остальное — в начало текста.
    event.preventDefault();
    const el = event.currentTarget;
    const head = titleText.slice(0, el.selectionStart ?? titleText.length) + text.slice(0, text.indexOf("\n"));
    const rest = text.slice(text.indexOf("\n") + 1) + titleText.slice(el.selectionEnd ?? titleText.length);
    setParts(head, [rest, bodyText].filter(Boolean).join("\n"));
    focusAt(textareaRef.current, rest.length);
  }

  function addTab() {
    const next = createNoteTab(noteTabs.length);
    setNoteTabs((current) => [...current, next]);
    setActiveTabId(next.id);
    setMode("edit");
  }

  async function renameTab(tab: NoteTab) {
    const title = await askText({ title: "Название вкладки", value: tab.title, confirmLabel: "Переименовать" });
    if (!title || title === tab.title) return;
    setNoteTabs((current) => current.map((item) => item.id === tab.id ? { ...item, title: title.slice(0, 120) } : item));
  }

  function removeTab(tab: NoteTab) {
    if (noteTabs.length <= 1) return;
    if (tab.content.trim() && !window.confirm(`Удалить вкладку «${tab.title}» вместе с её содержимым?`)) return;
    const index = noteTabs.findIndex((item) => item.id === tab.id);
    const remaining = noteTabs.filter((item) => item.id !== tab.id);
    setNoteTabs(remaining);
    if (activeTabId === tab.id) setActiveTabId(remaining[Math.min(index, remaining.length - 1)]?.id ?? remaining[0]?.id ?? null);
  }

  function onTabKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "F2") { event.preventDefault(); void renameTab(noteTabs[index]); return; }
    const nextIndex = event.key === "ArrowLeft" ? Math.max(0, index - 1) : event.key === "ArrowRight" ? Math.min(noteTabs.length - 1, index + 1) : event.key === "Home" ? 0 : event.key === "End" ? noteTabs.length - 1 : -1;
    if (nextIndex < 0 || nextIndex === index) return;
    event.preventDefault();
    setActiveTabId(noteTabs[nextIndex].id);
    const buttons = event.currentTarget.closest("[role=tablist]")?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons?.[nextIndex]?.focus();
  }

  // Сравниваем выбранную версию с тем, что в редакторе прямо сейчас, а не с последним сохранением:
  // человек хочет видеть, что он потеряет откатом, включая ещё не сохранённые правки.
  const versionDiff = useMemo(() => {
    if (!viewing || !compare) return null;
    const before = versionText(viewing.tabs?.length ? viewing.tabs : [{ id: "main", title: "Основная", content: viewing.content }]);
    return lineDiff(before, versionText(noteTabs));
  }, [viewing, compare, noteTabs]);

  async function openVersion(version: NoteVersion) {
    try {
      setViewing((await fetchJson<{ version: NoteVersionFull }>(`/api/mbox/notes/${noteId}/versions/${version.id}`)).version);
    } catch { /* версию могли вытеснить из истории, пока список висел открытым */ }
  }

  /** Откат — обычная правка: текст версии кладётся в редактор и сохраняется общим путём, поэтому
   *  сам откат тоже попадает в историю и его, в свою очередь, можно откатить. */
  function restore(version: NoteVersionFull) {
    const restored = version.tabs?.length ? version.tabs : [{ id: "main", title: "Основная", content: version.content }];
    setNoteTabs(restored);
    setViewing(null);
    setMode("edit");
  }

  if (missing) return <div className="wb-doc-missing">Заметка не найдена — возможно, её удалили.</div>;
  if (!note) return <div className="wb-doc-missing">Открываю заметку…</div>;

  const stateLabel = { saved: "сохранено", pending: "…", saving: "сохраняю…", error: "не сохранилось — Ctrl+S ещё раз" }[state];
  const activeTheme = note.theme || "graphite";
  const nextTheme = nextNoteTheme(activeTheme);

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Заметки › {formatDateTime(note.updated_at)}{shared && <span className="wb-shared-note-label">расшарена</span>} <span className={`wb-save-state is-${state}`}>{stateLabel}</span>{imageError && <span className="wb-save-state is-error"> {imageError}</span>}{mergeNotice && <span className="wb-save-state is-pending"> {mergeNotice}</span>}</span>
          {mode === "edit" && <MarkdownToolbar targetRef={textareaRef} onPickImages={(files) => void images.insertImages(files)} uploading={images.uploading} />}
          <div className="wb-doc-actions">
            {/* Заметку правят ещё и агенты, и владелец ссылки. Кнопка — на случай, когда ждать
                автоподхвата не хочется или сеть моргнула. */}
            <button
              type="button"
              onClick={() => void pullRemote(true)}
              title="Перечитать заметку с сервера"
              aria-label="Перечитать заметку с сервера"
            >
              <RefreshCw size={14} />
            </button>
            <select className="wb-bar-select" value={note.project_id ?? ""} onChange={(event) => void update({ project_id: event.target.value || null })} title="Проект">
              <option value="">без проекта</option>
              {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button
              type="button"
              className={`doc-theme-button is-${activeTheme}`}
              onClick={() => void update({ theme: nextTheme })}
              title={`Тема документа: ${NOTE_THEME_LABEL[activeTheme]}`}
              aria-label={`Тема документа: ${NOTE_THEME_LABEL[activeTheme]}. Переключить на ${NOTE_THEME_LABEL[nextTheme]}`}
            >
              <span className="doc-theme-dot" aria-hidden="true" />
            </button>
            <select className="wb-bar-select wb-note-color-select" value={note.color || "default"} onChange={(event) => void update({ color: event.target.value as NoteColor })} title="Цвет карточки" aria-label="Цвет карточки">
              {NOTE_COLORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <div className="wb-segmented">
              <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => { void save(); setMode("preview"); }}><Eye size={13} /></button>
              <button type="button" className={mode === "edit" ? "is-on" : undefined} onClick={() => setMode("edit")}><Pencil size={13} /></button>
            </div>
            <ShareButton noteId={noteId} onSharedChange={setShared} />
            <button type="button" className={note.pinned ? "is-on" : undefined} onClick={() => void update({ pinned: !note.pinned })} title={note.pinned ? "Открепить" : "Закрепить сверху"}>{note.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
            <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} label="История" count={versions.length} />
            <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить заметку"><Trash2 size={14} /></button>
          </div>
        </>
      )}
      drawerOpen={drawerOpen}
      onCloseDrawer={() => { setDrawerOpen(false); setViewing(null); }}
      drawer={(
        <>
          <div className="wb-side-tabs">
            <button type="button" className="is-on"><History size={12} /> Версии · {versions.length}</button>
          </div>
          {versions.length ? (
            <ul className="wb-version-list">
              {versions.map((version) => (
                <li key={version.id}>
                  <button type="button" className={viewing?.id === version.id ? "is-active" : undefined} onClick={() => void openVersion(version)}>
                    <span className={`wb-version-source is-${version.source}`}>{VERSION_SOURCE_LABEL[version.source] ?? version.source}</span>
                    <b>{version.title || "без заголовка"}</b>
                    <span className="wb-tree-hint">{formatSince(version.created_at)} · {version.author || "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="wb-empty">Версий пока нет — первая появится при следующей правке заметки.</p>}
        </>
      )}
    >
      {find.bar}
      <div className={`wb-note-surface doc-theme-${note.theme || "graphite"}`}>
      {viewing ? (
        <div className="wb-version-view">
          <div className="wb-banner">
            Версия от {formatDateTime(viewing.created_at)} · {viewing.author || "—"} · {VERSION_SOURCE_LABEL[viewing.source] ?? viewing.source}
            <button type="button" className={compare ? "is-on" : undefined} onClick={() => setCompare((value) => !value)}>
              <GitCompare size={12} /> {compare ? "Показать версию целиком" : "Показать изменения"}
            </button>
            <button type="button" onClick={() => restore(viewing)}><RotateCcw size={12} /> Откатить к этой версии</button>
            <button type="button" onClick={() => setViewing(null)}><X size={12} /> Закрыть</button>
          </div>
          {compare
            ? (versionDiff ? <DiffLines lines={versionDiff} /> : <p className="wb-empty">Заметка слишком большая для построчного сравнения.</p>)
            : <pre className="wb-version-text">{versionText(viewing.tabs?.length ? viewing.tabs : [{ id: "main", title: "Основная", content: viewing.content }])}</pre>}
        </div>
      ) : mode === "edit" ? (
        <div className="wb-note-edit">
          <input
            ref={titleRef}
            className="wb-note-title"
            value={titleText}
            onChange={(event) => setParts(event.target.value, bodyText)}
            onKeyDown={onTitleKey}
            onPaste={onTitlePaste}
            onBlur={() => void save()}
            placeholder="Заголовок"
            spellCheck
          />
          <CodeEditor
            textareaRef={textareaRef}
            className="wb-note-markdown"
            variant="document"
            language="markdown"
            value={bodyText}
            onChange={(value) => setParts(titleText, value)}
            onBlur={() => void save()}
            onKeyDown={onBodyKey}
            onPaste={images.onPaste}
            onDrop={images.onDrop}
            onContextMenu={(event) => openDocumentMenu(event, setContextMenu)}
            placeholder={"Текст заметки. Панель сверху или Ctrl+B, Ctrl+Shift+9 (чекбоксы)… Картинку можно вставить из буфера. Сохраняется само."}
            spellCheck
          />
        </div>
      ) : (
        <article ref={previewRef} className="wb-reading" onDoubleClick={() => setMode("edit")} onContextMenu={(event) => openDocumentMenu(event, setContextMenu)}>
          {content.trim() ? (
            <div className="wb-memory-body">
              {titleText.trim() && <h1 className="wb-note-title-view">{titleText.replace(/^#{1,6}\s+/, "")}</h1>}
              {renderDocument(bodyText, { onToggleTask: (line) => setContent((current) => toggleTask(current, line + 1)) })}
            </div>
          ) : <p className="wb-empty">Пустая заметка. Двойной клик — начать писать.</p>}
        </article>
      )}
        <div className="wb-note-tabs" role="tablist" aria-label="Вкладки заметки">
          {noteTabs.map((tab, index) => (
            <div key={tab.id} className={tab.id === activeTabId ? "wb-note-tab is-active" : "wb-note-tab"}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => void renameTab(tab)}
                onKeyDown={(event) => onTabKey(event, index)}
                title={`${tab.title}. Двойной клик или F2 — переименовать`}
              >
                {tab.title}
              </button>
              {noteTabs.length > 1 && <button type="button" className="wb-note-tab-close is-danger" onClick={() => removeTab(tab)} title={`Удалить вкладку «${tab.title}»`} aria-label={`Удалить вкладку «${tab.title}»`}><X size={11} /></button>}
            </div>
          ))}
          <button type="button" className="wb-note-tab-add" onClick={addTab} title="Добавить вкладку" aria-label="Добавить вкладку"><Plus size={13} /></button>
        </div>
      </div>
      <DocumentContextMenu point={contextMenu} onClose={() => setContextMenu(null)} editorRef={textareaRef} previewRef={previewRef} onFind={find.openFind} />
    </DocShell>
  );
}

type NoteShare = { token: string; mode: "view" | "edit"; created_at: string; last_used_at?: string | null };

/**
 * «Поделиться»: ссылка на просмотр и ссылка на правку. Открываются в любом браузере без входа в MBOX
 * (/n/<токен>), отзываются одной кнопкой. Перевыпуск — новый токен, старая ссылка перестаёт работать.
 */
function ShareButton({ noteId, onSharedChange }: { noteId: string; onSharedChange?: (shared: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<NoteShare[]>([]);
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const next = (await fetchJson<{ shares: NoteShare[] }>(`/api/mbox/notes/${noteId}/shares`)).shares;
    setShares(next);
    onSharedChange?.(next.length > 0);
  }, [noteId, onSharedChange]);

  useEffect(() => {
    void load().catch(() => {
      setShares([]);
      onSharedChange?.(false);
    });
  }, [load, onSharedChange]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const linkOf = (share: NoteShare) => `${serverOrigin()}/n/${share.token}`;

  async function create(mode: "view" | "edit", regenerate = false) {
    setBusy(mode);
    try {
      const { share } = await fetchJson<{ share: NoteShare }>(`/api/mbox/notes/${noteId}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, regenerate }) });
      await load();
      await copy(share);
    } finally {
      setBusy("");
    }
  }

  async function revoke(mode: "view" | "edit") {
    if (!window.confirm(mode === "edit" ? "Отозвать ссылку на правку? Она перестанет открываться." : "Отозвать ссылку на просмотр? Она перестанет открываться.")) return;
    setBusy(mode);
    try {
      await fetchJson(`/api/mbox/notes/${noteId}/shares/${mode}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy("");
    }
  }

  async function copy(share: NoteShare) {
    try { await navigator.clipboard.writeText(linkOf(share)); } catch { /* буфер недоступен — ссылка видна в поле */ }
    setCopied(share.mode);
    window.setTimeout(() => setCopied(""), 1600);
  }

  const rows: Array<{ mode: "view" | "edit"; label: string; hint: string }> = [
    { mode: "view", label: "Просмотр", hint: "Читать без входа в MBOX" },
    { mode: "edit", label: "Редактирование", hint: "Править текст и вставлять картинки" },
  ];

  return (
    <div className="wb-share" ref={boxRef}>
      <button type="button" className={shares.length ? "is-on" : undefined} onClick={() => setOpen(!open)} title="Поделиться ссылкой" aria-expanded={open}>
        <Share2 size={14} />
      </button>
      {open && (
        <div className="wb-share-panel" role="dialog" aria-label="Ссылки на заметку">
          {rows.map((row) => {
            const share = shares.find((item) => item.mode === row.mode);
            return (
              <div key={row.mode} className="wb-share-row">
                <div className="wb-share-head">
                  <b>{row.label}</b>
                  <span>{row.hint}</span>
                </div>
                {share ? (
                  <>
                    <div className="wb-share-link">
                      <input readOnly value={linkOf(share)} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${row.label}`} />
                      <button type="button" onClick={() => void copy(share)} title="Скопировать">{copied === row.mode ? <Check size={13} /> : <Copy size={13} />}</button>
                    </div>
                    <div className="wb-share-actions">
                      <span>{share.last_used_at ? `открывали ${formatSince(share.last_used_at)}` : "ещё не открывали"}</span>
                      <button type="button" disabled={busy === row.mode} onClick={() => void create(row.mode, true)} title="Новая ссылка, старая перестанет работать"><RefreshCw size={12} /> Перевыпустить</button>
                      <button type="button" className="is-danger" disabled={busy === row.mode} onClick={() => void revoke(row.mode)}><X size={12} /> Отозвать</button>
                    </div>
                  </>
                ) : (
                  <button type="button" className="wb-share-create" disabled={busy === row.mode} onClick={() => void create(row.mode)}><Link2 size={13} /> Создать ссылку</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
