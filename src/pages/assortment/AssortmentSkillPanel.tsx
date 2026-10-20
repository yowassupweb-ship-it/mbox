import { useCallback, useEffect, useState } from "react";
import { BookMarked, History, Save, X } from "lucide-react";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { ApiError, fetchJson } from "../../lib/api";

/**
 * Навык «Ассортимент» прямо на экране: правка его файлов (SKILL.md, rules.md, learnings.md) с историей версий и быстрое «Запомнить правило».
 * Это те же ручки пакетов навыков, что у агентов (edit_skill_file, skill_learning_add): правка сразу доходит до серверных Claude и GPT,
 * а каждая версия файла сохраняется. Только владелец.
 */
const SKILL = "assortment";
const BASE = `/api/mbox/agent/skills/packages/${SKILL}`;
const json = { "content-type": "application/json" };

type FileInfo = { path: string; size: number; edited?: boolean };
type Version = { id: string; author: string; message: string; size_bytes: number; created_at: string };

const FILE_HINT: Record<string, string> = {
  "SKILL.md": "Инструкция агенту: порядок работы и жёсткие правила.",
  "rules.md": "Принципы, которые объяснил владелец.",
  "learnings.md": "Опыт навыка: что пошло не так и что поправили.",
};
const when = (value: string) => {
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? value.slice(0, 16) : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const failure = (cause: unknown) => (cause instanceof ApiError ? `Сервер ответил ошибкой ${cause.status}${cause.code ? `: ${cause.code}` : ""}` : "Нет связи с сервером");

export function AssortmentSkillPanel({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [file, setFile] = useState("SKILL.md");
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [rule, setRule] = useState("");
  const [mine, setMine] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const loadFiles = useCallback(async () => {
    try {
      const data = await fetchJson<{ package: { files: FileInfo[] } }>(BASE);
      setFiles(data.package.files.filter((item) => /\.(md|txt|json)$/.test(item.path)));
    } catch (cause) { setError(failure(cause)); setFiles([]); }
  }, []);
  const loadMine = useCallback(async () => {
    try { setMine((await fetchJson<{ content: string }>(`${BASE}/learnings`)).content); } catch { setMine(""); }
  }, []);
  useEffect(() => { void loadFiles(); void loadMine(); }, [loadFiles, loadMine]);

  const loadFile = useCallback(async (path: string) => {
    setText(null); setError(""); setStatus(""); setShowHistory(false);
    try {
      const data = await fetchJson<{ content: string }>(`${BASE}?file=${encodeURIComponent(path)}`);
      setText(data.content); setSaved(data.content);
    } catch (cause) { setError(failure(cause)); setText(""); setSaved(""); }
  }, []);
  useEffect(() => { void loadFile(file); }, [file, loadFile]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (text === null) return;
    setStatus("Сохраняю…"); setError("");
    try {
      await fetchJson(`${BASE}/files?file=${encodeURIComponent(file)}`, { method: "PUT", headers: json, body: JSON.stringify({ content: text, message: message.trim() || "правка с экрана «Ассортимент»" }) });
      setSaved(text); setMessage("");
      setStatus("Сохранено. Серверные агенты подхватят правку при следующей синхронизации навыка.");
      void loadFiles();
    } catch (cause) { setStatus(""); setError(failure(cause)); }
  };

  const toggleHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (!next) return;
    try { setVersions((await fetchJson<{ versions: Version[] }>(`${BASE}/history?file=${encodeURIComponent(file)}`)).versions); } catch (cause) { setError(failure(cause)); }
  };
  const remember = async () => {
    const line = rule.trim();
    if (!line) return;
    try {
      const data = await fetchJson<{ content: string }>(`${BASE}/learnings`, { method: "POST", headers: json, body: JSON.stringify({ text: line }) });
      setMine(data.content); setRule(""); setStatus("Правило запомнено: агенты получат его вместе с навыком.");
    } catch (cause) { setError(failure(cause)); }
  };

  return (
    <div className="seo-detail-scrim" onClick={onClose}>
      <aside className="seo-detail assortment-skill" role="dialog" aria-modal="true" aria-label="Навык «Ассортимент»" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Навык «Ассортимент»</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <p className="seo-form-hint">Здесь меняется то, как агенты работают с ассортиментом. Каждая правка сохраняется с историей. Агент в чате тоже может править навык и записывать правила.</p>

        <h3><BookMarked size={14} aria-hidden="true" /> Запомнить правило</h3>
        <form className="assortment-skill-rule" onSubmit={(event) => { event.preventDefault(); void remember(); }}>
          <input value={rule} onChange={(event) => setRule(event.currentTarget.value)} placeholder="Например: варианты с отелем 3* и 4* не считать дублями" maxLength={300} aria-label="Правило одной строкой" />
          <button type="submit" disabled={!rule.trim()}>Запомнить</button>
        </form>
        {mine.trim() && <pre className="assortment-skill-mine" aria-label="Мои правила">{mine}</pre>}

        <h3>Файлы навыка</h3>
        {!files && <OctopusSpinner compact label="Загружаю…" />}
        {files && (
          <div className="assortment-skill-files" role="tablist">
            {files.map((item) => (
              <button key={item.path} type="button" role="tab" aria-selected={item.path === file} className={item.path === file ? "is-on" : undefined} onClick={() => setFile(item.path)} title={FILE_HINT[item.path] || item.path}>
                {item.path}{item.edited ? " •" : ""}
              </button>
            ))}
          </div>
        )}
        {FILE_HINT[file] && <p className="seo-form-hint">{FILE_HINT[file]}</p>}
        {text === null ? <OctopusSpinner compact label="Загружаю файл…" /> : (
          <textarea className="assortment-skill-editor" value={text} onChange={(event) => setText(event.currentTarget.value)} spellCheck={false} aria-label={`Содержимое ${file}`} rows={16} />
        )}
        <div className="assortment-skill-actions">
          <input value={message} onChange={(event) => setMessage(event.currentTarget.value)} placeholder="Что поменяли (для истории)" maxLength={200} aria-label="Описание правки" />
          <button type="button" className="is-primary" disabled={text === null || text === saved} onClick={() => void save()}><Save size={13} aria-hidden="true" /> Сохранить</button>
          <button type="button" onClick={() => void toggleHistory()} aria-pressed={showHistory}><History size={13} aria-hidden="true" /> История</button>
        </div>
        {status && <p className="seo-form-hint" role="status">{status}</p>}
        {error && <p className="seo-error" role="alert">{error}</p>}
        {showHistory && (
          <ul className="assortment-skill-history">
            {versions.length === 0 && <li>Правок пока не было: файл такой, как в репозитории.</li>}
            {versions.map((version) => (
              <li key={version.id}>
                <span><strong>{when(version.created_at)}</strong> · {version.author || "—"} · {version.size_bytes} Б</span>
                <em>{version.message || "без описания"}</em>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
