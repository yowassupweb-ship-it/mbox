import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { EmptyState, Panel } from "../../ui";

type Skill = { id: string; name: string; summary: string; category: string; is_base: boolean; user_ids: string[] };
type Person = { id: string; username: string };

/**
 * Доступ к навыкам. Владелец видит все; остальные — только «базовые» и выданные их аккаунту.
 * Скрытый навык не попадает человеку ни в список, ни к его агентам (Claude/Codex на его компьютере).
 */
export function SkillAccessBoard() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [users, setUsers] = useState<Person[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchJson<{ skills: Skill[]; users: Person[] }>("/api/mbox/admin/skills");
      setSkills(result.skills);
      setUsers(result.users);
    } catch { setError("Не удалось загрузить навыки. Раздел доступен только владельцу."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function change(skill: Skill, patch: { is_base?: boolean; user_ids?: string[] }) {
    setBusy(skill.id);
    setError("");
    try {
      await fetchJson(`/api/mbox/admin/skills/${skill.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      setSkills((current) => current.map((item) => (item.id === skill.id ? { ...item, ...patch } : item)));
    } catch { setError("Не удалось сохранить"); void load(); }
    finally { setBusy(""); }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Skill[]>();
    for (const skill of skills) map.set(skill.category || "Остальные", [...(map.get(skill.category || "Остальные") || []), skill]);
    return [...map.entries()];
  }, [skills]);

  return (
    <div className="content-grid settings-single-grid">
      <Panel title="Кто какие навыки видит" icon={Sparkles}>
        <p className="integration-hint">Навыки не общедоступны. Базовые видят все аккаунты; остальные — только те, кому вы их выдали. Выданный навык появляется у человека в списке «Навыки» и на его компьютере у агентов Claude и ChatGPT. Править файлы навыков может только владелец.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
        {!users.length && <p className="account-owner-note">Других аккаунтов пока нет — выдавать некому. Создайте приглашение в «Команда».</p>}
      </Panel>
      {groups.map(([category, list]) => (
        <Panel key={category} title={category}>
          <div className="skill-matrix" role="table" aria-label={category} style={{ ["--skill-cols" as string]: users.length }}>
            <div className="skill-matrix-head" role="row">
              <span role="columnheader">Навык</span>
              <span role="columnheader" title="Видят все аккаунты">Базовый</span>
              {users.map((person) => <span key={person.id} role="columnheader" title={person.username}>{person.username}</span>)}
            </div>
            {list.map((skill) => (
              <div className="skill-matrix-row" role="row" key={skill.id}>
                <span role="cell" className="skill-matrix-name"><strong>{skill.name}</strong>{skill.summary && <small>{skill.summary}</small>}</span>
                <label role="cell" className="skill-matrix-check"><input type="checkbox" checked={skill.is_base} disabled={busy === skill.id} onChange={(event) => void change(skill, { is_base: event.target.checked })} aria-label={`${skill.name}: базовый`} /></label>
                {users.map((person) => {
                  const granted = skill.user_ids.includes(person.id);
                  return (
                    <label role="cell" className="skill-matrix-check" key={person.id} title={skill.is_base ? "Базовый навык виден всем" : undefined}>
                      <input
                        type="checkbox"
                        checked={skill.is_base || granted}
                        disabled={busy === skill.id || skill.is_base}
                        onChange={(event) => void change(skill, { user_ids: event.target.checked ? [...skill.user_ids, person.id] : skill.user_ids.filter((id) => id !== person.id) })}
                        aria-label={`${skill.name}: ${person.username}`}
                      />
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </Panel>
      ))}
      {!skills.length && !error && <EmptyState text="Навыков нет" />}
    </div>
  );
}
