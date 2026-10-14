import { Bold, Check, ExternalLink, Eye, FileUp, ImagePlus, Italic, List, ListChecks, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Strikethrough, StickyNote as StickyIcon, Trash2, Underline, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../lib/api";
import { askConfirm } from "../ui/askText";
import { storageFileUrl, uploadToStorage } from "../lib/storageUpload";
import { htmlToMarkdown, markdownToHtml } from "./sticky/stickyMarkdown";
import { renderDocument } from "../app/workbench/MemoryDocument";
import "../styles/sticky.css";

/**
 * Окна заметок на рабочем столе (mbox-desktop/sticky-notes.js): ?sticky=<id> — одна заметка, ?sticky=list — список.
 * Та же заметка MBOX, что и во вкладке: правка сохраняется на сервер, изменения из других мест подтягиваются.
 */

type StickyBridge = {
  open: (noteId: string, point?: { x: number; y: number }) => Promise<unknown>;
  list: () => Promise<unknown>;
  close: (noteId?: string) => Promise<unknown>;
  forget: (noteId: string) => Promise<unknown>;
  setOnTop: (value?: boolean) => Promise<boolean>;
  state: () => Promise<{ id: string; onTop: boolean; open: string[] }>;
  focusMain: () => Promise<unknown>;
};
type Note = { id: string; title: string; content?: string; snippet?: string; color: string; updated_at: string; pinned?: boolean };

const bridge = () => (window as unknown as { mboxDesktop?: { sticky?: StickyBridge } }).mboxDesktop?.sticky;

export const STICKY_COLORS: Array<{ id: string; label: string; tone: string }> = [
  { id: "default", label: "Жёлтая", tone: "#e8b60c" },
  { id: "green", label: "Зелёная", tone: "#4cae5b" },
  { id: "cyan", label: "Бирюзовая", tone: "#2db3c6" },
  { id: "blue", label: "Синяя", tone: "#3f8cf3" },
  { id: "purple", label: "Фиолетовая", tone: "#9d6cf0" },
  { id: "red", label: "Розовая", tone: "#e5577d" },
  { id: "orange", label: "Оранжевая", tone: "#f08a3c" },
  { id: "gray", label: "Серая", tone: "#8e8e93" },
];
const toneOf = (color: string) => STICKY_COLORS.find((item) => item.id === color)?.tone ?? (color === "yellow" ? "#e8b60c" : STICKY_COLORS[0].tone);

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function createNote(color = "default") {
  const { note } = await fetchJson<{ note: Note }>("/api/mbox/notes", json("POST", { title: "", content: "", color: color === "yellow" ? "default" : color }));
  return note;
}

export function StickyApp({ target }: { target: string }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem("mbox.theme") || "graphite";
    document.documentElement.classList.add("is-sticky");
    const check = () => fetchJson<{ user: unknown }>("/api/mbox/auth/me").then((me) => setSignedIn(Boolean(me.user))).catch(() => setSignedIn(false));
    void check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  if (signedIn === null) return <div className="st-shell" />;
  if (!signedIn) {
    return (
      <div className="st-shell" style={{ ["--st-tone" as string]: STICKY_COLORS[0].tone }}>
        <header className="st-head"><span className="st-head-fill" /><button type="button" className="st-btn" onClick={() => void bridge()?.close()} aria-label="Закрыть"><X size={16} /></button></header>
        <div className="st-empty"><StickyIcon size={28} /><b>Войдите в MBOX</b><span>Заметки на рабочем столе работают после входа в основном окне.</span><button type="button" className="st-link" onClick={() => void bridge()?.focusMain()}>Открыть MBOX</button></div>
      </div>
    );
  }
  return target === "list" ? <StickyList /> : <StickyNote id={target} />;
}

function StickyNote({ id }: { id: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef("");
  const baseRef = useRef("");
  const timerRef = useRef(0);
  const dirtyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  // Просмотр — заметка отрисована полноценным Markdown (заголовки, таблицы, ссылки); правка — редактор «как есть».
  const modeKey = `mbox.sticky.mode.${id}`;
  const [mode, setModeState] = useState<"edit" | "preview" | null>(() => { try { const saved = localStorage.getItem(modeKey); return saved === "edit" || saved === "preview" ? saved : null; } catch { return null; } });
  const [text, setText] = useState("");
  const textRef = useRef("");
  const setMode = (next: "edit" | "preview") => { setModeState(next); try { localStorage.setItem(modeKey, next); } catch { /* не запомнится */ } };

  const render = useCallback((markdown: string) => {
    savedRef.current = markdown;
    textRef.current = markdown;
    setText(markdown);
    // Режим не выбран — по содержимому: заголовки, таблицы, цитаты читаются лучше в просмотре.
    setModeState((current) => current ?? (/^(#{1,6} |\||> )/m.test(markdown) ? "preview" : "edit"));
    const editor = editorRef.current;
    if (editor) editor.innerHTML = markdownToHtml(markdown);
  }, []);

  // Перешли в правку — наполняем редактор текущим текстом и ставим курсор в конец.
  useEffect(() => {
    if (mode !== "edit") return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = markdownToHtml(textRef.current);
  }, [mode]);

  const load = useCallback(async (initial = false) => {
    try {
      const { note: fresh } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${id}`);
      setNote(fresh);
      document.title = fresh.title || "Заметка";
      // Свежая версия с сервера заменяет текст, только если здесь нет несохранённых правок.
      if (initial || (!dirtyRef.current && fresh.updated_at !== baseRef.current)) {
        baseRef.current = fresh.updated_at;
        render(fresh.content || "");
      }
    } catch (error) {
      if (error instanceof Error && /:(403|404)$/.test(error.message)) setMissing(true);
    }
  }, [id, render]);

  useEffect(() => {
    void load(true);
    void bridge()?.state().then((state) => setOnTop(state.onTop));
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    // Пока окно не в фокусе — раз в 10 секунд подтягиваем правки из MBOX и с других устройств.
    const poll = window.setInterval(() => { if (!document.hasFocus()) void load(); }, 10000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(poll); };
  }, [load]);

  const save = useCallback(async (override?: string) => {
    const editor = editorRef.current;
    if (override === undefined && !editor) return;
    const markdown = override ?? htmlToMarkdown(editor!);
    textRef.current = markdown;
    setText(markdown);
    if (markdown === savedRef.current) { dirtyRef.current = false; setStatus("saved"); return; }
    setStatus("saving");
    const send = (base: string) => fetchJson<{ note: Note }>(`/api/mbox/notes/${id}`, json("PATCH", { content: markdown, ...(base ? { base_updated_at: base } : {}) }));
    try {
      let result: { note: Note };
      try {
        result = await send(baseRef.current);
      } catch (error) {
        // Заметку успели поправить в другом месте: записка — то, что человек видит и печатает сейчас, она побеждает.
        if (!(error instanceof Error && /:409$/.test(error.message))) throw error;
        result = await send("");
      }
      savedRef.current = markdown;
      baseRef.current = result.note.updated_at;
      setNote(result.note);
      document.title = result.note.title || "Заметка";
      dirtyRef.current = editor ? htmlToMarkdown(editor) !== markdown : false;
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [id]);

  const schedule = useCallback(() => {
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), 600);
  }, [save]);

  useEffect(() => {
    const flush = () => { if (dirtyRef.current) void save(); };
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("blur", flush); window.removeEventListener("beforeunload", flush); };
  }, [save]);

  function command(name: "bold" | "italic" | "underline" | "strikeThrough" | "insertUnorderedList") {
    editorRef.current?.focus();
    document.execCommand(name);
    schedule();
  }

  /** Строка под курсором становится пунктом с галочкой (или обратно обычной строкой). */
  function toggleTask() {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection?.anchorNode) return;
    let block = selection.anchorNode instanceof HTMLElement ? selection.anchorNode : selection.anchorNode.parentElement;
    while (block && block.parentElement !== editor) block = block.parentElement;
    if (!block) {
      document.execCommand("insertHTML", false, '<div class="st-task" data-done="0"><br></div>');
    } else if (block.tagName === "DIV") {
      if (block.classList.contains("st-task")) { block.classList.remove("st-task"); delete block.dataset.done; }
      else { block.classList.add("st-task"); block.dataset.done = "0"; }
    }
    schedule();
  }

  async function insertImages(files: File[]) {
    for (const file of files.filter((item) => item.type.startsWith("image/"))) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `картинка-${stamp}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
      const key = `notes/${id}/${stamp}-${name}`;
      try {
        await uploadToStorage(key, file);
        editorRef.current?.focus();
        document.execCommand("insertHTML", false, `<img src="${storageFileUrl(key)}" alt="${name.replace(/\.[a-z]+$/, "")}">`);
        schedule();
      } catch {
        setStatus("error");
      }
    }
  }

  async function switchMode(next: "edit" | "preview") {
    if (next === mode) return;
    if (next === "preview" && editorRef.current) { window.clearTimeout(timerRef.current); await save(); }
    setMode(next);
  }

  /** Галочка в просмотре: меняем «- [ ]» ↔ «- [x]» в строке и сохраняем. */
  function toggleTaskLine(lineIndex: number) {
    const lines = textRef.current.split("\n");
    const line = lines[lineIndex];
    if (line === undefined) return;
    lines[lineIndex] = /\[[xX]\]/.test(line) ? line.replace(/\[[xX]\]/, "[ ]") : line.replace(/\[ \]/, "[x]");
    void save(lines.join("\n"));
  }

  /** Импорт из файла: Markdown/текст — как есть, Word — через mammoth в Markdown. Непустую заметку дописываем или заменяем. */
  async function importFile(file: File | undefined) {
    if (!file) return;
    let markdown = "";
    try {
      if (/\.docx$/i.test(file.name)) {
        const mammoth = await import("mammoth");
        const converted = await (mammoth as unknown as { convertToMarkdown: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }).convertToMarkdown({ arrayBuffer: await file.arrayBuffer() });
        // mammoth экранирует знаки Markdown обратной косой чертой — в заметке они не нужны.
        markdown = converted.value.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1").replace(/__([^_]+)__/g, "**$1**").trim();
      } else {
        markdown = (await file.text()).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
      }
    } catch {
      setStatus("error");
      return;
    }
    if (!markdown) return;
    const current = textRef.current.trim();
    let next = markdown;
    if (current) {
      const replace = await askConfirm({ title: `Импорт «${file.name}»`, message: "Заменить текст заметки содержимым файла? «Отмена» — дописать в конец.", confirmLabel: "Заменить" });
      next = replace ? markdown : `${current}\n\n${markdown}`;
    }
    window.clearTimeout(timerRef.current);
    await save(next);
    const editor = editorRef.current;
    if (editor) editor.innerHTML = markdownToHtml(next);
  }

  async function newNote() {
    const created = await createNote(note?.color);
    await bridge()?.open(created.id);
  }

  async function setColor(color: string) {
    setMenu(false);
    const { note: updated } = await fetchJson<{ note: Note }>(`/api/mbox/notes/${id}`, json("PATCH", { color }));
    baseRef.current = updated.updated_at;
    setNote(updated);
  }

  async function remove() {
    setMenu(false);
    if (!(await askConfirm({ title: "Удалить заметку?", message: "Она исчезнет и из MBOX.", confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/notes/${id}`, { method: "DELETE" });
    await bridge()?.forget(id);
  }

  async function openInMbox() {
    setMenu(false);
    await fetchJson("/api/mbox/ui/open", json("POST", { target: `note:${id}` })).catch(() => undefined);
    await bridge()?.focusMain();
  }

  const tone = toneOf(note?.color || "default");

  if (missing) {
    return (
      <div className="st-shell" style={{ ["--st-tone" as string]: tone }}>
        <header className="st-head"><span className="st-head-fill" /><button type="button" className="st-btn" onClick={() => void bridge()?.forget(id)} aria-label="Закрыть"><X size={16} /></button></header>
        <div className="st-empty"><StickyIcon size={28} /><b>Заметки больше нет</b><span>Её удалили или закрыли к ней доступ.</span><button type="button" className="st-link" onClick={() => void bridge()?.forget(id)}>Закрыть окно</button></div>
      </div>
    );
  }

  return (
    <div className="st-shell" style={{ ["--st-tone" as string]: tone }} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyN") { event.preventDefault(); void newNote(); }
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyW") { event.preventDefault(); void bridge()?.close(); }
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyE") { event.preventDefault(); void switchMode(mode === "edit" ? "preview" : "edit"); }
    }}>
      <header className="st-head">
        <button type="button" className="st-btn" onClick={() => void newNote()} title="Новая заметка (Ctrl+N)" aria-label="Новая заметка"><Plus size={15} /></button>
        <div className="st-seg" role="radiogroup" aria-label="Режим">
          <button type="button" role="radio" aria-checked={mode === "edit"} className={mode === "edit" ? "is-on" : undefined} onClick={() => void switchMode("edit")} title="Правка (Ctrl+E)" aria-label="Правка"><Pencil size={12} /></button>
          <button type="button" role="radio" aria-checked={mode === "preview"} className={mode === "preview" ? "is-on" : undefined} onClick={() => void switchMode("preview")} title="Просмотр (Ctrl+E)" aria-label="Просмотр"><Eye size={13} /></button>
        </div>
        <span className="st-head-fill">{status === "saving" ? <i className="st-sync" title="Сохраняю" /> : status === "error" ? <i className="st-sync is-error" title="Не сохранилось — проверьте связь с MBOX" /> : null}</span>
        {onTop && <span className="st-pin" title="Поверх всех окон"><Pin size={12} /></span>}
        <button type="button" className="st-btn" onClick={() => setMenu(!menu)} title="Меню" aria-label="Меню" aria-expanded={menu}><MoreHorizontal size={15} /></button>
        <button type="button" className="st-btn" onClick={() => { if (dirtyRef.current) void save(); void bridge()?.close(); }} title="Закрыть (Ctrl+W)" aria-label="Закрыть"><X size={14} /></button>
      </header>
      <input ref={importRef} type="file" accept=".md,.markdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
      {menu && (
        <>
          <div className="st-menu-scrim" onMouseDown={() => setMenu(false)} />
          <div className="st-menu" role="menu">
            <div className="st-colors" role="group" aria-label="Цвет заметки">
              {STICKY_COLORS.map((item) => (
                <button key={item.id} type="button" className={(note?.color || "default") === item.id ? "is-on" : undefined} style={{ ["--st-tone" as string]: item.tone }} onClick={() => void setColor(item.id)} title={item.label} aria-label={item.label}>
                  {(note?.color || "default") === item.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); void bridge()?.setOnTop(!onTop).then(setOnTop); }}>{onTop ? <PinOff size={15} /> : <Pin size={15} />}{onTop ? "Не поверх окон" : "Поверх всех окон"}</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); importRef.current?.click(); }}><FileUp size={15} />Импорт из файла (.md, .docx)</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); void bridge()?.list(); }}><List size={15} />Список заметок</button>
            <button type="button" role="menuitem" onClick={() => void openInMbox()}><ExternalLink size={15} />Открыть в MBOX</button>
            <button type="button" role="menuitem" className="is-danger" onClick={() => void remove()}><Trash2 size={15} />Удалить заметку</button>
          </div>
        </>
      )}
      {mode === "preview" ? (
        <div key="preview" className="st-preview wb-memory-body md-text" onDoubleClick={() => void switchMode("edit")} title="Двойной щелчок — править">
          {text.trim() ? renderDocument(text, { onToggleTask: toggleTaskLine }) : <p className="st-preview-empty">Пустая заметка — двойной щелчок, чтобы писать</p>}
        </div>
      ) : (
      <div
        key="editor"
        ref={editorRef}
        className="st-editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
        aria-label="Текст заметки"
        data-placeholder="Заметка…"
        onInput={schedule}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); void insertImages(files); return; }
          // Чужое оформление при вставке не нужно: только текст, строки сохраняются.
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (files.length) { event.preventDefault(); void insertImages(files); }
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          // Галочка нарисована слева от строки пункта: щелчок по ней отмечает пункт.
          if (target.classList.contains("st-task") && event.nativeEvent.offsetX < 22) {
            target.dataset.done = target.dataset.done === "1" ? "0" : "1";
            schedule();
          }
          // Ссылка с Ctrl открывается вкладкой браузера MBOX, а окно записки остаётся на месте.
          const link = target.closest("a");
          if (link && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void fetchJson("/api/mbox/ui/open", json("POST", { target: link.href })).then(() => bridge()?.focusMain()).catch(() => undefined);
          }
        }}
      />
      )}
      {mode === "edit" && (
      <footer className="st-tools" role="toolbar" aria-label="Оформление">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("bold")} title="Жирный (Ctrl+B)" aria-label="Жирный"><Bold size={15} /></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("italic")} title="Курсив (Ctrl+I)" aria-label="Курсив"><Italic size={15} /></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("underline")} title="Подчёркнутый (Ctrl+U)" aria-label="Подчёркнутый"><Underline size={15} /></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("strikeThrough")} title="Зачёркнутый" aria-label="Зачёркнутый"><Strikethrough size={15} /></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertUnorderedList")} title="Список" aria-label="Список"><List size={15} /></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={toggleTask} title="Пункт с галочкой" aria-label="Пункт с галочкой"><ListChecks size={15} /></button>
        <button type="button" onClick={() => fileRef.current?.click()} title="Картинка" aria-label="Вставить картинку"><ImagePlus size={15} /></button>
        <input ref={fileRef} type="file" accept="image/*" hidden multiple onChange={(event) => { void insertImages([...(event.target.files ?? [])]); event.target.value = ""; }} />
      </footer>
      )}
    </div>
  );
}

function plainOf(note: Note) {
  return (note.snippet ?? note.content ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "🖼")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*] \[[ xX]\] /gm, "☐ ")
    .replace(/^\s*[-*] /gm, "• ")
    .replace(/[*_~`#>]/g, "")
    .replace(/<\/?u>/g, "")
    .trim();
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }).replace(".", "");
}

function StickyList() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    const { notes: list } = await fetchJson<{ notes: Note[] }>(`/api/mbox/notes?limit=300${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`).catch(() => ({ notes: [] as Note[] }));
    setNotes(list);
    void bridge()?.state().then((state) => setOpenIds(state.open));
  }, [query]);

  useEffect(() => {
    document.title = "Заметки";
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const poll = window.setInterval(() => { if (!document.hasFocus()) void load(); }, 15000);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", onFocus); window.clearInterval(poll); };
  }, [load, query]);

  async function newNote() {
    const created = await createNote();
    await bridge()?.open(created.id);
    void load();
  }

  function openNote(noteId: string) {
    void bridge()?.open(noteId).then(() => setOpenIds((ids) => ids.includes(noteId) ? ids : [...ids, noteId]));
  }

  return (
    <div className="st-shell is-list">
      <header className="st-head">
        <button type="button" className="st-btn" onClick={() => void newNote()} title="Новая заметка" aria-label="Новая заметка"><Plus size={17} /></button>
        <span className="st-head-fill" />
        <button type="button" className="st-btn" onClick={() => void bridge()?.close()} title="Закрыть" aria-label="Закрыть"><X size={16} /></button>
      </header>
      <div className="st-list-top">
        <h1>Заметки</h1>
        <label className="st-search">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск…" aria-label="Поиск заметок" autoFocus />
          <Search size={15} aria-hidden="true" />
        </label>
      </div>
      <div className="st-list">
        {notes === null ? null : notes.length ? notes.map((note) => (
          // Карточка — не <button>: общие правила кнопок приложения задают им высоту строки, и текст обрезался до нуля.
          <div
            key={note.id}
            role="button"
            tabIndex={0}
            className={`st-card${openIds.includes(note.id) ? " is-open" : ""}`}
            style={{ ["--st-tone" as string]: toneOf(note.color) }}
            onClick={() => openNote(note.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openNote(note.id); } }}
            title={openIds.includes(note.id) ? "Уже на рабочем столе — показать" : "Открыть на рабочем столе"}
          >
            <span className="st-card-date">{shortDate(note.updated_at)}</span>
            <span className="st-card-text">{plainOf(note) || <i>Пустая заметка</i>}</span>
          </div>
        )) : <div className="st-empty is-inline"><b>{query ? "Ничего не нашлось" : "Заметок пока нет"}</b>{!query && <button type="button" className="st-link" onClick={() => void newNote()}>Создать заметку</button>}</div>}
      </div>
    </div>
  );
}
