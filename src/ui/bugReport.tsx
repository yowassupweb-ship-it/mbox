import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { markOverlay } from "../app/workbench/BrowserDocument";
import { ApiError, fetchJson } from "../lib/api";

type Severity = "low" | "normal" | "high";
type BugOptions = {
  projects: Array<{ id: string; name: string }>;
  defaultProjectId?: string;
  /** Вкладка, на которой человек увидел проблему: уходит в отчёт вместе с адресом и версией приложения. */
  tabTitle?: string;
};
export type BugResult = { id: string; title: string };

const SEVERITIES: Array<{ id: Severity; label: string }> = [
  { id: "low", label: "Мелкая" },
  { id: "normal", label: "Обычная" },
  { id: "high", label: "Критичная" },
];

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

function BugDialog({ projects, defaultProjectId, tabTitle, onDone }: BugOptions & { onDone: (value: BugResult | null) => void }) {
  const fallbackProject = projects.find((project) => project.id === defaultProjectId) || projects.find((project) => project.name === "MBOX") || projects[0];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("normal");
  const [projectId, setProjectId] = useState(fallbackProject?.id || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Диалог рисуется поверх документа — страница встроенного браузера на это время убирается.
  useEffect(() => {
    markOverlay(true);
    return () => markOverlay(false);
  }, []);
  useEffect(() => { titleRef.current?.focus(); }, []);

  async function submit() {
    if (busy) return;
    if (!title.trim()) { setError("Коротко назовите проблему"); return; }
    if (!description.trim()) { setError("Опишите, что пошло не так"); return; }
    if (!projectId) { setError("Выберите проект: отчёт хранится в его памяти"); return; }
    setBusy(true);
    try {
      const result = await fetchJson<{ memory: { id: string }; title: string }>("/api/mbox/bug-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title, description, severity, project_id: projectId, source: "ui",
          context: { tab: tabTitle || "", url: window.location.href, app: appInfo(), viewport: `${window.innerWidth}x${window.innerHeight}` },
        }),
      });
      onDone({ id: result.memory.id, title: result.title });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "project_access_denied" ? "Нет доступа к этому проекту" : "Не удалось записать отчёт. Проверьте связь и повторите");
      setBusy(false);
    }
  }

  return (
    <div className="ask-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}>
      <form
        className="ask-dialog bug-dialog"
        role="dialog"
        aria-label="Сообщить о проблеме"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDone(null); } }}
      >
        <label className="ask-title" htmlFor="bug-title">Сообщить о проблеме</label>
        <input id="bug-title" ref={titleRef} value={title} placeholder="Что не работает" maxLength={200} onChange={(event) => { setTitle(event.target.value); setError(""); }} />
        <textarea aria-label="Что пошло не так" value={description} placeholder="Что вы делали, что ожидали и что получилось. Текст ошибки, если он был." rows={6} onChange={(event) => { setDescription(event.target.value); setError(""); }} />
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
        <div className={error ? "ask-hint is-error" : "ask-hint"}>{error || `Запись попадёт в память проекта. К ней приложатся вкладка${tabTitle ? ` «${tabTitle}»` : ""}, адрес страницы и версия приложения.`}</div>
        <div className="ask-actions">
          <button type="button" onClick={() => onDone(null)}>Отмена</button>
          <button type="submit" className="is-primary" disabled={busy}>{busy ? "Записываю…" : "Записать"}</button>
        </div>
      </form>
    </div>
  );
}
