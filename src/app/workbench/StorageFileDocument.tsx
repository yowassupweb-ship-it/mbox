import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Download, Eye, Pencil, RefreshCw, Save } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { uploadToStorage } from "../../lib/storageUpload";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { CodeEditor } from "./CodeEditor";
import { languageOf } from "./codeHighlight";
import { DocShell } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import { STORAGE_FILE_TAB, notifyStorageChanged, storageLink } from "./storageApi";
import type { TabsApi } from "./tabs";
import { ImportOffer, projectOfStorageKey } from "./ImportOffer";

const StorageImage = lazy(() => import("./StorageImage"));
const PdfViewer = lazy(() => import("./PdfViewer"));
const UniverDocumentViewer = lazy(() => import("./UniverDocumentViewer").then((module) => ({ default: module.UniverDocumentViewer })));

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const EDITABLE_IMAGE = /\.(png|jpe?g|webp)$/i;
const PDF = /\.pdf$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|opus|aac|m4a|flac)$/i;
const WORD = /\.docx$/i;
const TEXT = /\.(txt|md|mdx|markdown|json|ya?ml|xml|csv|tsv|log|css|scss|html?|js|jsx|ts|tsx|mjs|cjs|py|sql|sh|ps1|ini|toml|env|conf)$/i;
const MARKDOWN = /\.(md|mdx|markdown)$/i;
const TEXT_LIMIT = 2 * 1024 * 1024;

/** Файл хранилища, который открывается во вкладке приложения (таблицы — отдельным редактором). */
export const isOpenableInApp = (name: string) => IMAGE.test(name) || PDF.test(name) || VIDEO.test(name) || AUDIO.test(name) || WORD.test(name) || TEXT.test(name);

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const nameOf = (key: string) => key.split("/").pop() || key;

/**
 * Файл из S3 во вкладке: картинка (с правкой), PDF (с пометками), видео и звук, Word (просмотр), текст и код (правка).
 * Всё сохраняется обратно в тот же ключ обычной загрузкой; участнику доступны только папки его проектов.
 */
export function StorageFileDocument({ storageKey, tabs, tabKey, visible, onDirty }: {
  storageKey: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const name = nameOf(storageKey);
  const source = `/api/mbox/storage/file?key=${encodeURIComponent(storageKey)}`;
  const kind = IMAGE.test(name) ? "image" : PDF.test(name) ? "pdf" : VIDEO.test(name) ? "video" : AUDIO.test(name) ? "audio" : WORD.test(name) ? "word" : TEXT.test(name) ? "text" : "other";
  const [version, setVersion] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [wordHtml, setWordHtml] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(MARKDOWN.test(name));
  const dirty = kind === "text" && text !== null && text !== saved;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, onDirty, tabKey]);
  useEffect(() => () => onDirty(tabKey, false), [onDirty, tabKey]);

  const load = useCallback(async () => {
    if (kind !== "text" && kind !== "word") return;
    setError("");
    try {
      const response = await fetch(`${source}&v=${version}`);
      if (!response.ok) throw new Error(`Хранилище ответило ${response.status}`);
      if (kind === "text") {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > TEXT_LIMIT) throw new Error(`Файл ${formatBytes(buffer.byteLength)} — слишком большой для встроенного редактора. Скачайте его.`);
        const value = new TextDecoder("utf-8").decode(buffer);
        setText(value);
        setSaved(value);
      } else {
        const mammoth = await import("mammoth");
        const converted = await mammoth.convertToHtml({ arrayBuffer: await response.arrayBuffer() });
        setWordHtml(DOMPurify.sanitize(converted.value, { USE_PROFILES: { html: true } }));
      }
    } catch (cause) {
      setError(cleanError(cause));
    }
  }, [kind, source, version]);

  useEffect(() => { void load(); }, [load]);

  async function upload(blob: Blob) {
    await uploadToStorage(storageKey, blob);
    notifyStorageChanged("tree");
    tabs.pin(tabKey);
    setVersion((value) => value + 1);
  }

  async function saveText() {
    if (text === null || saving) return;
    setSaving(true);
    setError("");
    try {
      await uploadToStorage(storageKey, new Blob([text], { type: MARKDOWN.test(name) ? "text/markdown" : "text/plain" }));
      setSaved(text);
      notifyStorageChanged("tree");
      tabs.pin(tabKey);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!visible || kind !== "text") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveText(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function download() {
    try {
      const anchor = document.createElement("a");
      anchor.href = await storageLink(storageKey, true);
      anchor.download = name;
      anchor.rel = "noopener";
      anchor.click();
    } catch (cause) {
      setError(cleanError(cause));
    }
  }

  const language = useMemo(() => languageOf(name), [name]);

  function reload() {
    if (dirtyRef.current && !window.confirm("Несохранённые правки пропадут. Перечитать файл?")) return;
    setVersion((value) => value + 1);
  }

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Хранилище › {storageKey.split("/").join(" › ")}{dirty && <b className="wb-dirty-mark"> ●</b>}</span>
          <div className="wb-doc-actions">
            {kind === "text" && MARKDOWN.test(name) && (
              <button type="button" onClick={() => setPreview((value) => !value)} title={preview ? "Править текст" : "Показать оформление"}>
                {preview ? <Pencil size={14} /> : <Eye size={14} />} {preview ? "Править" : "Просмотр"}
              </button>
            )}
            <button type="button" onClick={reload} title="Перечитать из хранилища" aria-label="Перечитать из хранилища"><RefreshCw size={14} /></button>
            <button type="button" onClick={() => void download()} title="Скачать"><Download size={14} /> Скачать</button>
            {kind === "text" && <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void saveText()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>}
          </div>
        </>
      )}
    >
      {error && <div className="wb-banner is-error" role="alert">{error}</div>}
      <ImportOffer id={tabKey} name={name} tabs={tabs} projectId={projectOfStorageKey(storageKey)} load={async () => {
        if (kind === "text" && text !== null) return new Blob([text], { type: "text/plain" });
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Хранилище ответило ${response.status}`);
        return response.blob();
      }} />
      {kind === "image" && (
        <Suspense fallback={<OctopusSpinner />}>
          <StorageImage src={source} name={name} version={version} onSave={EDITABLE_IMAGE.test(name) ? upload : undefined} onDownload={() => void download()} />
        </Suspense>
      )}
      {kind === "pdf" && (
        <Suspense fallback={<OctopusSpinner />}>
          <PdfViewer source={{ url: source }} version={`${storageKey}:${version}`} name={name} memoryKey={`s3:${storageKey}`} onSave={(bytes) => upload(new Blob([bytes as BlobPart], { type: "application/pdf" }))} onDownload={() => void download()} />
        </Suspense>
      )}
      {kind === "video" && <video className="wb-storage-preview-media" src={source} controls playsInline preload="metadata" />}
      {kind === "audio" && <audio className="wb-storage-preview-audio" src={source} controls preload="metadata" />}
      {kind === "word" && (wordHtml
        ? <div className="wb-office-scroll"><article className="wb-docx-page is-univer-document"><Suspense fallback={<OctopusSpinner />}><UniverDocumentViewer html={wordHtml} title={name} /></Suspense></article></div>
        : !error && <OctopusSpinner />)}
      {kind === "text" && (text === null
        ? (!error && <OctopusSpinner />)
        : preview && MARKDOWN.test(name)
          ? <article className="wb-doc-preview">{renderDocument(text)}</article>
          : <CodeEditor value={text} onChange={setText} language={language} />)}
      {kind === "other" && <div className="wb-doc-missing">Для этого формата нет встроенного просмотра. Файл можно скачать.</div>}
    </DocShell>
  );
}
