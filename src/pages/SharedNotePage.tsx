import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Eye, Palette, Pencil } from "lucide-react";
import { merge3 } from "../lib/merge3";
import { renderDocument } from "../app/workbench/MemoryDocument";
import { MarkdownToolbar, markdownShortcut, toggleTask, useImageInsert } from "../app/workbench/MarkdownToolbar";
import { CodeEditor } from "../app/workbench/CodeEditor";

type SharedNote = { title: string; content: string; theme: "light" | "graphite" | "black"; updated_at: string };
type Status = "loading" | "saved" | "pending" | "saving" | "error" | "missing";

const POLL_MS = 4000;
const SAVE_DELAY_MS = 800;
const SHARED_THEME_KEY = "mbox.shared-note-theme";
const THEME_ORDER: SharedNote["theme"][] = ["light", "graphite", "black"];
const THEME_LABEL: Record<SharedNote["theme"], string> = {
  light: "Светлая",
  graphite: "Графитовая",
  black: "Чёрная",
};

/**
 * Заметка по ссылке /n/<токен> — для людей без входа в MBOX: бесконечный документ, как в Google Docs.
 * Ссылка на просмотр показывает текст, ссылка на правку — редактор с сохранением на ходу и вставкой картинок
 * (грузятся в S3 в папку заметки). Одновременную правку сводим трёхсторонним слиянием (merge3):
 * правки в разных местах сохраняются обе, чужие изменения подтягиваются каждые 4 секунды.
 */
