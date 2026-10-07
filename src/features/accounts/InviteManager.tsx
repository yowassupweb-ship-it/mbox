import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { Project } from "../../types";
import { Panel } from "../../ui";
import { accountErrorText } from "./accountErrors";

type Invite = {
  id: string;
  label: string;
  jarvis_enabled: boolean;
  uses_remaining: number;
  uses_total: number;
  expires_at: string;
  revoked_at: string | null;
  active: boolean;
  projects: Array<{ id: string; name: string }>;
};
type CreatedInvite = { id: string; url: string };

/** Ссылки-приглашения: владелец выбирает проекты и Джарвиса, друг сам заводит себе логин и пароль. */
export function InviteManager({ projects }: { projects: Project[] }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [label, setLabel] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [jarvis, setJarvis] = useState(false);
  const [uses, setUses] = useState(1);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => fetchJson<{ invites: Invite[] }>("/api/mbox/admin/invites").then((result) => setInvites(result.invites)).catch(() => setError("Не удалось загрузить приглашения")), []);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy("new");
    setError("");
    try {
      const result = await fetchJson<{ invite: CreatedInvite }>("/api/mbox/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, project_ids: projectIds, jarvis_enabled: jarvis, uses, expires_days: days }),
      });
      setCreated(result.invite);
      setLabel("");
      await load();
    } catch (cause) {
      setError(accountErrorText(cause, "Не удалось создать приглашение"));
    } finally {
      setBusy("");
    }
  }

  async function revoke(invite: Invite) {
    setBusy(invite.id);
    try {
      await fetchJson(`/api/mbox/admin/invites/${invite.id}`, { method: "DELETE" });
      if (created?.id === invite.id) setCreated(null);
      await load();
    } catch (cause) {
      setError(accountErrorText(cause, "Не удалось отозвать приглашение"));
    } finally {
      setBusy("");
    }
  }

  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Panel title="Приглашения" icon={Link2}>
      <div className="account-manager">
        <p className="account-owner-note">Создайте ссылку и отправьте другу: он сам выберет логин и пароль. Ссылка работает ограниченное число раз и срок, её можно отозвать.</p>
        <form className="account-create" onSubmit={create}>
          <div className="account-create-fields">
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Для кого (необязательно)" maxLength={80} />
            <label className="invite-number"><span>Использований</span><input type="number" min={1} max={50} value={uses} onChange={(event) => setUses(Number(event.target.value))} /></label>
            <label className="invite-number"><span>Действует, дней</span><input type="number" min={1} max={60} value={days} onChange={(event) => setDays(Number(event.target.value))} /></label>
          </div>
          <div className="account-projects" aria-label="Доступные проекты">
            {projects.map((project) => {
              const checked = projectIds.includes(project.id);
              return (
                <label className={checked ? "account-project is-selected" : "account-project"} key={project.id}>
                  <input type="checkbox" checked={checked} onChange={() => setProjectIds(checked ? projectIds.filter((id) => id !== project.id) : [...projectIds, project.id])} />
                  <span>{project.name}</span>
                </label>
              );
            })}
          </div>
          <label className="account-jarvis" title="Вопросы друга будет отвечать ваш Джарвис на ваших ключах моделей. Выключено — друг подключает своего Claude или ChatGPT.">
            <input type="checkbox" checked={jarvis} onChange={(event) => setJarvis(event.target.checked)} />
            Дать доступ к Джарвису
          </label>
          <button className="primary-action" type="submit" disabled={busy === "new"}>{busy === "new" ? "Создаю…" : "Создать ссылку"}</button>
        </form>
        {created && (
          <div className="responder-token">
            <strong>Ссылка готова — скопируйте и отправьте</strong>
            <textarea readOnly rows={2} value={created.url} aria-label="Ссылка-приглашение" onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={() => void copy(created.url)}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Скопировано" : "Скопировать ссылку"}</button>
            <p>Позже ссылку целиком не показать. Если потеряли — отзовите и создайте новую.</p>
          </div>
        )}
        {error && <div className="account-error" role="alert">{error}</div>}
        <div className="account-list">
          {invites.map((invite) => (
            <div className="account-row" key={invite.id}>
              <div className="account-identity">
                <strong>{invite.label || "Без названия"}</strong>
                <span>
                  {invite.active ? "действует" : invite.revoked_at ? "отозвано" : invite.uses_remaining <= 0 ? "использовано" : "истекло"}
                  {` · до ${formatDateTime(invite.expires_at)} · осталось ${invite.uses_remaining}, вошло ${invite.uses_total}`}
                  {` · ${invite.jarvis_enabled ? "с Джарвисом" : "без Джарвиса"}`}
                  {` · ${invite.projects.length ? invite.projects.map((project) => project.name).join(", ") : "без проектов"}`}
                </span>
              </div>
              {invite.active && <button className="account-save" type="button" disabled={busy === invite.id} onClick={() => void revoke(invite)}>Отозвать</button>}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
