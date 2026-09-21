import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Eye, FolderOpen, GitCompare, History, Monitor, Pencil, RefreshCw, RotateCcw, Save, Smartphone, X } from "lucide-react";
import { formatBytes, formatDateTime, formatSince } from "../../lib/format";
import { gitLetter } from "./LocalFolders";
import { fetchVersion, fetchVersions, gitStatusOf, onWorkspaceChange, rootName, saveLocalFile, useLocalWorkspace, workspaceBridge, type FileRead, type FileVersion, type GitCommit } from "./localWorkspace";
import { renderDocument } from "./MemoryDocument";
import { DocShell, DrawerToggle, useDrawer } from "./docLayout";
import { usePersistentState, type TabsApi } from "./tabs";
import { hasDraft, useDraft } from "./uiMemory";
import { CodeEditor } from "./CodeEditor";
import { languageOf } from "./codeHighlight";
import { buildLocalPreview } from "./localPreview";
import { MarkdownToolbar, markdownShortcut, toggleTask } from "./MarkdownToolbar";
import { DocumentContextMenu, openDocumentMenu, useDocumentFind } from "./DocumentTools";

const MARKDOWN = /\.(md|mdx|markdown)$/i;

const sourceLabel: Record<string, string> = { mbox: "MBOX", agent: "агент", disk: "диск", baseline: "исходная" };

function cleanError(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Построчное сравнение (LCS). Для огромных файлов не считаем — честно говорим, что слишком большие. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 6_000_000) return null;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { out.push({ kind: "del", text: a[i] }); i += 1; }
    else { out.push({ kind: "add", text: b[j] }); j += 1; }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

type DiffPiece = { kind: "same" | "add" | "del"; text: string };

/**
 * Пословное сравнение одной строки. В прозе абзац — это одна длинная строка, и построчный diff на
 * дописанное слово показывал весь абзац сразу удалённым и добавленным заново: видно, что «что-то
 * изменилось», но не видно что. Режем по пробелам, сохраняя их отдельными кусками, чтобы склеить
 * строку обратно без потерь.
 */
function wordDiff(before: string, after: string): DiffPiece[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > 250_000) return [{ kind: "del", text: before }, { kind: "add", text: after }];
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out: DiffPiece[] = [];
  const push = (kind: DiffPiece["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { push("del", a[i]); i += 1; }
    else { push("add", b[j]); j += 1; }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("add", b[j++]);
  return out;
}

/** Доля общего текста: по ней решаем, одна это правленая строка или две разные. */
function sameRatio(pieces: DiffPiece[]) {
  let same = 0;
  let total = 0;
  for (const piece of pieces) {
    total += piece.text.length;
    if (piece.kind === "same") same += piece.text.length;
  }
  return total ? same / total : 1;
}

function InlineDiffLine({ pieces, kind }: { pieces: DiffPiece[]; kind: "add" | "del" }) {
  const other = kind === "add" ? "del" : "add";
  return (
    <div className={`wb-diff-line is-${kind}`}>
      <span>{kind === "add" ? "+" : "−"}</span>
      {pieces.map((piece, index) => piece.kind === other ? null
        : piece.kind === "same" ? <span key={index}>{piece.text}</span>
        : <mark key={index} className={`wb-diff-word is-${kind}`}>{piece.text}</mark>)}
    </div>
  );
}

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  // Длинные неизменённые куски сворачиваем, оставляя по три строки контекста.
  const blocks: Array<DiffLine | { kind: "gap"; count: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind !== "same") { blocks.push(line); continue; }
    let end = index;
    while (end < lines.length && lines[end].kind === "same") end += 1;
    const run = end - index;
    if (run > 8) {
      if (index > 0) lines.slice(index, index + 3).forEach((item) => blocks.push(item));
      blocks.push({ kind: "gap", count: run - (index > 0 ? 3 : 0) - (end < lines.length ? 3 : 0) });
      if (end < lines.length) lines.slice(end - 3, end).forEach((item) => blocks.push(item));
    } else {
      lines.slice(index, end).forEach((item) => blocks.push(item));
    }
    index = end - 1;
  }
  const changed = lines.filter((line) => line.kind !== "same").length;
  if (!changed) return <p className="wb-empty">Содержимое совпадает.</p>;

  // Равные по длине встречные пачки «удалено» и «добавлено» — это почти всегда правленые строки,
  // а не разные: показываем их парами с подсветкой изменившихся слов внутри.
  const rows: ReactNode[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index];
    if (block.kind === "gap") { rows.push(<div key={rows.length} className="wb-diff-gap">⋯ {block.count} без изменений</div>); index += 1; continue; }
    if (block.kind === "del") {
      let end = index;
      while (end < blocks.length && blocks[end].kind === "del") end += 1;
      let addEnd = end;
      while (addEnd < blocks.length && blocks[addEnd].kind === "add") addEnd += 1;
      const dels = blocks.slice(index, end) as DiffLine[];
      const adds = blocks.slice(end, addEnd) as DiffLine[];
      if (dels.length && dels.length === adds.length) {
        dels.forEach((del, pair) => {
          const add = adds[pair];
          const pieces = wordDiff(del.text, add.text);
          if (sameRatio(pieces) >= 0.3) {
            rows.push(<InlineDiffLine key={rows.length} pieces={pieces} kind="del" />);
            rows.push(<InlineDiffLine key={rows.length + 1} pieces={pieces} kind="add" />);
          } else {
            rows.push(<div key={rows.length} className="wb-diff-line is-del"><span>−</span>{del.text || " "}</div>);
            rows.push(<div key={rows.length + 1} className="wb-diff-line is-add"><span>+</span>{add.text || " "}</div>);
          }
        });
        index = addEnd;
        continue;
      }
    }
    rows.push(<div key={rows.length} className={`wb-diff-line is-${block.kind}`}><span>{block.kind === "add" ? "+" : block.kind === "del" ? "−" : " "}</span>{block.text || " "}</div>);
    index += 1;
  }
  return <div className="wb-diff">{rows}</div>;
}

