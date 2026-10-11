import { useEffect, useRef, useState } from "react";
import { LayoutTemplate, Pencil, Pin, PinOff, Plus, Presentation, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { askConfirm, askText } from "../../ui/askText";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { WbMenu } from "./WbMenu";
import type { TabsApi } from "./tabs";
import { SheetsDocsSwitch, type SheetsDocsMode } from "./DocumentsView";
import { SLIDES_TAB, createPresentationAndOpen, emitPresentations, patchPresentation, presentationsStore, refreshPresentations, type PresentationRecord } from "./presentationsStore";

function slidesLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  return `${count} ${mod10 === 1 && mod100 !== 11 ? "слайд" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "слайда" : "слайдов"}`;
}

/**
 * Презентации рядом с таблицами и документами. Новая презентация — пустая или из шаблона: любую готовую можно
 * сделать шаблоном, и агент начинает новые в её стиле.
 */
export function PresentationsView({ tabs, defaultProjectId = null, onOpen, mode, onMode }: { tabs: TabsApi; defaultProjectId?: string | null; onOpen?: () => void; mode: SheetsDocsMode; onMode: (mode: SheetsDocsMode) => void }) {
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(presentationsStore.query);
  const [notice, setNotice] = useState("");
  const [context, setContext] = useState<{ item: PresentationRecord; x: number; y: number } | null>(null);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const canCreate = defaultProjectId !== undefined;
  const importRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState("");

  /** PDF → новая презентация: страницы становятся слайдами, текст страниц — заметками докладчика. */
  async function importPdf(file: File | undefined) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { setNotice("Нужен файл .pdf"); return; }
    setImporting("Читаю PDF…");
    setNotice("");
    try {
      const { pdfToDeck } = await import("./slides/importPdf");
      // Сначала пустая презентация (нужен её номер для картинок), потом страницы по одной, в конце — короткий JSON со ссылками.
      const { presentation: created } = await fetchJson<{ presentation: PresentationRecord }>("/api/mbox/presentations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: file.name.replace(/\.pdf$/i, ""), project_id: defaultProjectId ?? null }),
      });
      const upload = async (dataUrl: string) => (await fetchJson<{ url: string }>(`/api/mbox/presentations/${created.id}/assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data_url: dataUrl }),
      })).url;
      const deck = await pdfToDeck(file, upload, (done, total) => setImporting(`Страница ${done} из ${total}…`));
      setImporting("Сохраняю…");
      const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: JSON.stringify(deck), title: file.name.replace(/\.pdf$/i, "") }),
      });
      patchPresentation(presentation);
      tabs.open(`${SLIDES_TAB}${presentation.id}`, true);
      onOpen?.();
    } catch (cause) {
      setNotice(cause instanceof Error && /too_large|413/.test(cause.message) ? "PDF слишком большой для презентации — разделите его на части." : "Не удалось импортировать PDF.");
    } finally {
      setImporting("");
      if (importRef.current) importRef.current.value = "";
    }
  }

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    presentationsStore.listeners.add(rerender);
    return () => { presentationsStore.listeners.delete(rerender); };
  }, []);

  useEffect(() => {
    presentationsStore.query = query;
    const timer = window.setTimeout(() => void refreshPresentations(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function create(templateId: string | null = null) {
    setPicker(null);
    try { await createPresentationAndOpen(tabs, defaultProjectId ?? null, templateId); onOpen?.(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function patch(item: PresentationRecord, body: Record<string, unknown>) {
    const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    patchPresentation(presentation);
  }

  async function rename(item: PresentationRecord) {
    const title = await askText({ title: "Название презентации", value: item.title, confirmLabel: "Переименовать" });
    const next = title?.trim().slice(0, 200);
    if (next && next !== item.title) await patch(item, { title: next });
  }

  async function remove(item: PresentationRecord) {
    if (!(await askConfirm({ title: `Удалить презентацию «${item.title || "Презентация"}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/presentations/${item.id}`, { method: "DELETE" });
    presentationsStore.list = presentationsStore.list.filter((entry) => entry.id !== item.id);
    emitPresentations();
    tabs.close(`${SLIDES_TAB}${item.id}`);
  }

  const templates = presentationsStore.list.filter((item) => item.is_template);
  const pinned = presentationsStore.list.filter((item) => item.pinned);
  const rest = presentationsStore.list.filter((item) => !item.pinned);

  function renderItem(item: PresentationRecord) {
    const key = `${SLIDES_TAB}${item.id}`;
    return (
      <div key={item.id} className={tabs.active === key ? "wb-table-item is-active" : "wb-table-item"} onContextMenu={(event) => { event.preventDefault(); setContext({ item, x: event.clientX, y: event.clientY }); }}>
        <button type="button" className="wb-table-open" onClick={() => { tabs.open(key); onOpen?.(); }} onDoubleClick={() => { tabs.open(key, true); onOpen?.(); }} title={`Открыть презентацию «${item.title || "Презентация"}»`}>
          <span className="wb-table-glyph" aria-hidden="true">{item.is_template ? <LayoutTemplate size={16} /> : <Presentation size={16} />}</span>
          <span className="wb-table-copy">
            <span className="wb-table-title">{item.title || "Презентация"}</span>
            <span className="wb-table-details"><span>{formatSince(item.updated_at)}</span><span aria-hidden="true">·</span><span>{slidesLabel(item.slide_count || 1)}</span>{item.is_template && <><span aria-hidden="true">·</span><span>шаблон</span></>}</span>
            {query && item.snippet && <span className="wb-table-snippet">{item.snippet}</span>}
          </span>
        </button>
        <button type="button" className={item.pinned ? "wb-table-pin is-on" : "wb-table-pin"} onClick={() => void patch(item, { pinned: !item.pinned })} aria-label={item.pinned ? "Открепить" : "Закрепить сверху"} title={item.pinned ? "Открепить" : "Закрепить сверху"}>
          {item.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="wb-view wb-tables-view">
      <header className="wb-view-head">
        <span className="wb-tables-heading">Рабочее пространство</span>
        <div className="wb-view-actions">
          <button type="button" disabled={!canCreate || Boolean(importing)} onClick={() => importRef.current?.click()} title={canCreate ? "Импорт из PDF: каждая страница станет слайдом" : "Нет доступных проектов"} aria-label="Импорт из PDF"><Upload size={14} /></button>
          <input ref={importRef} type="file" accept=".pdf,application/pdf" hidden onChange={(event) => void importPdf(event.target.files?.[0])} />
          <button type="button" disabled={!canCreate} onClick={(event) => (templates.length ? setPicker({ x: event.clientX, y: event.clientY }) : void create())} title={canCreate ? "Новая презентация" : "Нет доступных проектов"} aria-label="Новая презентация"><Plus size={14} /></button>
        </div>
      </header>
      <SheetsDocsSwitch mode={mode} onMode={onMode} count={presentationsStore.list.length} />
      <div className="wb-filter">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в презентациях" aria-label="Найти в презентациях" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      {importing && <div className="wb-files-notice" role="status">{importing}</div>}
      {notice && <div className="wb-files-notice" role="alert">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      <div className="wb-view-body">
        {pinned.length > 0 && <div className="wb-menu-group-head is-static">Закреплённые</div>}
        {pinned.map(renderItem)}
        {pinned.length > 0 && rest.length > 0 && <div className="wb-menu-group-head is-static">Остальные</div>}
        {rest.map(renderItem)}
        {presentationsStore.loading && !presentationsStore.list.length && <OctopusSpinner label={query ? "Ищу в презентациях…" : "Загружаю презентации…"} />}
        {!presentationsStore.loading && presentationsStore.failed && !presentationsStore.list.length && (
          <div className="wb-session-empty">
            <p>Не удалось загрузить презентации.</p>
            <button type="button" onClick={() => void refreshPresentations()}><RefreshCw size={13} /> Повторить</button>
          </div>
        )}
        {!presentationsStore.loading && !presentationsStore.failed && !presentationsStore.list.length && (
          <div className="wb-session-empty">
            <p>{query ? "Ничего не нашлось." : "Презентаций пока нет. Создайте сами или попросите агента — он работает с ней у вас на глазах."}</p>
            {!query && <button type="button" disabled={!canCreate} onClick={() => void create()}><Plus size={13} /> Новая презентация</button>}
          </div>
        )}
      </div>
      {picker && (
        <WbMenu x={picker.x} y={picker.y} onClose={() => setPicker(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => void create()}><span><Presentation size={14} />Пустая презентация</span></button>
            <div className="wb-menu-sep" role="separator" />
            {templates.map((item) => (
              <button key={item.id} type="button" role="menuitem" onClick={() => void create(item.id)}><span><LayoutTemplate size={14} />По шаблону «{item.title || "Презентация"}»</span></button>
            ))}
          </div>
        </WbMenu>
      )}
      {context && (
        <WbMenu x={context.x} y={context.y} onClose={() => setContext(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => { tabs.open(`${SLIDES_TAB}${context.item.id}`, true); onOpen?.(); setContext(null); }}><span><Presentation size={14} />Открыть</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.item; setContext(null); void rename(selected); }}><span><Pencil size={14} />Переименовать</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.item; setContext(null); void patch(selected, { is_template: !selected.is_template }); }}><span><LayoutTemplate size={14} />{context.item.is_template ? "Больше не шаблон" : "Сделать шаблоном"}</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.item; setContext(null); void create(selected.id); }}><span><Plus size={14} />Новая по образцу этой</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.item; setContext(null); void patch(selected, { pinned: !selected.pinned }); }}><span>{context.item.pinned ? <PinOff size={14} /> : <Pin size={14} />}{context.item.pinned ? "Открепить" : "Закрепить сверху"}</span></button>
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" onClick={() => { const selected = context.item; setContext(null); void remove(selected); }}><span><Trash2 size={14} />Удалить презентацию</span></button>
          </div>
        </WbMenu>
      )}
    </div>
  );
}
