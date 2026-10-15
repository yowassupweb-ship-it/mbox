import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { KeyRound, Link2, LoaderCircle, Plus, UserPlus, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { Company, Project } from "../../types";
import { PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { AccessPicker } from "../accounts/AccessPicker";
import { accountErrorText } from "../accounts/accountErrors";
import { Badge, Card, CopyField, Field, Notice, Row, Rows, Switch } from "./parts";

type Account = {
  id: string; email: string; username: string; role: "owner" | "member"; jarvis_enabled?: boolean; password_reset_at?: string | null;
  projects: Array<{ project_id: string; project_name: string; role: string }>;
  companies?: Array<{ company_id: string; company_name: string }>;
};
type Invite = {
  id: string; label: string; jarvis_enabled: boolean; uses_remaining: number; uses_total: number; expires_at: string; revoked_at: string | null; active: boolean;
  projects: Array<{ id: string; name: string }>; companies?: Array<{ id: string; name: string }>;
};
type Access = { projects: string[]; companies: string[] };
type Spaces = { enabled: boolean; preview: { memberships_added: number; moved: Record<string, number> } | null };

const JSON_HEADERS = { "content-type": "application/json" };
const same = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");
const accessOf = (account: Account): Access => ({ projects: account.projects.map((item) => item.project_id), companies: (account.companies || []).map((item) => item.company_id) });

function accessSummary(projects: string[], companies: string[]) {
  const parts = [];
  if (companies.length) parts.push(`${companies.length} ${companies.length === 1 ? "компания" : companies.length < 5 ? "компании" : "компаний"} целиком`);
  if (projects.length) parts.push(`${projects.length} ${projects.length === 1 ? "проект" : projects.length < 5 ? "проекта" : "проектов"}`);
  return parts.join(" и ") || "нет доступа к проектам";
}

/** Команда (только владелец): люди и их доступ, приглашения по ссылке, режим «у каждого свой MBOX». */
export function TeamSection({ projects, companies, onReload }: { projects: Project[]; companies: Company[]; onReload: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [adding, setAdding] = useState<"" | "invite" | "account">("");
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    try { setAccounts((await fetchJson<{ users: Account[] }>("/api/mbox/admin/users")).users); }
    catch (cause) { setError(accountErrorText(cause, "Не удалось загрузить людей")); }
  }, []);
  const loadInvites = useCallback(async () => {
    try { setInvites((await fetchJson<{ invites: Invite[] }>("/api/mbox/admin/invites")).invites); }
    catch { setError("Не удалось загрузить приглашения"); }
  }, []);
  useEffect(() => { void loadAccounts(); void loadInvites(); }, [loadAccounts, loadInvites]);

  const people = useMemo(() => [...accounts].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.username.localeCompare(b.username, "ru")), [accounts]);

  return (
    <div className="st-stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <Card
        title={`Люди · ${accounts.length}`}
        hint="Кто входит в ваш MBOX и какие проекты видит. Нажмите на человека, чтобы поменять доступ."
        actions={(
          <>
            <button type="button" className={adding === "invite" ? "st-btn is-selected" : "st-btn"} onClick={() => setAdding(adding === "invite" ? "" : "invite")}><Link2 size={14} /> Пригласить по ссылке</button>
            <button type="button" className={adding === "account" ? "st-btn is-selected" : "st-btn is-primary"} onClick={() => setAdding(adding === "account" ? "" : "account")}><UserPlus size={14} /> Создать аккаунт</button>
          </>
        )}
      >
        {adding === "invite" && <InviteForm projects={projects} companies={companies} onClose={() => setAdding("")} onCreated={() => void loadInvites()} />}
        {adding === "account" && <AccountForm projects={projects} companies={companies} onClose={() => setAdding("")} onCreated={() => { setAdding(""); void loadAccounts(); }} />}
        <Rows empty="Пока только вы.">
          {people.map((account) => <PersonRow key={account.id} account={account} projects={projects} companies={companies} onChanged={() => void loadAccounts()} />)}
        </Rows>
      </Card>
      <InvitesCard invites={invites} onChanged={() => void loadInvites()} />
      <SpacesCard onChanged={onReload} />
    </div>
  );
}

