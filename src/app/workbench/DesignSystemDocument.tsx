import { useCallback, useEffect, useRef, useState } from "react";
import { Code2, Download, Eye, Monitor, Pencil, Save, Smartphone, Trash2, Zap } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { askConfirm, askText } from "../../ui/askText";
import { CodeEditor } from "./CodeEditor";
import { DocShell } from "./docLayout";
import { DESIGN_TAB, rememberDesignSystem, type DesignSystemRecord } from "./designSystemsStore";
import type { TabsApi } from "./tabs";

type Mode = "preview" | "code";

/**
 * Дизайн-система во вкладке: страница HTML в изолированной рамке. Скрипты в рамке выключены, пока человек не включит их
 * сам: система — это стили и разметка, а чужой скрипт на странице бренда не нужен. Рамка без allow-same-origin: страница не видит
 * ни cookie MBOX, ни его DOM. Агент правит ту же страницу через MCP, вкладка подхватывает правку сама, если у человека нет черновика.
 */
export function DesignSystemDocument({ designId, tabs, tabKey, visible, onDirty }: {
  designId: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const [record, setRecord] = useState<DesignSystemRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("preview");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [scripts, setScripts] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const dirty = Boolean(record) && draft !== (record?.html ?? "");
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, onDirty, tabKey]);
  useEffect(() => () => onDirty(tabKey, false), [onDirty, tabKey]);

  const load = useCallback(async () => {
    setError("");
    try {
      const { design_system: item } = await fetchJson<{ design_system: DesignSystemRecord }>(`/api/mbox/design-systems/${designId}`);
      rememberDesignSystem(item);
      setRecord(item);
      setDraft(item.html ?? "");
      setStale(false);
    } catch (cause) {
      setError(/404|not_found/.test(String(cause)) ? "Дизайн-система не найдена — возможно, её удалили." : "Не удалось загрузить дизайн-систему.");
    }
  }, [designId]);

  useEffect(() => { void load(); }, [load]);

  // Агент или другой человек поменял страницу: без черновика перечитываем сами, с черновиком — предлагаем.
  useEffect(() => {
    const onChanged = (event: Event) => {
      if (String((event as CustomEvent<string>).detail || "") !== "design_systems") return;
      fetchJson<{ design_system: DesignSystemRecord }>(`/api/mbox/design-systems/${designId}?meta=1`).then(({ design_system: meta }) => {
        setRecord((current) => {
          if (!current || meta.updated_at === current.updated_at) return current;
          if (dirtyRef.current) { setStale(true); return current; }
          void load();
          return current;
        });
      }).catch(() => {});
    };
    window.addEventListener(ENTITY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ENTITY_CHANGED_EVENT, onChanged);
  }, [designId, load]);

  const save = useCallback(async () => {
    if (!record || saving || !dirty) return;
    setSaving(true);
    setError("");
    try {
      const { design_system: next } = await fetchJson<{ design_system: DesignSystemRecord }>(`/api/mbox/design-systems/${designId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: draft, base_updated_at: record.updated_at }),
      });
      setRecord({ ...record, ...next, html: draft });
      rememberDesignSystem(next);
      tabs.pin(tabKey);
    } catch (cause) {
      setError(/409|conflict/.test(String(cause)) ? "Страницу успели изменить в другом месте. Обновите её и повторите правку." : "Не сохранилось.");
      if (/409|conflict/.test(String(cause))) setStale(true);
    } finally {
      setSaving(false);
    }
  }, [designId, dirty, draft, record, saving, tabKey, tabs]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, visible]);

  async function rename() {
    if (!record) return;
    const title = (await askText({ title: "Название дизайн-системы", value: record.title, confirmLabel: "Переименовать" }))?.trim().slice(0, 200);
    if (!title || title === record.title) return;
    const { design_system: next } = await fetchJson<{ design_system: DesignSystemRecord }>(`/api/mbox/design-systems/${designId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    rememberDesignSystem(next);
    setRecord({ ...record, title: next.title, updated_at: next.updated_at });
  }

  async function remove() {
    if (!record) return;
    if (!(await askConfirm({ title: `Удалить дизайн-систему «${record.title}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/design-systems/${designId}`, { method: "DELETE" });
    tabs.close(tabKey);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([draft], { type: "text/html" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(record?.title || "design-system").replace(/[\\/:*?"<>|]+/g, "-")}.html`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!record) {
    return <div className="wb-doc-missing">{error || <OctopusSpinner label="Загружаю дизайн-систему…" />}</div>;
  }

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">
            Дизайн-системы › <b>{record.title || "Дизайн-система"}</b>{dirty && <b className="wb-dirty-mark"> ●</b>}
          </span>
          <div className="wb-doc-actions">
            <div className="wb-segmented">
              <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => setMode("preview")}><Eye size={13} /> Просмотр</button>
              <button type="button" className={mode === "code" ? "is-on" : undefined} onClick={() => setMode("code")}><Code2 size={13} /> HTML</button>
            </div>
            {mode === "preview" && (
              <>
                <div className="wb-segmented">
                  <button type="button" className={viewport === "desktop" ? "is-on" : undefined} onClick={() => setViewport("desktop")} title="Ширина ПК" aria-label="Ширина ПК"><Monitor size={13} /></button>
                  <button type="button" className={viewport === "mobile" ? "is-on" : undefined} onClick={() => setViewport("mobile")} title="Ширина телефона" aria-label="Ширина телефона"><Smartphone size={13} /></button>
                </div>
                <button type="button" className={scripts ? "is-on" : undefined} onClick={() => setScripts((value) => !value)} aria-pressed={scripts} title={scripts ? "Скрипты страницы включены. Выключить" : "Скрипты страницы выключены. Включить для интерактивных примеров"}><Zap size={14} /></button>
              </>
            )}
            <button type="button" onClick={() => void rename()} title="Переименовать" aria-label="Переименовать"><Pencil size={14} /></button>
            <button type="button" onClick={download} title="Скачать .html" aria-label="Скачать .html"><Download size={14} /></button>
            {record.is_owner !== false && <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить" aria-label="Удалить"><Trash2 size={14} /></button>}
            <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>
          </div>
        </>
      )}
    >
      {error && <div className="wb-banner is-error" role="alert">{error}</div>}
      {stale && <div className="wb-banner" role="status">Страницу изменили в другом месте. <button type="button" onClick={() => { if (!dirty || window.confirm("Несохранённая правка пропадёт. Обновить страницу?")) void load(); }}>Обновить</button></div>}
      {mode === "preview" ? (
        <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
          <iframe title={record.title || "Дизайн-система"} sandbox={scripts ? "allow-scripts" : ""} srcDoc={draft} />
        </div>
      ) : (
        <CodeEditor value={draft} onChange={setDraft} language="html" placeholder="HTML дизайн-системы" />
      )}
    </DocShell>
  );
}

export const isDesignTab = (key: string) => key.startsWith(DESIGN_TAB);
