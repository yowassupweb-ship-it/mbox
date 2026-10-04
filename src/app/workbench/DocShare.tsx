import { useEffect, useState } from "react";
import { Globe2, Lock, Users, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import type { Project } from "../../types";
import type { DocRecord } from "./docsStore";

type Person = { id: string; username: string; self?: boolean };
type Share = { user_id: string; role: "view" | "edit"; username: string | null };
type Access = "private" | "project" | "all";

const LEVELS: Array<{ value: Access; label: string; hint: string; Icon: typeof Lock }> = [
  { value: "private", label: "Только я", hint: "видите вы и те, кому выдали доступ ниже", Icon: Lock },
  { value: "project", label: "Участники проекта", hint: "видят все, кто состоит в проекте документа", Icon: Users },
  { value: "all", label: "Все в MBOX", hint: "видят все пользователи MBOX", Icon: Globe2 },
];

/**
 * Окно «Поделиться» (как в Google Документах): кто видит документ, может ли он править, и доступ поимённо.
 * Менять доступ может только владелец; остальные видят, как документ открыт им.
 */
export function DocShare({ doc, projects, onUpdate, onClose }: { doc: DocRecord; projects: Project[]; onUpdate: (patch: Partial<DocRecord>) => Promise<void>; onClose: () => void }) {
  const owner = Boolean(doc.is_owner);
  const [people, setPeople] = useState<Person[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<"view" | "edit">("edit");
  const [error, setError] = useState("");
  const level = LEVELS.find((item) => item.value === (doc.access_level || "private")) ?? LEVELS[0];
  const mode = doc.access_mode === "view" ? "view" : "edit";

  const loadShares = () => fetchJson<{ shares: Share[] }>(`/api/mbox/documents/${doc.id}/shares`).then((result) => setShares(result.shares)).catch(() => {});
  useEffect(() => {
    if (!owner) return;
    void loadShares();
    fetchJson<{ users: Person[] }>("/api/mbox/directory").then((result) => setPeople(result.users.filter((person) => !person.self))).catch(() => {});
  }, [doc.id, owner]);

  async function setShare(userId: string, next: "view" | "edit" | null) {
    setError("");
    try {
      await fetchJson(`/api/mbox/documents/${doc.id}/shares`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: userId, role: next }) });
      await loadShares();
    } catch { setError("Не удалось изменить доступ. Попробуйте ещё раз."); }
  }

  const free = people.filter((person) => !shares.some((share) => share.user_id === person.id));

  return (
    <div className="wb-share" role="dialog" aria-label="Поделиться документом">
      <header className="wb-share-head">
        <strong>Поделиться</strong>
        <button type="button" onClick={onClose} aria-label="Закрыть"><X size={14} /></button>
      </header>
      {!owner && <p className="wb-share-note">Документ открыт вам {doc.can_edit ? "для правки" : "только для просмотра"}. Доступ меняет владелец.</p>}
      <section className="wb-share-block">
        <h4>Кто видит</h4>
        <label className="wb-share-field">
          <level.Icon size={14} aria-hidden="true" />
          <select value={level.value} disabled={!owner} onChange={(event) => void onUpdate({ access_level: event.target.value as Access })} aria-label="Кто видит документ">
            {LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <small>{level.hint}</small>
        {level.value !== "private" && (
          <label className="wb-share-field">
            <span>Остальные могут</span>
            <select value={mode} disabled={!owner} onChange={(event) => void onUpdate({ access_mode: event.target.value as "view" | "edit" })} aria-label="Права остальных">
              <option value="edit">Редактировать</option>
              <option value="view">Только смотреть</option>
            </select>
          </label>
        )}
        <label className="wb-share-field">
          <span>Проект</span>
          <select value={doc.project_id ?? ""} disabled={!owner} onChange={(event) => void onUpdate({ project_id: event.target.value || null })} aria-label="Проект документа">
            <option value="">Без проекта</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </section>
      {owner && (
        <section className="wb-share-block">
          <h4>Доступ поимённо</h4>
          <ul className="wb-share-people">
            {shares.map((share) => (
              <li key={share.user_id}>
                <span>{share.username || `#${share.user_id}`}</span>
                <select value={share.role} onChange={(event) => void setShare(share.user_id, event.target.value as "view" | "edit")} aria-label={`Права ${share.username}`}>
                  <option value="edit">Редактор</option>
                  <option value="view">Читатель</option>
                </select>
                <button type="button" onClick={() => void setShare(share.user_id, null)} aria-label={`Убрать доступ: ${share.username}`}><X size={13} /></button>
              </li>
            ))}
            {!shares.length && <li className="wb-share-empty">Пока никому не выдан</li>}
          </ul>
          <div className="wb-share-add">
            <select value={pick} onChange={(event) => setPick(event.target.value)} aria-label="Кому дать доступ">
              <option value="">Выберите человека</option>
              {free.map((person) => <option key={person.id} value={person.id}>{person.username}</option>)}
            </select>
            <select value={role} onChange={(event) => setRole(event.target.value as "view" | "edit")} aria-label="Права">
              <option value="edit">Редактор</option>
              <option value="view">Читатель</option>
            </select>
            <button type="button" disabled={!pick} onClick={() => { void setShare(pick, role); setPick(""); }}>Добавить</button>
          </div>
        </section>
      )}
      {error && <p className="wb-share-error" role="alert">{error}</p>}
    </div>
  );
}
