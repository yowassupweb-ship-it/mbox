import { useFindRequest } from "../../hooks/useFindRequest";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, Highlighter, Moon, PanelLeft, Pencil, Redo2, RotateCw, Save, Search, Type, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
// Сборка legacy: MBOX Desktop работает на Chromium 130, а обычная сборка pdf.js 6 требует более новых методов Map.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { useRemembered } from "./uiMemory";

type PdfSource = { bytes: Uint8Array } | { url: string };
type Tool = "none" | "highlight" | "text" | "ink";
type Scale = "auto" | "page-width" | "page-fit" | number;

// Цвета аннотаций — содержимое документа (уходят внутрь PDF), а не цвета интерфейса, поэтому заданы значениями.
const MARK_COLORS = ["#ffd400", "#53d769", "#4da3ff", "#ff6b6b", "#c58bff"];
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

type PdfJs = typeof import("pdfjs-dist");

/** Map.prototype.getOrInsert(Computed) появился в Chromium 145; визуальный слой pdf.js его уже использует. */
function polyfillUpsert() {
  for (const target of [Map.prototype, WeakMap.prototype] as Array<{ getOrInsert?: unknown; getOrInsertComputed?: unknown }>) {
    const proto = target as unknown as { has: (k: unknown) => boolean; get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => void };
    if (!target.getOrInsert) Object.defineProperty(target, "getOrInsert", { configurable: true, writable: true, value(this: typeof proto, key: unknown, value: unknown) { if (!this.has(key)) this.set(key, value); return this.get(key); } });
    if (!target.getOrInsertComputed) Object.defineProperty(target, "getOrInsertComputed", { configurable: true, writable: true, value(this: typeof proto, key: unknown, compute: (k: unknown) => unknown) { if (!this.has(key)) this.set(key, compute(key)); return this.get(key); } });
  }
}
type ViewerLib = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type Libs = { pdfjs: PdfJs; viewer: ViewerLib };

/** Режимы и параметры редактора аннотаций берём из самой библиотеки: числа у них меняются между версиями. */
function editorIds(pdfjs: PdfJs, tool: Tool) {
  const type = pdfjs.AnnotationEditorType;
  const param = pdfjs.AnnotationEditorParamsType;
  return {
    mode: { none: type.NONE, highlight: type.HIGHLIGHT, text: type.FREETEXT, ink: type.INK }[tool],
    color: { none: 0, highlight: param.HIGHLIGHT_COLOR, text: param.FREETEXT_COLOR, ink: param.INK_COLOR }[tool],
    inkThickness: param.INK_THICKNESS,
    textSize: param.FREETEXT_SIZE,
  };
}
let libsPromise: Promise<Libs> | null = null;

/** pdf.js и его визуальный слой грузятся один раз и только при первом открытии PDF. */
function loadLibs(): Promise<Libs> {
  libsPromise ??= (async () => {
    polyfillUpsert();
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    (globalThis as unknown as { pdfjsLib: PdfJs }).pdfjsLib = pdfjs;
    const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");
    return { pdfjs, viewer };
  })();
  return libsPromise;
}

type Doc = import("pdfjs-dist").PDFDocumentProxy;
type Viewer = import("pdfjs-dist/web/pdf_viewer.mjs").PDFViewer;
type Bus = import("pdfjs-dist/web/pdf_viewer.mjs").EventBus;

export type PdfViewerProps = {
  source: PdfSource;
  /** Меняется, когда файл на диске/в хранилище стал другим: документ открывается заново. */
  version?: string | number;
  name: string;
  memoryKey: string;
  /** Нет колбэка — аннотации недоступны (только просмотр). */
  onSave?: (bytes: Uint8Array) => Promise<void>;
  onDownload?: () => void;
};

/**
 * Просмотр и правка PDF: pdf.js (рендер, текст, поиск, ссылки, встроенный редактор аннотаций) с интерфейсом MBOX.
 * Страницы листаются непрерывно, масштаб — кнопками, Ctrl+колесом и по ширине; слева миниатюры; Ctrl+F — поиск.
 * Выделение, текст и рисунок сохраняются прямо в PDF.
 */
