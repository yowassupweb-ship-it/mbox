import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import type { DocRecord } from "./docsStore";

type Person = { id: string; username: string; self?: boolean };
type Share = { user_id: string; role: "view" | "edit"; username: string | null };

/**
 * Дополнение к общему «Поделиться» (ShareLinks) только для документов: права остальных и доступ поимённо.
 * Ссылки, «Кто видит» и проект — те же, что у заметок и таблиц. Менять доступ может только владелец.
 */
export function DocShareExtra({ doc, onUpdate }: { doc: DocRecord; onUpdate: (patch: Partial<DocRecord>) => Promise<void> }) {
  const owner = Boolean(doc.is_owner);
  const [people, setPeople] = useState<Person[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<"view" | "edit">("edit");
  const [error, setError] = useState("");
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

  if (!owner) return <p className="wb-share-note">Документ открыт вам {doc.can_edit ? "для правки" : "только для просмотра"}. Доступ меняет владелец.</p>;
  return (
    <div className="wb-share-row wb-share-people">
      <div className="wb-share-head"><b>Доступ в MBOX</b><span>для тех, кто входит в систему</span></div>
      {(doc.access_level || "private") !== "private" && (
        <label className="wb-share-field">
          <span>Остальные могут</span>
          <select value={mode} onChange={(event) => void onUpdate({ access_mode: event.target.value as "view" | "edit" })} aria-label="Права остальных">
            <option value="edit">Редактировать</option>
            <option value="view">Только смотреть</option>
          </select>
        </label>
      )}
      <ul className="wb-share-list">
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
        {!shares.length && <li className="wb-share-empty">Поимённо пока никому не выдан</li>}
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
      {error && <p className="wb-share-error" role="alert">{error}</p>}
    </div>
  );
}
