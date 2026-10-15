import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { Bot, Check, Copy, Eye, EyeOff, Globe, KeyRound, Pencil, Plus, Search, Server, Trash2, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { Project } from "../../types";
import { PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { Badge, Card, Field, Notice, Row, Rows, Segments, errorText } from "./parts";

type Kind = "site" | "server" | "other";
type Entry = {
  id: string; kind: Kind; project_id: string | null; title: string; login: string; url: string; host: string; port: number | null; origin: string;
  agent_share_state: string; approved_until: string | null; has_notes: boolean; used_at: string | null; uses: number; source: string; updated_at: string;
};
type Draft = { kind: Kind; title: string; login: string; password: string; url: string; host: string; port: string; notes: string; project_id: string };

const JSON_HEADERS = { "content-type": "application/json" };
const KIND_LABEL: Record<Kind, string> = { site: "Сайт", server: "Сервер", other: "Другое" };
const KIND_ICON = { site: Globe, server: Server, other: KeyRound };
const SHARE_HOURS = [1, 6, 24, 24 * 7];
const emptyDraft = (kind: Kind = "site"): Draft => ({ kind, title: "", login: "", password: "", url: "", host: "", port: kind === "server" ? "22" : "", notes: "", project_id: "" });
const approved = (entry: Entry) => entry.agent_share_state === "approved" && (!entry.approved_until || Date.parse(entry.approved_until) > Date.now());

function subtitle(entry: Entry) {
  if (entry.kind === "server") return [entry.login && `${entry.login}@`, entry.host || "хост не указан", entry.port ? `:${entry.port}` : ""].filter(Boolean).join("");
  if (entry.kind === "site") return [entry.login || "без логина", entry.origin.replace(/^https?:\/\//, "")].join(" · ");
  return entry.login || entry.url || (entry.has_notes ? "заметка" : "");
}

/**
 * Пароли: одно хранилище для всего (server/passwords.mjs). Входы на сайты подставляет встроенный браузер MBOX Desktop и сохраняет
 * сюда же; рядом — доступы к серверам и всё прочее. У каждого свои записи. Пароль в списке не приходит: «показать» и
 * «копировать» спрашивают его отдельно. Агенту запись выдаётся на время — после этого MCP get_project_access отдаёт её ему.
 */
export function PasswordsSection({ projects }: { projects: Project[] }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState("");
  const [adding, setAdding] = useState<Kind | "">("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchJson<{ secrets: Entry[]; never: string[] }>("/api/mbox/secrets");
      setEntries(result.secrets);
      setNever(result.never || []);
    } catch (cause) { setError(errorText(cause, "Не удалось загрузить пароли")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({ all: entries?.length ?? 0, site: entries?.filter((e) => e.kind === "site").length ?? 0, server: entries?.filter((e) => e.kind === "server").length ?? 0, other: entries?.filter((e) => e.kind === "other").length ?? 0 }), [entries]);
  const visible = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (entries || [])
      .filter((entry) => kind === "all" || entry.kind === kind)
      .filter((entry) => words.every((word) => `${entry.title} ${entry.login} ${entry.url} ${entry.host} ${entry.origin}`.toLowerCase().includes(word)));
  }, [entries, kind, search]);

  return (
    <div className="st-stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <Card
        title="Пароли"
        hint="Входы на сайты, серверы и любые другие доступы. Браузер MBOX подставляет и сохраняет пароли сайтов отсюда — на любом вашем компьютере. Пароли зашифрованы, агенту запись выдаётся только по вашему разрешению и на время."
        actions={(
          <>
            <button type="button" className="st-btn" onClick={() => setAdding(adding === "server" ? "" : "server")}><Server size={14} /> Сервер</button>
            <button type="button" className="st-btn is-primary" onClick={() => setAdding(adding && adding !== "server" ? "" : "site")}><Plus size={14} /> Добавить</button>
          </>
        )}
      >
        {adding && <EntryForm initial={emptyDraft(adding)} projects={projects} onCancel={() => setAdding("")} onSaved={() => { setAdding(""); void load(); }} />}
        <div className="st-toolbar">
          <label className="st-search">
            <Search size={14} aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск: сайт, сервер, логин" aria-label="Поиск паролей" />
            {search && <button type="button" aria-label="Очистить" onClick={() => setSearch("")}><X size={13} /></button>}
          </label>
          <Segments label="Вид записей" value={kind} onChange={setKind} items={[
            { id: "all", label: `Все ${counts.all}` },
            { id: "site", label: `Сайты ${counts.site}` },
            { id: "server", label: `Серверы ${counts.server}` },
            { id: "other", label: `Другое ${counts.other}` },
          ]} />
        </div>
        {entries === null ? <OctopusSpinner compact label="Загружаю пароли…" /> : (
          <Rows empty={search || kind !== "all" ? "Ничего не нашлось." : "Пока пусто. Пароли сайтов появятся сами, когда вы войдёте куда-нибудь во встроенном браузере и нажмёте «Сохранить»."}>
            {visible.map((entry) => (
              <Row
                key={entry.id}
                icon={KIND_ICON[entry.kind]}
                title={entry.title}
                meta={subtitle(entry)}
                side={approved(entry) ? <Badge tone="accent"><Bot size={11} /> у агента</Badge> : undefined}
                open={open === entry.id}
                onToggle={() => setOpen(open === entry.id ? "" : entry.id)}
                details={<EntryDetails entry={entry} projects={projects} onChanged={() => void load()} onDeleted={() => { setOpen(""); void load(); }} />}
              />
            ))}
          </Rows>
        )}
      </Card>
      {never.length > 0 && (
        <Card title="Браузер не предлагает сохранить пароль" hint="Сайты, где вы нажали «Никогда». Уберите сайт из списка, чтобы браузер снова предлагал.">
          <Rows>
            {never.map((origin) => (
              <Row key={origin} icon={Globe} title={origin.replace(/^https?:\/\//, "")} side={<button type="button" className="st-btn" onClick={async () => { await fetchJson(`/api/mbox/passwords/never?origin=${encodeURIComponent(origin)}`, { method: "DELETE" }); void load(); }}>Убрать</button>} />
            ))}
          </Rows>
        </Card>
      )}
    </div>
  );
}

function EntryDetails({ entry, projects, onChanged, onDeleted }: { entry: Entry; projects: Project[]; onChanged: () => void; onDeleted: () => void }) {
  const [secret, setSecret] = useState<{ password: string; notes: string } | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reveal() {
    if (secret) return secret;
    const value = await fetchJson<{ password: string; notes: string }>(`/api/mbox/secrets/${entry.id}/reveal`, { method: "POST" });
    setSecret(value);
    return value;
  }
  async function copy(what: "login" | "password" | "address") {
    try {
      const text = what === "login" ? entry.login : what === "address" ? (entry.kind === "server" ? `${entry.host}${entry.port ? `:${entry.port}` : ""}` : entry.url) : (await reveal()).password;
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1500);
    } catch (cause) { setError(errorText(cause, "Не удалось скопировать")); }
  }
  async function share(hours: number) {
    setBusy(true);
    try {
      await fetchJson(`/api/mbox/secrets/${entry.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(hours ? { agent_share_state: "approved", approved_until: new Date(Date.now() + hours * 3_600_000).toISOString() } : { agent_share_state: "locked", approved_until: null }) });
      onChanged();
    } catch (cause) { setError(errorText(cause, "Не удалось изменить доступ агента")); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!(await askConfirm({ title: `Удалить «${entry.title}»?`, message: entry.kind === "site" ? "Браузер перестанет подставлять этот пароль на всех компьютерах." : "Запись удалится насовсем.", confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/secrets/${entry.id}`, { method: "DELETE" });
    onDeleted();
  }

  if (editing) {
    return (
      <EntryForm
        id={entry.id}
        initial={{ kind: entry.kind, title: entry.title, login: entry.login, password: "", url: entry.url, host: entry.host, port: entry.port ? String(entry.port) : "", notes: secret?.notes ?? "", project_id: entry.project_id || "" }}
        notesLoaded={Boolean(secret) || !entry.has_notes}
        projects={projects}
        onCancel={() => setEditing(false)}
        onSaved={() => { setEditing(false); setSecret(null); onChanged(); }}
      />
    );
  }

  const address = entry.kind === "server" ? `${entry.host}${entry.port ? `:${entry.port}` : ""}` : entry.url;
  const project = projects.find((item) => item.id === entry.project_id);
  const copyButton = (what: "login" | "password" | "address", label: string) => (
    <button type="button" className="st-icon-btn" onClick={() => void copy(what)} aria-label={`Скопировать: ${label}`} title="Скопировать">{copied === what ? <Check size={14} /> : <Copy size={14} />}</button>
  );

  return (
    <div className="st-stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <dl className="st-facts st-secret">
        {address && <div><dt>{entry.kind === "server" ? "Хост" : "Адрес"}</dt><dd><span className="st-mono">{address}</span>{copyButton("address", "адрес")}</dd></div>}
        {entry.login && <div><dt>Логин</dt><dd><span className="st-mono">{entry.login}</span>{copyButton("login", "логин")}</dd></div>}
        <div>
          <dt>Пароль</dt>
          <dd>
            <span className="st-mono">{shown && secret ? secret.password || "—" : "••••••••••"}</span>
            <button type="button" className="st-icon-btn" aria-label={shown ? "Скрыть пароль" : "Показать пароль"} onClick={async () => { if (!shown) await reveal().catch((cause) => setError(errorText(cause, "Не удалось показать"))); setShown(!shown); }}>{shown ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            {copyButton("password", "пароль")}
          </dd>
        </div>
        {entry.has_notes && <div><dt>Заметки</dt><dd>{shown && secret ? <pre className="st-notes">{secret.notes}</pre> : <span className="st-muted">скрыты вместе с паролем</span>}</dd></div>}
        {project && <div><dt>Проект</dt><dd>{project.name}</dd></div>}
        <div><dt>Изменён</dt><dd>{formatSince(entry.updated_at)}{entry.uses ? ` · подставлен ${entry.uses} раз` : ""}{entry.source === "browser" ? " · сохранён браузером" : ""}</dd></div>
      </dl>
      <div className="st-group">
        <div className="st-share">
          <span><Bot size={14} aria-hidden="true" /> {approved(entry) ? `Агенты видят эту запись${entry.approved_until ? ` до ${new Date(entry.approved_until).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : "Агентам закрыто"}</span>
          <div className="st-actions">
            {approved(entry)
              ? <button type="button" className="st-btn" disabled={busy} onClick={() => void share(0)}>Закрыть</button>
              : SHARE_HOURS.map((hours) => <button key={hours} type="button" className="st-btn" disabled={busy} onClick={() => void share(hours)}>{hours < 24 ? `${hours} ч` : hours === 24 ? "Сутки" : "Неделя"}</button>)}
          </div>
        </div>
      </div>
      <div className="st-actions">
        <button type="button" className="st-btn" onClick={async () => { if (entry.has_notes) await reveal().catch(() => undefined); setEditing(true); }}><Pencil size={14} /> Изменить</button>
        <button type="button" className="st-btn is-danger" onClick={() => void remove()}><Trash2 size={14} /> Удалить</button>
      </div>
    </div>
  );
}

function EntryForm({ id, initial, notesLoaded = true, projects, onCancel, onSaved }: { id?: string; initial: Draft; notesLoaded?: boolean; projects: Project[]; onCancel: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {
      kind: draft.kind, title: draft.title, login: draft.login, url: draft.url, host: draft.host, port: draft.port ? Number(draft.port) : null,
      project_id: draft.project_id || null,
      ...(draft.password ? { password: draft.password } : {}),
      ...(notesLoaded ? { notes: draft.notes } : {}),
    };
    try {
      await fetchJson(id ? `/api/mbox/secrets/${id}` : "/api/mbox/secrets", { method: id ? "PATCH" : "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      onSaved();
    } catch (cause) { setError(errorText(cause, "Не удалось сохранить")); }
    finally { setBusy(false); }
  }

  return (
    <form className="st-form" onSubmit={submit}>
      <div className="st-form-head">
        <strong>{id ? "Изменить запись" : "Новая запись"}</strong>
        <Segments label="Вид записи" value={draft.kind} onChange={(kind) => set({ kind, port: kind === "server" && !draft.port ? "22" : draft.port })} items={(["site", "server", "other"] as Kind[]).map((kind) => ({ id: kind, label: KIND_LABEL[kind] }))} />
      </div>
      <div className="st-fields st-fields-2">
        {draft.kind === "site" && <Field label="Адрес сайта"><input value={draft.url} onChange={(event) => set({ url: event.target.value })} placeholder="https://site.ru" required autoFocus /></Field>}
        {draft.kind === "server" && (
          <div className="st-field-pair">
            <Field label="Хост или IP"><input value={draft.host} onChange={(event) => set({ host: event.target.value })} placeholder="203.0.113.10" required autoFocus /></Field>
            <Field label="Порт"><input value={draft.port} onChange={(event) => set({ port: event.target.value.replace(/\D/g, "").slice(0, 5) })} inputMode="numeric" placeholder="22" /></Field>
          </div>
        )}
        <Field label="Название" hint={draft.kind === "other" ? undefined : "Можно не заполнять"}><input value={draft.title} onChange={(event) => set({ title: event.target.value })} placeholder={draft.kind === "server" ? "Боевой сервер" : draft.kind === "site" ? "Как сайт в списке" : "Например, Wi-Fi офиса"} required={draft.kind === "other"} autoFocus={draft.kind === "other"} /></Field>
        <Field label="Логин"><input value={draft.login} onChange={(event) => set({ login: event.target.value })} autoComplete="off" placeholder={draft.kind === "server" ? "root" : ""} /></Field>
        <Field label="Пароль" hint={id ? "Пусто — оставить прежний" : undefined}><PasswordInput value={draft.password} onChange={(event) => set({ password: event.target.value })} autoComplete="new-password" required={!id && draft.kind === "site"} /></Field>
        {draft.kind === "other" && <Field label="Адрес" hint="Необязательно"><input value={draft.url} onChange={(event) => set({ url: event.target.value })} /></Field>}
        <Field label="Проект" hint="Для выдачи агенту в контексте проекта">
          <select value={draft.project_id} onChange={(event) => set({ project_id: event.target.value })}>
            <option value="">Без проекта</option>
            {projects.filter((project) => project.status !== "archived").map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>
        {notesLoaded && <Field label="Заметки" hint="Ключ SSH, коды восстановления, что угодно — хранится зашифрованным" wide><textarea value={draft.notes} onChange={(event) => set({ notes: event.target.value })} rows={draft.kind === "server" ? 4 : 3} spellCheck={false} /></Field>}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-actions">
        <button type="submit" className="st-btn is-primary" disabled={busy}>{busy ? "Сохраняю…" : id ? "Сохранить" : "Добавить"}</button>
        <button type="button" className="st-btn" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
