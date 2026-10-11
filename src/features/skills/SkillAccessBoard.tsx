import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Sparkles } from "lucide-react";
import { ApiError, fetchJson } from "../../lib/api";
import { EmptyState, Panel } from "../../ui";
import { IconControls, ItemIcon } from "./ItemIcon";

type Skill = { id: string; name: string; summary: string; category: string; is_base: boolean; user_ids: string[]; own: boolean; icon: string };
type Person = { id: string; username: string };

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,59}$/;
const JSON_HEADERS = { "content-type": "application/json" };
const filesUrl = (id: string) => `/api/mbox/agent/skills/packages/${id}/files?file=SKILL.md`;

/** SKILL.md с шапкой в том виде, который понимают Claude и Codex: name + description, дальше инструкция. */
function skillFile(id: string, description: string, body: string) {
  return `---\nname: ${id}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n${body.trim()}\n`;
}

function SkillEditor({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState("");
  useEffect(() => {
    fetchJson<{ content: string }>(`/api/mbox/agent/skills/packages/${skill.id}?file=SKILL.md`)
      .then((result) => setText(result.content))
      .catch(() => setState("Не удалось открыть SKILL.md"));
  }, [skill.id]);
  async function save() {
    setState("Сохраняю…");
    try {
      await fetchJson(filesUrl(skill.id), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ content: text ?? "", message: "Правка в настройках" }) });
      setState("Сохранено. Агенты получат новую версию при следующей синхронизации.");
    } catch (cause) {
      setState(cause instanceof ApiError && cause.status === 403 ? "Это чужой навык — править его может только автор." : "Не удалось сохранить");
    }
  }
  return (
    <div className="skill-editor">
      <textarea value={text ?? ""} onChange={(event) => setText(event.target.value)} disabled={text === null} rows={14} spellCheck={false} aria-label={`SKILL.md навыка ${skill.name}`} />
      <div className="skill-editor-actions">
        <button className="primary-action" type="button" onClick={() => void save()} disabled={text === null}>Сохранить</button>
        <button className="ghost-action" type="button" onClick={onClose}>Закрыть</button>
        {state && <span className="skill-editor-state" role="status">{state}</span>}
      </div>
    </div>
  );
}

function NewSkillForm({ onCreated }: { onCreated: () => void }) {
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const code = id.trim().toLowerCase();
    if (!SKILL_ID.test(code)) { setError("Код навыка — латиницей, цифры и дефис, например seo-audit."); return; }
    setBusy(true);
    setError("");
    try {
      await fetchJson(filesUrl(code), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ content: skillFile(code, description, body || `# ${code}\n\nОпишите, что делать агенту.`), message: "Новый навык" }) });
      setId(""); setDescription(""); setBody("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? "Навык с таким кодом уже есть у другого человека — выберите другой код." : "Не удалось создать навык.");
    } finally { setBusy(false); }
  }

  return (
    <form className="account-create" onSubmit={submit}>
      <div className="account-create-fields skill-create-fields">
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder="Код, например seo-audit" required aria-label="Код навыка" />
        <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Когда агенту его применять (одна строка)" required aria-label="Описание навыка" />
      </div>
      <textarea className="skill-create-body" value={body} onChange={(event) => setBody(event.target.value)} rows={6} placeholder="Инструкция для агента: шаги, правила, примеры. Можно оставить пустым и дописать позже." aria-label="Инструкция навыка" />
      {error && <div className="account-error" role="alert">{error}</div>}
      <button className="primary-action" type="submit" disabled={busy}><Plus size={16} />{busy ? "Создаю…" : "Создать навык"}</button>
    </form>
  );
}

/**
 * Навыки аккаунта. Свой навык виден только его автору и его агентам (Claude, Codex на его компьютере);
 * автор сам открывает его всей команде или выбранным людям.
 */
export function SkillAccessBoard() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [users, setUsers] = useState<Person[]>([]);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchJson<{ skills: Skill[]; users: Person[] }>("/api/mbox/admin/skills");
      setSkills(result.skills);
      setUsers(result.users);
    } catch { setError("Не удалось загрузить навыки."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function change(skill: Skill, patch: { is_base?: boolean; user_ids?: string[] }) {
    setBusy(skill.id);
    setError("");
    try {
      await fetchJson(`/api/mbox/admin/skills/${skill.id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(patch) });
      setSkills((current) => current.map((item) => (item.id === skill.id ? { ...item, ...patch } : item)));
    } catch { setError("Не удалось сохранить"); void load(); }
    finally { setBusy(""); }
  }

  return (
    <div className="content-grid settings-single-grid">
      <Panel title="Мои навыки" icon={Sparkles}>
        <p className="integration-hint">Навык — это инструкция для агента (всё, что про подключение к API, — «Инструменты»). Создайте навык здесь или попросите своего агента: он сразу доступен вашим агентам Claude и ChatGPT. По умолчанию его видите только вы. Когда захотите поделиться, откройте его выбранным людям или опубликуйте в магазине. Править навык может только его автор.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
        <NewSkillForm onCreated={() => void load()} />
      </Panel>
      <Panel title={`Навыки, которыми вы распоряжаетесь (${skills.length})`}>
        <div className="skill-list">
          {skills.map((skill) => (
            <div className="skill-card" key={skill.id}>
              <div className="skill-card-head">
                <ItemIcon icon={skill.icon} name={skill.name} size={44} />
                <span className="skill-matrix-name"><strong>{skill.name}</strong>{skill.summary && <small>{skill.summary}</small>}</span>
                <label className="account-jarvis" title="Виден всем аккаунтам команды">
                  <input type="checkbox" checked={skill.is_base} disabled={busy === skill.id} onChange={(event) => void change(skill, { is_base: event.target.checked })} />
                  Всей команде
                </label>
                <button className="ghost-action" type="button" onClick={() => setEditing(editing === skill.id ? "" : skill.id)}>{editing === skill.id ? "Свернуть" : "Править"}</button>
              </div>
              {!skill.is_base && users.length > 0 && (
                <div className="account-projects" aria-label={`Кому открыт навык ${skill.name}`}>
                  {users.map((person) => {
                    const granted = skill.user_ids.includes(person.id);
                    return (
                      <label className={granted ? "account-project is-selected" : "account-project"} key={person.id}>
                        <input type="checkbox" checked={granted} disabled={busy === skill.id} onChange={() => void change(skill, { user_ids: granted ? skill.user_ids.filter((id) => id !== person.id) : [...skill.user_ids, person.id] })} />
                        <span>{person.username}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {editing === skill.id && (
                <>
                  <IconControls kind="skill" refId={skill.id} hasIcon={Boolean(skill.icon)} onChanged={(icon) => setSkills((current) => current.map((item) => (item.id === skill.id ? { ...item, icon } : item)))} />
                  <SkillEditor skill={skill} onClose={() => setEditing("")} />
                </>
              )}
            </div>
          ))}
          {!skills.length && !error && <EmptyState text="Своих навыков пока нет. Создайте первый выше." />}
        </div>
      </Panel>
    </div>
  );
}