function PersonRow({ account, projects, companies, onChanged }: { account: Account; projects: Project[]; companies: Company[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Access>(() => accessOf(account));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [issued, setIssued] = useState("");
  useEffect(() => { setDraft(accessOf(account)); }, [account]);
  const saved = accessOf(account);
  const dirty = !same(draft.projects, saved.projects) || !same(draft.companies, saved.companies);
  const owner = account.role === "owner";

  async function patch(key: string, body: Record<string, unknown>, fallback: string) {
    setBusy(key);
    setError("");
    try { await fetchJson(`/api/mbox/admin/users/${account.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }); onChanged(); }
    catch (cause) { setError(accountErrorText(cause, fallback)); }
    finally { setBusy(""); }
  }

  async function resetPassword() {
    if (!(await askConfirm({ title: `Сбросить пароль ${account.username}?`, message: "Текущий пароль перестанет работать, все входы этого аккаунта закроются. Вы получите временный пароль — передайте его человеку, после входа MBOX попросит задать свой.", confirmLabel: "Сбросить", danger: true }))) return;
    setBusy("reset");
    setError("");
    try {
      setIssued((await fetchJson<{ password: string }>(`/api/mbox/admin/users/${account.id}/reset-password`, { method: "POST" })).password);
      onChanged();
    } catch (cause) { setError(accountErrorText(cause, "Не удалось сбросить пароль")); }
    finally { setBusy(""); }
  }

  return (
    <Row
      lead={<span className="st-avatar" aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span>}
      title={account.username}
      meta={owner ? `Владелец${account.email ? ` · ${account.email}` : ""}` : `${accessSummary(saved.projects, saved.companies)}${account.email ? ` · ${account.email}` : ""}`}
      side={(
        <>
          {account.password_reset_at && <Badge tone="warn">временный пароль</Badge>}
          {!owner && account.jarvis_enabled !== false && <Badge tone="accent">Джарвис</Badge>}
        </>
      )}
      open={open}
      onToggle={owner ? undefined : () => setOpen((value) => !value)}
      details={owner ? undefined : (
        <div className="st-stack">
          {error && <Notice tone="danger">{error}</Notice>}
          {issued && (
            <Notice tone="warn" title="Временный пароль — показывается один раз" actions={<button type="button" className="st-btn" onClick={() => setIssued("")}><X size={14} /> Скрыть</button>}>
              <CopyField value={issued} secret />
            </Notice>
          )}
          <div className="st-subhead">Доступ к проектам</div>
          <AccessPicker projects={projects} companies={companies} selectedProjects={draft.projects} selectedCompanies={draft.companies} disabled={busy !== ""} onChange={setDraft} />
          <div className="st-actions">
            <button type="button" className="st-btn is-primary" disabled={!dirty || busy !== ""} onClick={() => void patch("access", { project_ids: draft.projects, company_ids: draft.companies }, "Не удалось сохранить доступ")}>{busy === "access" ? "Сохраняю…" : "Сохранить доступ"}</button>
            {dirty && <button type="button" className="st-btn" onClick={() => setDraft(saved)}>Отменить</button>}
          </div>
          <div className="st-group">
            <Switch label="Свой Джарвис" hint="Отдельная история и чаты; видит только проекты этого человека. Отвечает на ваших ключах моделей." checked={account.jarvis_enabled !== false} disabled={busy !== ""} onChange={(next) => void patch("jarvis", { jarvis_enabled: next }, "Не удалось переключить Джарвиса")} />
          </div>
          <div className="st-actions">
            <button type="button" className="st-btn" disabled={busy !== ""} onClick={() => void resetPassword()}><KeyRound size={14} /> {busy === "reset" ? "Сбрасываю…" : "Сбросить пароль"}</button>
          </div>
        </div>
      )}
    />
  );
}

function AccountForm({ projects, companies, onClose, onCreated }: { projects: Project[]; companies: Company[]; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<Access>({ projects: [], companies: [] });
  const [jarvis, setJarvis] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/mbox/admin/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username, email, password, project_ids: access.projects, company_ids: access.companies, jarvis_enabled: jarvis }) });
      onCreated();
    } catch (cause) { setError(accountErrorText(cause, "Не удалось создать аккаунт")); }
    finally { setBusy(false); }
  }

  return (
    <form className="st-form" onSubmit={submit}>
      <div className="st-form-head"><strong>Новый аккаунт</strong><span>Вы задаёте логин и пароль сами и передаёте их человеку.</span></div>
      <div className="st-fields st-fields-3">
        <Field label="Логин"><input value={username} onChange={(event) => setUsername(event.target.value)} minLength={2} maxLength={32} required autoFocus /></Field>
        <Field label="Email" hint="Необязательно"><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" /></Field>
        <Field label="Пароль" hint="Минимум 8 знаков"><PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></Field>
      </div>
      <div className="st-subhead">Доступ к проектам</div>
      <AccessPicker projects={projects} companies={companies} selectedProjects={access.projects} selectedCompanies={access.companies} onChange={setAccess} />
      <div className="st-group"><Switch label="Свой Джарвис" hint="Отвечает на ваших ключах моделей. Без него человек подключает своего Claude или ChatGPT." checked={jarvis} onChange={setJarvis} /></div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-actions">
        <button type="submit" className="st-btn is-primary" disabled={busy}><Plus size={14} /> {busy ? "Создаю…" : "Создать аккаунт"}</button>
        <button type="button" className="st-btn" onClick={onClose}>Отмена</button>
      </div>
    </form>
  );
}

function InviteForm({ projects, companies, onClose, onCreated }: { projects: Project[]; companies: Company[]; onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<Access>({ projects: [], companies: [] });
  const [jarvis, setJarvis] = useState(false);
  const [uses, setUses] = useState(1);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ invite: { url: string } }>("/api/mbox/admin/invites", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ label, project_ids: access.projects, company_ids: access.companies, jarvis_enabled: jarvis, uses, expires_days: days }) });
      setCreated(result.invite.url);
      onCreated();
    } catch (cause) { setError(accountErrorText(cause, "Не удалось создать приглашение")); }
    finally { setBusy(false); }
  }

  if (created) {
    return (
      <div className="st-form">
        <Notice tone="ok" title="Ссылка готова — скопируйте и отправьте">Человек сам выберет логин и пароль. Целиком ссылку больше не показать: потеряли — отзовите и создайте новую.</Notice>
        <CopyField value={created} label="Скопировать ссылку" />
        <div className="st-actions">
          <button type="button" className="st-btn" onClick={() => { setCreated(""); setLabel(""); }}><Plus size={14} /> Ещё одна</button>
          <button type="button" className="st-btn" onClick={onClose}>Готово</button>
        </div>
      </div>
    );
  }

  return (
    <form className="st-form" onSubmit={submit}>
      <div className="st-form-head"><strong>Приглашение по ссылке</strong><span>Человек сам заведёт логин и пароль. Ссылка работает ограниченное число раз и срок.</span></div>
      <div className="st-fields st-fields-3">
        <Field label="Для кого" hint="Видно только вам"><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} placeholder="Например, Миша" autoFocus /></Field>
        <Field label="Сколько раз"><input type="number" min={1} max={50} value={uses} onChange={(event) => setUses(Number(event.target.value))} /></Field>
        <Field label="Действует, дней"><input type="number" min={1} max={60} value={days} onChange={(event) => setDays(Number(event.target.value))} /></Field>
      </div>
      <div className="st-subhead">Доступ к проектам</div>
      <AccessPicker projects={projects} companies={companies} selectedProjects={access.projects} selectedCompanies={access.companies} onChange={setAccess} />
      <div className="st-group"><Switch label="Свой Джарвис" hint="Отвечает на ваших ключах моделей." checked={jarvis} onChange={setJarvis} /></div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-actions">
        <button type="submit" className="st-btn is-primary" disabled={busy}>{busy ? <LoaderCircle size={14} className="st-spin" /> : <Link2 size={14} />} Создать ссылку</button>
        <button type="button" className="st-btn" onClick={onClose}>Отмена</button>
      </div>
    </form>
  );
}

function InvitesCard({ invites, onChanged }: { invites: Invite[]; onChanged: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState("");
  const active = invites.filter((invite) => invite.active);
  const finished = invites.filter((invite) => !invite.active);
  if (!invites.length) return null;

  async function revoke(invite: Invite) {
    setBusy(invite.id);
    try { await fetchJson(`/api/mbox/admin/invites/${invite.id}`, { method: "DELETE" }); onChanged(); }
    finally { setBusy(""); }
  }

  const row = (invite: Invite) => {
    const state = invite.active ? "действует" : invite.revoked_at ? "отозвано" : invite.uses_remaining <= 0 ? "использовано" : "истекло";
    const scope = [...(invite.companies || []).map((company) => `${company.name} целиком`), ...invite.projects.map((project) => project.name)].join(", ") || "без проектов";
    return (
      <Row
        key={invite.id}
        icon={Link2}
        title={invite.label || "Без названия"}
        meta={`${scope} · вошло ${invite.uses_total}, осталось ${invite.uses_remaining} · до ${formatDateTime(invite.expires_at)}${invite.jarvis_enabled ? " · с Джарвисом" : ""}`}
        side={invite.active
          ? <button type="button" className="st-btn is-danger" disabled={busy === invite.id} onClick={() => void revoke(invite)}>Отозвать</button>
          : <Badge>{state}</Badge>}
      />
    );
  };

  return (
    <Card title={`Приглашения · ${active.length} действует`} actions={finished.length > 0 && <button type="button" className="st-link" onClick={() => setShowAll((value) => !value)}>{showAll ? "Скрыть завершённые" : `Завершённые (${finished.length})`}</button>}>
      <Rows empty="Действующих приглашений нет.">
        {active.map(row)}
        {showAll && finished.map(row)}
      </Rows>
    </Card>
  );
}

/** Режим «у каждого свой MBOX». Выключен — владелец видит все проекты команды; включён — каждый только свои и общие с ним. */
function SpacesCard({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<Spaces | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setState(await fetchJson<Spaces>("/api/mbox/admin/spaces")); } catch { setError("Не удалось узнать режим доступа."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function change(enabled: boolean) {
    const moved = state?.preview ? Object.values(state.preview.moved).reduce((sum, value) => sum + value, 0) : 0;
    const ok = await askConfirm(enabled
      ? { title: "Включить личные пространства?", message: `Вы будете видеть только проекты, где вы участник. Сейчас вас добавят во все существующие проекты (${state?.preview?.memberships_added ?? 0}), ${moved ? `${moved} записей без проекта переедут в проект «Общее». ` : ""}Чужие проекты, которые команда создаст дальше, вы видеть не будете. Выключить можно в любой момент.`, confirmLabel: "Включить" }
      : { title: "Выключить личные пространства?", message: "Вы снова увидите все проекты команды. Участники и проекты не изменятся.", confirmLabel: "Выключить" });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      setState(await fetchJson<Spaces>("/api/mbox/admin/spaces", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) }));
      onChanged();
      void load();
    } catch { setError("Не удалось переключить режим."); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Режим доступа">
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-group">
        <Switch
          label="У каждого свой MBOX"
          hint={state?.enabled
            ? "Включено: каждый, включая вас, видит только проекты, где он участник. Проект принадлежит создателю, делиться им он решает сам."
            : "Выключено: вы видите все проекты команды. Включите, чтобы не видеть чужие проекты."}
          checked={Boolean(state?.enabled)}
          disabled={!state || busy}
          onChange={(next) => void change(next)}
        />
      </div>
    </Card>
  );
}