export default function PdfViewer({ source, version, name, memoryKey, onSave, onDownload }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pdfViewer = useRef<Viewer | null>(null);
  const bus = useRef<Bus | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState<Scale>("auto");
  const [view, setView] = useRemembered(`pdf:${memoryKey}`, { sidebar: true, dark: false });
  const [tool, setTool] = useState<Tool>("none");
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const findInput = useRef<HTMLInputElement | null>(null);
  const bytesKey = "bytes" in source ? source.bytes : source.url;

  // Документ: открывается заново при смене файла или версии.
  useEffect(() => {
    let cancelled = false;
    let opened: { destroy: () => Promise<void> } | null = null;
    setLoading(true);
    setError("");
    setDirty(false);
    setTool("none");
    (async () => {
      try {
        const { pdfjs } = await loadLibs();
        const task = pdfjs.getDocument("bytes" in source ? { data: source.bytes.slice() } : { url: source.url, withCredentials: true });
        opened = task;
        const loaded = await task.promise;
        if (cancelled) { void task.destroy(); return; }
        const storage = loaded.annotationStorage as unknown as { onSetModified: () => void; onResetModified: () => void };
        storage.onSetModified = () => setDirty(true);
        storage.onResetModified = () => setDirty(false);
        setDoc(loaded);
        setPages(loaded.numPages);
      } catch (cause) {
        if (!cancelled) setError(/password/i.test(String((cause as Error)?.name)) ? "PDF защищён паролем." : /Invalid PDF|Missing PDF/i.test(String((cause as Error)?.message)) ? "Файл не похож на PDF или повреждён." : `Не удалось открыть PDF: ${(cause as Error)?.message || cause}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; setDoc(null); if (opened) void opened.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytesKey, version]);

  // Визуальный слой pdf.js поверх документа.
  useEffect(() => {
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!doc || !container || !viewerEl) return;
    let disposed = false;
    let instance: Viewer | null = null;
    (async () => {
      const { viewer } = await loadLibs();
      if (disposed) return;
      const eventBus = new viewer.EventBus();
      const linkService = new viewer.PDFLinkService({ eventBus });
      const findController = new viewer.PDFFindController({ eventBus, linkService });
      instance = new viewer.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, annotationEditorMode: onSave ? 0 : -1, removePageBorders: false, textLayerMode: 1 });
      linkService.setViewer(instance);
      bus.current = eventBus;
      pdfViewer.current = instance;
      eventBus.on("pagesinit", () => { if (instance) { instance.currentScaleValue = "auto"; setScale("auto"); } });
      eventBus.on("pagechanging", (event: { pageNumber: number }) => setPage(event.pageNumber));
      eventBus.on("scalechanging", (event: { scale: number }) => setScale((current) => (typeof current === "number" || current === "auto" ? (typeof current === "string" ? current : event.scale) : current)));
      eventBus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => setMatches(event.matchesCount));
      eventBus.on("updatefindcontrolstate", (event: { matchesCount: { current: number; total: number } }) => setMatches(event.matchesCount));
      instance.setDocument(doc);
      linkService.setDocument(doc, null);
    })();
    return () => {
      disposed = true;
      bus.current = null;
      pdfViewer.current = null;
      try { instance?.cleanup(); } catch { /* уже закрыт */ }
      viewerEl.replaceChildren();
    };
  }, [doc, onSave]);

  const applyScale = useCallback((next: Scale) => {
    const instance = pdfViewer.current;
    if (!instance) return;
    instance.currentScaleValue = typeof next === "number" ? String(next) : next;
    setScale(next);
  }, []);

  const zoomBy = useCallback((direction: 1 | -1) => {
    const instance = pdfViewer.current;
    if (!instance) return;
    const current = instance.currentScale;
    const next = direction > 0 ? ZOOM_STEPS.find((step) => step > current + 0.01) ?? 4 : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? 0.5;
    applyScale(next);
  }, [applyScale]);

  // Ctrl+колесо — масштаб, как в просмотрщиках; без Ctrl колесо листает страницы.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomBy, doc]);

  // Режим и параметры редактора аннотаций.
  useEffect(() => {
    const instance = pdfViewer.current;
    const eventBus = bus.current;
    if (!instance || !eventBus || !onSave) return;
    let cancelled = false;
    void loadLibs().then(({ pdfjs }) => {
      if (cancelled || pdfViewer.current !== instance) return;
      const ids = editorIds(pdfjs, tool);
      instance.annotationEditorMode = { mode: ids.mode };
      if (ids.color) eventBus.dispatch("switchannotationeditorparams", { source: null, type: ids.color, value: color });
      if (tool === "ink") eventBus.dispatch("switchannotationeditorparams", { source: null, type: ids.inkThickness, value: 3 });
      if (tool === "text") eventBus.dispatch("switchannotationeditorparams", { source: null, type: ids.textSize, value: 14 });
    });
    return () => { cancelled = true; };
  }, [tool, color, doc, onSave]);

  const editAction = (name: "undo" | "redo") => bus.current?.dispatch("editingaction", { source: null, name });

  async function save() {
    if (!doc || !onSave || saving) return;
    setSaving(true);
    try {
      const bytes = await doc.saveDocument();
      await onSave(bytes);
      setDirty(false);
    } catch (cause) {
      setError(`Не удалось сохранить: ${(cause as Error)?.message || cause}`);
    } finally {
      setSaving(false);
    }
  }

  function runFind(query_: string, previous = false, again = false) {
    bus.current?.dispatch("find", { source: null, type: again ? "again" : "", query: query_, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }

  // Ctrl+F — поиск по PDF, если он на виду (вкладка не скрыта).
  useFindRequest(() => !!containerRef.current?.checkVisibility?.(), () => { setFindOpen(true); window.setTimeout(() => findInput.current?.select(), 0); });

  // Горячие клавиши: Ctrl+S — сохранить, Esc — закрыть поиск.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const inside = containerRef.current?.closest(".wb-pdf-viewer")?.contains(document.activeElement) || document.activeElement === document.body;
      if (!inside) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && onSave) { event.preventDefault(); void save(); }
      if (event.key === "Escape" && findOpen) { setFindOpen(false); runFind("", false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoomLabel = useMemo(() => (scale === "auto" ? "Авто" : scale === "page-width" ? "По ширине" : scale === "page-fit" ? "Страница" : `${Math.round(scale * 100)}%`), [scale]);
  const toolButton = (id: Tool, Icon: typeof Pencil, label: string) => (
    <button type="button" className={tool === id ? "is-on" : undefined} aria-pressed={tool === id} onClick={() => setTool(tool === id ? "none" : id)} title={label} aria-label={label}><Icon size={15} /></button>
  );

  return (
    <div className={`wb-pdf-viewer${view.dark ? " is-dark-pages" : ""}`}>
      <div className="wb-viewer-bar" role="toolbar" aria-label={`PDF: ${name}`}>
        <div className="wb-viewer-group">
          <button type="button" className={view.sidebar ? "is-on" : undefined} aria-pressed={view.sidebar} onClick={() => setView({ ...view, sidebar: !view.sidebar })} title="Миниатюры" aria-label="Миниатюры"><PanelLeft size={15} /></button>
          <span className="wb-viewer-page">
            <input
              aria-label="Номер страницы"
              inputMode="numeric"
              value={page}
              onChange={(event) => { const value = Number(event.target.value.replace(/\D/g, "")); if (value >= 1 && value <= pages && pdfViewer.current) pdfViewer.current.currentPageNumber = value; else if (!event.target.value) setPage(0); }}
              onFocus={(event) => event.currentTarget.select()}
            />
            <span>/ {pages || "…"}</span>
          </span>
        </div>
        <div className="wb-viewer-group">
          <button type="button" onClick={() => zoomBy(-1)} title="Уменьшить" aria-label="Уменьшить"><ZoomOut size={15} /></button>
          <select value={typeof scale === "number" ? "" : scale} onChange={(event) => applyScale(event.target.value as Scale)} aria-label="Масштаб">
            {typeof scale === "number" && <option value="">{zoomLabel}</option>}
            <option value="auto">Авто</option>
            <option value="page-width">По ширине</option>
            <option value="page-fit">Страница целиком</option>
          </select>
          <button type="button" onClick={() => zoomBy(1)} title="Увеличить" aria-label="Увеличить"><ZoomIn size={15} /></button>
          <button type="button" onClick={() => { const instance = pdfViewer.current; if (instance) { instance.pagesRotation = (instance.pagesRotation + 90) % 360; } }} title="Повернуть" aria-label="Повернуть"><RotateCw size={15} /></button>
          <button type="button" className={view.dark ? "is-on" : undefined} aria-pressed={view.dark} onClick={() => setView({ ...view, dark: !view.dark })} title="Тёмные страницы" aria-label="Тёмные страницы"><Moon size={15} /></button>
          <button type="button" className={findOpen ? "is-on" : undefined} aria-pressed={findOpen} onClick={() => { setFindOpen(!findOpen); window.setTimeout(() => findInput.current?.focus(), 0); }} title="Поиск (Ctrl+F)" aria-label="Поиск"><Search size={15} /></button>
        </div>
        {onSave && (
          <div className="wb-viewer-group">
            {toolButton("highlight", Highlighter, "Выделить текст")}
            {toolButton("text", Type, "Добавить текст")}
            {toolButton("ink", Pencil, "Рисовать")}
            {tool !== "none" && (
              <span className="wb-viewer-swatches" role="radiogroup" aria-label="Цвет">
                {MARK_COLORS.map((item) => <button key={item} type="button" role="radio" aria-checked={color === item} className={color === item ? "is-on" : undefined} style={{ ["--swatch" as string]: item }} onClick={() => setColor(item)} aria-label={`Цвет ${item}`} />)}
              </span>
            )}
            <button type="button" onClick={() => editAction("undo")} title="Отменить" aria-label="Отменить"><Undo2 size={15} /></button>
            <button type="button" onClick={() => editAction("redo")} title="Повторить" aria-label="Повторить"><Redo2 size={15} /></button>
          </div>
        )}
        <div className="wb-viewer-group is-end">
          {onDownload && <button type="button" onClick={onDownload} title="Скачать" aria-label="Скачать"><Download size={15} /></button>}
          {onSave && <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} />{saving ? "Сохраняю…" : dirty ? "Сохранить" : "Сохранено"}</button>}
        </div>
      </div>
      {findOpen && (
        <div className="wb-viewer-find" role="search">
          <input ref={findInput} value={query} placeholder="Найти в документе" aria-label="Найти в документе" onChange={(event) => { setQuery(event.target.value); runFind(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") runFind(query, event.shiftKey, true); }} />
          <span className="wb-viewer-count">{query && matches ? (matches.total ? `${matches.current} из ${matches.total}` : "нет совпадений") : ""}</span>
          <button type="button" onClick={() => runFind(query, true, true)} aria-label="Предыдущее"><ChevronUp size={14} /></button>
          <button type="button" onClick={() => runFind(query, false, true)} aria-label="Следующее"><ChevronDown size={14} /></button>
          <button type="button" onClick={() => { setFindOpen(false); runFind("", false); }} aria-label="Закрыть поиск"><X size={14} /></button>
        </div>
      )}
      <div className="wb-viewer-body">
        {view.sidebar && doc && <Thumbnails doc={doc} page={page} onPick={(number) => { if (pdfViewer.current) pdfViewer.current.currentPageNumber = number; }} />}
        <div className="wb-pdf-stage">
          <div className="wb-pdf-scroll" ref={containerRef} tabIndex={0}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
        </div>
        {loading && <div className="wb-viewer-state" role="status" aria-live="polite">Открываю {name}…</div>}
        {error && <div className="wb-viewer-state is-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

function Thumbnails({ doc, page, onPick }: { doc: Doc; page: number; onPick: (page: number) => void }) {
  const numbers = useMemo(() => Array.from({ length: doc.numPages }, (_, index) => index + 1), [doc]);
  return (
    <nav className="wb-pdf-thumbs" aria-label="Страницы">
      {numbers.map((number) => <Thumb key={number} doc={doc} number={number} active={number === page} onPick={onPick} />)}
    </nav>
  );
}

function Thumb({ doc, number, active, onPick }: { doc: Doc; number: number; active: boolean; onPick: (page: number) => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [ratio, setRatio] = useState(1.4);
  useEffect(() => {
    const button = ref.current;
    if (!button) return;
    let task: { cancel: () => void } | null = null;
    let done = false;
    const observer = new IntersectionObserver(async (entries) => {
      if (done || !entries.some((entry) => entry.isIntersecting)) return;
      done = true;
      observer.disconnect();
      try {
        const pdfPage = await doc.getPage(number);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: (112 * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
        setRatio(base.height / base.width);
        const target = canvas.current;
        if (!target) return;
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        const render = pdfPage.render({ canvas: target, viewport });
        task = render;
        await render.promise;
      } catch { /* миниатюра необязательна */ }
    }, { rootMargin: "300px" });
    observer.observe(button);
    return () => { observer.disconnect(); task?.cancel(); };
  }, [doc, number]);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: "nearest" }); }, [active]);
  return (
    <button type="button" ref={ref} className={active ? "wb-pdf-thumb is-active" : "wb-pdf-thumb"} onClick={() => onPick(number)} aria-label={`Страница ${number}`} aria-current={active ? "page" : undefined}>
      <canvas ref={canvas} style={{ aspectRatio: `1 / ${ratio}` }} />
      <span>{number}</span>
    </button>
  );
}
