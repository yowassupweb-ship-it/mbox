import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FileText, Pencil, Sun } from "lucide-react";
import { base64ToArrayBuffer } from "../app/workbench/officeFormat";
import { OctopusSpinner } from "../components/OctopusSpinner";
import { fetchJson } from "../lib/api";

const UniverDocumentEditor = lazy(() => import("../app/workbench/UniverDocumentEditor").then((module) => ({ default: module.UniverDocumentEditor })));
const UNIVER_DOCUMENT_MIME = "application/vnd.mbox.univer-doc+json";

type SharedDocument = { id: string; title: string; content: string; mime_type: string; updated_at: string };

export function SharedDocumentPage({ token }: { token: string }) {
  const [document, setDocument] = useState<SharedDocument | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [source, setSource] = useState<{ text: string; snapshot: Record<string, unknown> | null }>({ text: "", snapshot: null });
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "graphite">("graphite");
  const pending = useRef(0);
  useEffect(() => {
    let alive = true;
    void fetchJson<{ mode: "view" | "edit"; document: SharedDocument }>(`/api/share/documents/${token}`).then(async (result) => {
      if (!alive) return;
      setMode(result.mode);
      setDocument(result.document);
      if (result.document.mime_type === UNIVER_DOCUMENT_MIME) {
        try { setSource({ text: "", snapshot: JSON.parse(result.document.content) as Record<string, unknown> }); } catch { setSource({ text: "", snapshot: null }); }
      } else if (result.document.mime_type === "text/html" || result.document.mime_type === "text/plain") {
        const text = result.document.mime_type === "text/html"
          ? new DOMParser().parseFromString(result.document.content, "text/html").body.innerText
          : result.document.content;
        if (alive) setSource({ text, snapshot: null });
      } else {
        const mammoth = await import("mammoth");
        const html = (await mammoth.convertToHtml({ arrayBuffer: base64ToArrayBuffer(result.document.content) })).value;
        if (alive) setSource({ text: new DOMParser().parseFromString(html, "text/html").body.innerText, snapshot: null });
      }
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [token]);
  const save = useCallback((snapshot: Record<string, unknown>) => {
    if (mode !== "edit" || !document) return;
    const revision = ++pending.current;
    void fetchJson<{ document: SharedDocument }>(`/api/share/documents/${token}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: JSON.stringify(snapshot), mime_type: UNIVER_DOCUMENT_MIME, title: document.title }) }).then(({ document: updated }) => {
      if (revision === pending.current) setDocument(updated);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [document, mode, token]);
  if (error && !document) return <main className="share-page"><div className="share-error"><AlertCircle size={18} />{error}</div></main>;
  if (!document) return <main className="share-page"><OctopusSpinner label="Открываю документ…" /></main>;
  return <main className={`share-page shared-document theme-${theme}`} data-theme={theme}>
    <header className="share-top"><span><FileText size={16} />{document.title}</span><div><button type="button" onClick={() => setTheme((value) => value === "light" ? "graphite" : "light")} title="Сменить тему"><Sun size={15} /></button><span className="share-mode">{mode === "edit" ? <><Pencil size={13} /> Можно редактировать</> : <><Check size={13} /> Только просмотр</>}</span></div></header>
    {error && <div className="share-error"><AlertCircle size={15} />{error}</div>}
    <div className="shared-document-editor"><Suspense fallback={<OctopusSpinner />}><UniverDocumentEditor title={document.title} text={source.text} snapshot={source.snapshot} readOnly={mode !== "edit"} onChange={save} /></Suspense></div>
  </main>;
}
