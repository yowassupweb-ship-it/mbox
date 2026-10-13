import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { markOverlay } from "../app/workbench/BrowserDocument";
import { ApiError, fetchJson } from "../lib/api";
import { uploadToStorage } from "../lib/storageUpload";

type Severity = "low" | "normal" | "high";
type BugOptions = {
  projects: Array<{ id: string; name: string }>;
  defaultProjectId?: string;
  /** Вкладка, на которой человек увидел проблему: уходит в отчёт вместе с адресом и версией приложения. */
  tabTitle?: string;
  /** Снимок окна, сделанный до открытия диалога (data:image/…): прикладывается сам, его можно убрать. */
  initialShot?: string;
};
export type BugResult = { id: string; title: string };
type Shot = { id: string; name: string; url: string; blob: Blob };

const SEVERITIES: Array<{ id: Severity; label: string }> = [
  { id: "low", label: "Мелкая" },
  { id: "normal", label: "Обычная" },
  { id: "high", label: "Критичная" },
];
const MAX_SHOTS = 4;
const MAX_SHOT_BYTES = 10 * 1024 * 1024;

/** Диалог «Сообщить о проблеме»: записывает отчёт в память проекта (POST /api/mbox/bug-reports). null — закрыли без записи. */
export function askBugReport(options: BugOptions): Promise<BugResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    (document.querySelector(".wb") ?? document.body).append(host);
    const root = createRoot(host);
    const done = (value: BugResult | null) => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(<BugDialog {...options} onDone={done} />);
  });
}

function appInfo() {
  const desktop = navigator.userAgent.match(/MBOXDesktop\/[\d.]+/)?.[0];
  return desktop ? desktop.replace("/", " ") : "web";
}

const extensionOf = (blob: Blob) => (blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : "png");

async function shotFromDataUrl(url: string, name: string): Promise<Shot | null> {
  try {
    const blob = await (await fetch(url)).blob();
    return { id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, url, blob };
  } catch {
    return null;
  }
}