export function UnifiedDiff({ text }: { text: string }) {
  return (
    <div className="wb-diff">
      {text.split("\n").map((line, index) => {
        const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") ? "meta"
          : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
        return <div key={index} className={`wb-diff-line is-${kind}`}>{line || " "}</div>;
      })}
    </div>
  );
}

export function LocalFileDocument({ rootKey, path, tabs, tabKey, visible, onDirty }: {
  rootKey: string;
  path: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const ws = useLocalWorkspace();
  const bridge = workspaceBridge();
  const isMarkdown = MARKDOWN.test(path);
  const [file, setFile] = useState<FileRead | null>(null);
  const draftKey = `local:${rootKey}:${path}`;
  const [diskContent, setDiskContent] = useState("");
  const [draft, setDraft, discardDraft] = useDraft(draftKey, diskContent);
  const isHtml = /\.html?$/i.test(path);
  const [mdMode, setMdMode] = usePersistentState<"edit" | "preview">("mbox.localFile.markdownMode", "preview");
  const [htmlMode, setHtmlMode] = usePersistentState<"edit" | "preview">("mbox.localFile.htmlMode", "preview");
  const [viewport, setViewport] = usePersistentState<"desktop" | "mobile">("mbox.file.viewport", "desktop");
  const mode = isMarkdown ? mdMode : isHtml ? htmlMode : "edit";
  const setMode = isHtml ? setHtmlMode : setMdMode;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Предпросмотр HTML со стилями, скриптами, шрифтами и картинками из соседних файлов (localPreview.ts).
  const [previewHtml, setPreviewHtml] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const find = useDocumentFind({ editorRef, previewRef, text: draft, enabled: visible });
  useEffect(() => {
    if (!isHtml || mode !== "preview") return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void buildLocalPreview(draft, rootKey, path, bridge).then((html) => { if (alive) setPreviewHtml(html); }).catch(() => { if (alive) setPreviewHtml(draft); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [isHtml, mode, draft, rootKey, path, bridge]);
  const [conflict, setConflict] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [viewing, setViewing] = useState<(FileVersion & { content: string }) | null>(null);
  const [compare, setCompare] = useState(false);
  const [sideTab, setSideTab] = usePersistentSide();
  const [drawerOpen, setDrawerOpen] = useDrawer("mbox.doc.local.history");
  const fileRef = useRef<FileRead | null>(null);
  fileRef.current = file;
  const dirty = Boolean(file) && draft !== (file?.content ?? "");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const next = await bridge.read(rootKey, path);
      setFile(next);
      setDiskContent(next.content);
      // Несохранённая правка с прошлого запуска остаётся в редакторе; без неё — берём текст с диска.
      if (!hasDraft(draftKey)) discardDraft(next.content);
      setConflict(false);
      setError("");
    } catch (cause) {
      setError(cleanError(cause));
      // Файл пропал из-под открытой вкладки — показываем честное «его больше нет» вместо старого текста.
      if (/ENOENT|no such file/i.test(cleanError(cause)) && !dirtyRef.current) setFile(null);
    }
  }, [bridge, rootKey, path]);

  const loadHistory = useCallback(async () => {
    setVersions(await fetchVersions(rootKey, path).catch(() => []));
    if (bridge) setCommits(await bridge.gitLog(rootKey, path).catch(() => []));
  }, [bridge, rootKey, path]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadHistory(); }, [loadHistory, ws.serverWorkspace(rootKey)?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Файл поменяли на диске (агент, другой редактор): без своих правок — просто перечитываем,
  // со своими — предупреждаем, ничего не затирая.
  useEffect(() => onWorkspaceChange((key, paths) => {
    if (key !== rootKey || !paths.includes(path)) return;
    if (dirtyRef.current) setConflict(true);
    else void load();
    window.setTimeout(() => void loadHistory(), 1500);
  }), [rootKey, path, load, loadHistory]);

  async function save(force = false) {
    if (!file || saving) return;
    setSaving(true);
    setError("");
    try {
      const written = await saveLocalFile(rootKey, path, draft, force ? undefined : file.mtime);
      setFile({ ...file, content: draft, mtime: written.mtime, size: written.size });
      setDiskContent(draft);
      discardDraft(draft);
      setConflict(false);
      tabs.pin(tabKey);
      window.setTimeout(() => void loadHistory(), 500);
    } catch (cause) {
      const message = cleanError(cause);
      if (message.includes("изменился на диске")) setConflict(true);
      else setError(message);
    } finally {
      setSaving(false);
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

  function onEditorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    setDraft(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
    window.requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = selectionStart + 2; });
  }

  async function openVersion(version: FileVersion) {
    setViewing(await fetchVersion(version.id));
    setCompare(false);
  }

  const diff = useMemo(() => (viewing && compare ? lineDiff(viewing.content, draft) : null), [viewing, compare, draft]);
  const letter = gitLetter(gitStatusOf(rootKey, path));

  if (!bridge) return <div className="wb-doc-missing">Локальные файлы открываются в приложении MBOX Desktop.</div>;
  if (error && !file) {
    const gone = /ENOENT|no such file/i.test(error);
    return (
      <div className="wb-doc-missing">
        {gone ? `Файла «${path}» больше нет — его удалили, переименовали или переместили вне MBOX.` : error}
        {gone && <button type="button" className="wb-inline-btn" onClick={() => tabs.close(tabKey)}>Закрыть вкладку</button>}
      </div>
    );
  }
  if (!file) return <div className="wb-doc-missing">Открываю {path}…</div>;

  return (
    <DocShell
      drawerOpen={drawerOpen}
      onCloseDrawer={() => setDrawerOpen(false)}
      toolbar={(
        <>
          <span className="wb-doc-crumbs">{rootName(rootKey)} › {path.split("/").join(" › ")}{letter && <span className={`wb-git-letter is-${letter}`}>{letter}</span>}{dirty && <b className="wb-dirty-mark"> ●</b>}</span>
          {isMarkdown && mode === "edit" && <MarkdownToolbar targetRef={editorRef} />}
          <div className="wb-doc-actions">
            {isHtml && mode === "preview" && (
              <div className="wb-segmented">
                <button type="button" className={viewport === "desktop" ? "is-on" : undefined} onClick={() => setViewport("desktop")} title="Ширина ПК"><Monitor size={13} /></button>
                <button type="button" className={viewport === "mobile" ? "is-on" : undefined} onClick={() => setViewport("mobile")} title="Ширина телефона"><Smartphone size={13} /></button>
              </div>
            )}
            {(isMarkdown || isHtml) && (
              <div className="wb-segmented">
                <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => setMode("preview")}><Eye size={13} /> Просмотр</button>
                <button type="button" className={mode === "edit" ? "is-on" : undefined} onClick={() => setMode("edit")}><Pencil size={13} /> Правка</button>
              </div>
            )}
            {letter && <button type="button" onClick={() => tabs.open(`gitdiff:${rootKey}:${path}`, true)} title="Изменения относительно последнего коммита"><GitCompare size={14} /></button>}
            <button type="button" onClick={() => void bridge.reveal(rootKey, path)} title="Показать в проводнике Windows"><FolderOpen size={14} /></button>
            <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} label="История" count={versions.length + commits.length} />
            {dirty && <button type="button" onClick={() => setDraft(file.content)} title="Отменить несохранённые правки"><X size={14} /></button>}
            <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>
          </div>
        </>
      )}
      drawer={(
        <>
          <div className="wb-side-tabs">
            <button type="button" className={sideTab === "history" ? "is-on" : undefined} onClick={() => setSideTab("history")}><History size={12} /> Версии · {versions.length}</button>
            <button type="button" className={sideTab === "git" ? "is-on" : undefined} onClick={() => setSideTab("git")}>Git · {commits.length}</button>
          </div>
          {sideTab === "history" ? (
            versions.length ? (
              <ul className="wb-version-list">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button type="button" className={viewing?.id === version.id ? "is-active" : undefined} onClick={() => void openVersion(version)}>
                      <span className={`wb-version-source is-${version.source}`}>{sourceLabel[version.source] ?? version.source}</span>
                      <b>{version.author || "—"}</b>
                      <span className="wb-tree-hint">{formatSince(version.created_at)} · {formatBytes(version.size_bytes)}</span>
                      {version.message && <em>{version.message}</em>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="wb-empty">Версий пока нет — первая появится при сохранении из MBOX или правке агента.</p>
          ) : commits.length ? (
            <ul className="wb-version-list">
              {commits.map((commit) => (
                <li key={commit.hash}>
                  <button type="button" onClick={() => tabs.open(`commit:${rootKey}:${commit.hash}`, true)} title={commit.hash}>
                    <span className="wb-git-hash">{commit.short}</span>
                    <b>{commit.subject}</b>
                    <span className="wb-tree-hint">{commit.author} · {formatSince(commit.date)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="wb-empty">Коммитов с этим файлом нет.</p>}
        </>
      )}
    >
      {find.bar}
      {conflict && (
        <div className="wb-banner is-warn">
          Файл изменился на диске, пока он был открыт.
          <button type="button" onClick={() => void load()}><RefreshCw size={12} /> Загрузить с диска</button>
          <button type="button" onClick={() => void save(true)}><Save size={12} /> Перезаписать моими правками</button>
        </div>
      )}
      {error && <div className="wb-banner is-error">{error}</div>}
      {file.binary || file.tooLarge ? (
        <div className="wb-doc-missing">{file.binary ? "Двоичный файл — в MBOX не показывается." : `Файл ${formatBytes(file.size)} — слишком большой для редактора.`}</div>
      ) : viewing ? (
        <div className="wb-version-view">
          <div className="wb-banner">
            Версия от {formatDateTime(viewing.created_at)} · {viewing.author || "—"} · {sourceLabel[viewing.source] ?? viewing.source}
            <button type="button" className={compare ? "is-on" : undefined} onClick={() => setCompare((value) => !value)}><GitCompare size={12} /> {compare ? "Показать версию" : "Сравнить с текущим"}</button>
            <button type="button" onClick={() => { setDraft(viewing.content); setViewing(null); setMode("edit"); }}><RotateCcw size={12} /> Восстановить в редактор</button>
            <button type="button" onClick={() => setViewing(null)}><X size={12} /> Закрыть</button>
          </div>
          {compare ? (diff ? <DiffLines lines={diff} /> : <p className="wb-empty">Файлы слишком большие для построчного сравнения.</p>) : <pre className="wb-version-text">{viewing.content}</pre>}
        </div>
      ) : mode === "preview" && isHtml ? (
        // Предпросмотр показывает текущий черновик; соседние стили, скрипты, шрифты и картинки подставлены.
        <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
          <iframe title={path} sandbox="allow-scripts" srcDoc={previewHtml || draft} />
        </div>
      ) : mode === "preview" && isMarkdown ? (
        <div ref={previewRef} className="wb-reading" onContextMenu={(event) => openDocumentMenu(event, setContextMenu)}><div className="wb-memory-body" onDoubleClick={() => setMode("edit")}>{renderDocument(draft, { onToggleTask: (line) => setDraft(toggleTask(draft, line)) })}</div></div>
      ) : (
        <CodeEditor textareaRef={editorRef} value={draft} onChange={setDraft} language={languageOf(path)} onKeyDown={(event) => { if (isMarkdown && markdownShortcut(event)) return; onEditorKey(event); }} onContextMenu={(event) => openDocumentMenu(event, setContextMenu)} />
      )}
      <div className="wb-doc-foot">{formatBytes(file.size)} · изменён {formatDateTime(new Date(file.mtime).toISOString())}</div>
      <DocumentContextMenu point={contextMenu} onClose={() => setContextMenu(null)} editorRef={editorRef} previewRef={previewRef} onFind={find.openFind} markdown={isMarkdown} />
    </DocShell>
  );
}

function usePersistentSide() {
  const [value, setValue] = useState<"history" | "git">(() => {
    try { return window.localStorage.getItem("mbox.local.sideTab") === "git" ? "git" : "history"; } catch { return "history"; }
  });
  return [value, (next: "history" | "git") => { setValue(next); try { window.localStorage.setItem("mbox.local.sideTab", next); } catch { /* без памяти */ } }] as const;
}

export function GitDiffDocument({ rootKey, path, tabs }: { rootKey: string; path: string; tabs: TabsApi }) {
  const bridge = workspaceBridge();
  const [state, setState] = useState<{ diff: string; note?: string } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!bridge) return;
    bridge.gitDiff(rootKey, path).then(setState).catch((cause) => setError(cleanError(cause)));
  }, [bridge, rootKey, path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onWorkspaceChange((key, paths) => { if (key === rootKey && (paths.includes(path) || paths.includes(".git"))) load(); }), [rootKey, path, load]);
  if (!bridge) return <div className="wb-doc-missing">Git доступен в приложении MBOX Desktop.</div>;
  return (
    <div className="wb-doc-page">
      <header className="wb-doc-header">
        <h2>{path}</h2>
        <span className="wb-doc-detail">изменения относительно HEAD · {rootName(rootKey)}</span>
        <button type="button" className="wb-inline-btn" onClick={() => tabs.open(`local:${rootKey}:${path}`, true)}>Открыть файл</button>
      </header>
      {error ? <p className="wb-error">{error}</p> : !state ? <p className="wb-empty">Загрузка…</p> : state.diff ? <UnifiedDiff text={state.diff} /> : <p className="wb-empty">{state.note}</p>}
    </div>
  );
}

export function CommitDocument({ rootKey, hash }: { rootKey: string; hash: string }) {
  const bridge = workspaceBridge();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    bridge?.gitShow(rootKey, hash).then((result) => setText(result.text)).catch((cause) => setError(cleanError(cause)));
  }, [bridge, rootKey, hash]);
  if (!bridge) return <div className="wb-doc-missing">Git доступен в приложении MBOX Desktop.</div>;
  if (error) return <div className="wb-doc-missing">{error}</div>;
  if (!text) return <div className="wb-doc-missing">Загрузка коммита…</div>;
  const [meta, ...rest] = text.split(/\n(?=diff --git| \S.*\|)/);
  return (
    <div className="wb-doc-page">
      <pre className="wb-commit-meta">{meta}</pre>
      <UnifiedDiff text={rest.join("\n")} />
    </div>
  );
}