export function SharedNotePage({ token }: { token: string }) {
  const api = `/api/share/notes/${token}`;
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [theme, setTheme] = useState<SharedNote["theme"]>("graphite");
  const [viewerTheme, setViewerTheme] = useState<SharedNote["theme"] | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const base = useRef<{ content: string; updatedAt: string }>({ content: "", updatedAt: "" });
  const contentRef = useRef("");
  contentRef.current = content;
  const saving = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(SHARED_THEME_KEY);
    if (stored === "light" || stored === "graphite" || stored === "black") setViewerTheme(stored);
  }, []);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 8000);
  };

  // Замена текста снаружи (чужая правка) не должна выкидывать курсор в конец поля.
  const replaceContent = useCallback((next: string) => {
    const el = textareaRef.current;
    const selection = el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : null;
    setContent(next);
    if (selection) window.requestAnimationFrame(() => el?.setSelectionRange(Math.min(selection[0], el.value.length), Math.min(selection[1], el.value.length)));
  }, []);

  /** Свести чужую версию со своей: без своих правок — просто взять, со своими — merge3. */
  const absorbRemote = useCallback((remote: SharedNote) => {
    const local = contentRef.current;
    if (local === base.current.content) {
      if (remote.content !== local) replaceContent(remote.content);
    } else {
      const merged = merge3(base.current.content, local, remote.content);
      if (merged.conflict) flash("Кто-то одновременно поправил то же место — оставлена ваша версия этого фрагмента.");
      if (merged.text !== local) replaceContent(merged.text);
    }
    base.current = { content: remote.content, updatedAt: remote.updated_at };
    setTheme(remote.theme || "graphite");
    document.title = remote.title || "Заметка";
  }, [replaceContent]);

  useEffect(() => {
    let alive = true;
    fetch(api)
      .then(async (response) => {
        const data = await response.json();
        if (!alive) return;
        if (!response.ok) { setStatus("missing"); setNotice(data.error || "Ссылка недействительна"); return; }
        setMode(data.mode);
        setEditing(false);
        base.current = { content: data.note.content, updatedAt: data.note.updated_at };
        setContent(data.note.content);
        setTheme(data.note.theme || "graphite");
        document.title = data.note.title || "Заметка";
        setStatus("saved");
      })
      .catch(() => { if (alive) { setStatus("missing"); setNotice("Не удалось открыть заметку — проверьте интернет"); } });
    return () => { alive = false; };
  }, [api]);

  const save = useCallback(async () => {
    if (saving.current || mode !== "edit") return;
    saving.current = true;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const text = contentRef.current;
        if (text === base.current.content) { setStatus("saved"); return; }
        setStatus("saving");
        const response = await fetch(api, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, base_updated_at: base.current.updatedAt }) });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 && data.note) { absorbRemote(data.note); continue; }
        if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
        base.current = { content: text, updatedAt: data.note.updated_at };
        setStatus(contentRef.current === text ? "saved" : "pending");
        return;
      }
      setStatus("pending");
    } catch (error) {
      setStatus("error");
      flash(error instanceof Error ? error.message : "Не сохранилось");
    } finally {
      saving.current = false;
    }
  }, [api, mode, absorbRemote]);

  // Сохранение на ходу, как в Google Docs: пауза в наборе — и текст уже на сервере.
  useEffect(() => {
    if (status === "loading" || status === "missing" || mode !== "edit" || content === base.current.content) return;
    setStatus("pending");
    const timer = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [content, mode, save, status === "loading" || status === "missing"]); // eslint-disable-line react-hooks/exhaustive-deps

  // Чужие правки: раз в 4 секунды, только пока вкладка видна и мы не посреди сохранения.
  useEffect(() => {
    if (status === "missing" || status === "loading") return;
    const timer = window.setInterval(async () => {
      if (document.hidden || saving.current) return;
      try {
        const response = await fetch(api);
        if (!response.ok) return;
        const data = await response.json();
        if (data.note.updated_at !== base.current.updatedAt) absorbRemote(data.note);
      } catch {
        // сеть мигнула — попробуем на следующем круге
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [api, absorbRemote, status === "missing" || status === "loading"]); // eslint-disable-line react-hooks/exhaustive-deps

  // Уходят со страницы с несохранённым — предупредить, как любой редактор документов.
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (mode === "edit" && contentRef.current !== base.current.content) event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [mode]);

  const images = useImageInsert(textareaRef, "", flash, async (file, name) => {
    const response = await fetch(`${api}/images?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": file.type || "image/png" }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    return data.url as string;
  });

  const breakAt = content.indexOf("\n");
  const titleText = breakAt < 0 ? content : content.slice(0, breakAt);
  const bodyText = breakAt < 0 ? "" : content.slice(breakAt + 1);
  const setParts = (title: string, body: string) => setContent(body ? `${title}\n${body}` : title);

  function onTitleKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if ((event.key === "Enter" && !event.nativeEvent.isComposing) || event.key === "ArrowDown") {
      event.preventDefault();
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(0, 0);
    }
  }

  function onTitlePaste(event: ReactClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    event.preventDefault();
    setParts(titleText + text.slice(0, text.indexOf("\n")), [text.slice(text.indexOf("\n") + 1), bodyText].filter(Boolean).join("\n"));
  }

  const statusLabel: Record<Status, string> = {
    loading: "Открываю…",
    saved: mode === "edit" ? "Все изменения сохранены" : "Документ открыт",
    pending: "Есть несохранённые изменения…",
    saving: "Сохраняю…",
    error: "Не сохранилось — повторю при следующей правке",
    missing: "",
  };

  if (status === "missing") {
    return (
      <div className="share-page">
        <main className="share-missing">
          <h1>Заметка недоступна</h1>
          <p>{notice || "Ссылка отозвана или заметка удалена."}</p>
        </main>
      </div>
    );
  }

  const canEdit = mode === "edit";
  const showEditor = canEdit && editing;
  const activeTheme = viewerTheme || theme;
  const cycleTheme = () => {
    const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(activeTheme) + 1) % THEME_ORDER.length];
    setViewerTheme(nextTheme);
    window.localStorage.setItem(SHARED_THEME_KEY, nextTheme);
  };

  return (
    <div className={`share-page doc-theme-${activeTheme}`}>
      <header className="share-bar">
        <span className="share-brand">MBOX</span>
        <span className={`share-status is-${status}`}>{statusLabel[status]}</span>
        <span className="share-access">{canEdit ? "Только редактирование" : "Только просмотр"}</span>
        <button
          type="button"
          className="share-theme-button"
          onClick={cycleTheme}
          aria-label={`Сменить тему. Сейчас ${THEME_LABEL[activeTheme].toLowerCase()}`}
          title="Сменить тему"
        >
          <Palette size={14} aria-hidden="true" />
          <span>{THEME_LABEL[activeTheme]}</span>
        </button>
        {showEditor && <MarkdownToolbar targetRef={textareaRef} onPickImages={(files) => void images.insertImages(files)} uploading={images.uploading} />}
        {canEdit && (
          <div className="share-toggle" role="group" aria-label="Режим">
            <button type="button" className={!editing ? "is-on" : undefined} onClick={() => { void save(); setEditing(false); }}><Eye size={14} /> Просмотр</button>
            <button type="button" className={editing ? "is-on" : undefined} onClick={() => setEditing(true)}><Pencil size={14} /> Правка</button>
          </div>
        )}
      </header>
      {notice && <div className="share-notice" role="status">{notice}</div>}
      <main className="share-doc">
        {status === "loading" ? (
          <p className="share-muted">Открываю заметку…</p>
        ) : showEditor ? (
          <>
            <input
              ref={titleRef}
              className="share-title-input"
              value={titleText}
              onChange={(event) => setParts(event.target.value, bodyText)}
              onKeyDown={onTitleKey}
              onPaste={onTitlePaste}
              placeholder="Заголовок"
              spellCheck
            />
            <CodeEditor
              textareaRef={textareaRef}
              className="share-markdown"
              variant="document"
              autoGrow
              language="markdown"
              value={bodyText}
              onChange={(value) => setParts(titleText, value)}
              onKeyDown={(event) => { markdownShortcut(event); }}
              onPaste={images.onPaste}
              onDrop={images.onDrop}
              placeholder="Текст. Картинку можно вставить из буфера или перетащить сюда. Сохраняется само."
              spellCheck
            />
          </>
        ) : (
          <article className="wb-memory-body" onDoubleClick={() => canEdit && setEditing(true)}>
            {titleText.trim() && <h1 className="share-title">{titleText.replace(/^#{1,6}\s+/, "")}</h1>}
            {bodyText.trim()
              ? renderDocument(bodyText, canEdit ? { onToggleTask: (line) => setContent((current) => toggleTask(current, line + 1)) } : {})
              : !titleText.trim() && <p className="share-muted">Пока пусто.</p>}
          </article>
        )}
      </main>
    </div>
  );
}