function BugDialog({ projects, defaultProjectId, tabTitle, initialShot, onDone }: BugOptions & { onDone: (value: BugResult | null) => void }) {
  const fallbackProject = projects.find((project) => project.id === defaultProjectId) || projects.find((project) => project.name === "MBOX") || projects[0];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("normal");
  const [projectId, setProjectId] = useState(fallbackProject?.id || "");
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Диалог рисуется поверх документа — страница встроенного браузера на это время убирается.
  useEffect(() => {
    markOverlay(true);
    return () => markOverlay(false);
  }, []);
  useEffect(() => { titleRef.current?.focus(); }, []);

  // Снимок окна, сделанный до открытия диалога, прикладывается сам.
  useEffect(() => {
    if (!initialShot) return;
    let alive = true;
    void shotFromDataUrl(initialShot, "Снимок окна").then((shot) => { if (alive && shot) setShots((current) => (current.length ? current : [shot])); });
    return () => { alive = false; };
  }, [initialShot]);

  function addFiles(files: Iterable<File | Blob>) {
    const next: Shot[] = [];
    let skipped = "";
    for (const file of files) {
      if (!file.type.startsWith("image/")) { skipped = "Можно приложить только картинки."; continue; }
      if (file.size > MAX_SHOT_BYTES) { skipped = "Картинка больше 10 МБ."; continue; }
      const name = file instanceof File && file.name ? file.name : `Скриншот ${shots.length + next.length + 1}`;
      next.push({ id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, url: URL.createObjectURL(file), blob: file });
    }
    setShots((current) => {
      const merged = [...current, ...next].slice(0, MAX_SHOTS);
      if (current.length + next.length > MAX_SHOTS) skipped = `Не больше ${MAX_SHOTS} картинок.`;
      return merged;
    });
    setError(skipped);
  }

  function onPaste(event: ClipboardEvent) {
    const images = [...event.clipboardData.items].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function submit() {
    if (busy) return;
    if (!title.trim()) { setError("Коротко назовите проблему"); return; }
    if (!description.trim()) { setError("Опишите, что пошло не так"); return; }
    if (!projectId) { setError("Выберите проект: отчёт хранится в его памяти"); return; }
    setBusy(true);
    try {
      // Картинки сначала уходят в хранилище проекта, в отчёте остаются их ключи.
      const stamp = Date.now();
      const attachments: Array<{ key: string; name: string }> = [];
      for (const [index, shot] of shots.entries()) {
        const key = `projects/${projectId}/bug-reports/${stamp}-${index + 1}.${extensionOf(shot.blob)}`;
        try {
          await uploadToStorage(key, shot.blob);
        } catch (cause) {
          setError(`Не удалось загрузить «${shot.name}»: ${cause instanceof Error ? cause.message : "хранилище недоступно"}. Уберите картинку или повторите.`);
          setBusy(false);
          return;
        }
        attachments.push({ key, name: shot.name });
      }
      const result = await fetchJson<{ memory: { id: string }; title: string }>("/api/mbox/bug-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title, description, severity, project_id: projectId, source: "ui", attachments,
          context: { tab: tabTitle || "", url: window.location.href, app: appInfo(), viewport: `${window.innerWidth}x${window.innerHeight}` },
        }),
      });
      for (const shot of shots) if (shot.url.startsWith("blob:")) URL.revokeObjectURL(shot.url);
      onDone({ id: result.memory.id, title: result.title });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "project_access_denied" ? "Нет доступа к этому проекту" : "Не удалось записать отчёт. Проверьте связь и повторите");
      setBusy(false);
    }
  }

  return (
    <div className="ask-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}>
      <form
        className={`ask-dialog bug-dialog${dragging ? " is-dragging" : ""}`}
        role="dialog"
        aria-label="Сообщить о проблеме"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDone(null); } }}
        onPaste={onPaste}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={onDrop}
      >
        <label className="ask-title" htmlFor="bug-title">Сообщить о проблеме</label>
        <input id="bug-title" ref={titleRef} value={title} placeholder="Что не работает" maxLength={200} onChange={(event) => { setTitle(event.target.value); setError(""); }} />
        <textarea aria-label="Что пошло не так" value={description} placeholder="Что вы делали, что ожидали и что получилось. Текст ошибки, если он был." rows={6} onChange={(event) => { setDescription(event.target.value); setError(""); }} />
        <div className="bug-shots">
          {shots.map((shot) => (
            <figure className="bug-shot" key={shot.id} title={shot.name}>
              <img src={shot.url} alt={shot.name} />
              <button type="button" aria-label={`Убрать ${shot.name}`} onClick={() => setShots((current) => current.filter((item) => item.id !== shot.id))}><X size={12} /></button>
            </figure>
          ))}
          {shots.length < MAX_SHOTS && (
            <button type="button" className="bug-attach" onClick={() => fileRef.current?.click()}><ImagePlus size={15} aria-hidden="true" /><span>{shots.length ? "Ещё" : "Приложить скриншот"}</span></button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addFiles(event.target.files ?? []); event.target.value = ""; }} />
        </div>
        <div className="bug-row">
          <div className="bug-severity" role="group" aria-label="Важность">
            {SEVERITIES.map((item) => (
              <button key={item.id} type="button" className={severity === item.id ? `is-on is-${item.id}` : undefined} aria-pressed={severity === item.id} onClick={() => setSeverity(item.id)}>{item.label}</button>
            ))}
          </div>
          <select aria-label="Проект" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div className={error ? "ask-hint is-error" : "ask-hint"}>{error || `Запись попадёт в память проекта. Вставьте скриншот через Ctrl+V или перетащите картинку сюда. К записи приложатся вкладка${tabTitle ? ` «${tabTitle}»` : ""}, адрес страницы и версия приложения.`}</div>
        <div className="ask-actions">
          <button type="button" onClick={() => onDone(null)}>Отмена</button>
          <button type="submit" className="is-primary" disabled={busy}>{busy ? "Записываю…" : "Записать"}</button>
        </div>
      </form>
    </div>
  );
}
