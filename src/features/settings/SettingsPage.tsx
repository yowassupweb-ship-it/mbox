import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Contrast, Laptop, LogOut, Monitor, Moon, Smartphone, Sun, type LucideIcon } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { notifyDesktopSignedOut } from "../../lib/desktopAccount";
import { formatDateTime, formatSince } from "../../lib/format";
import { PasswordInput } from "../../ui";
import { askConfirm, showNotice } from "../../ui/askText";
import { RAIL_GROUPS, setRailHidden, useRailHidden, type RailItemId } from "../../app/workbench/rail";
import { accountErrorText } from "../accounts/accountErrors";
import { AgentsOnThisComputer } from "../agents/AgentsOnThisComputer";
import { TelegramBotPanel } from "../integrations/TelegramBotPanel";
import { SkillAccessBoard } from "../skills/SkillAccessBoard";
import type { AgentRun, Company, DecisionEntry, Project } from "../../types";
import { GoogleSection } from "./GoogleSection";
import { McpHttpPanel } from "./McpHttpPanel";
import { PasswordsSection } from "./PasswordsSection";
import { LogsSection, ServerSection } from "./SystemSections";
import { TeamSection } from "./TeamSection";
import { Badge, Card, Field, Notice, Row, Rows } from "./parts";
import { sectionById, useSettingsSection, visibleGroups, type SettingsSectionId } from "./sections";

export type AppTheme = "light" | "graphite" | "black";

type User = { id?: string; username: string; role: string };

/**
 * Настройки. Список разделов — в обычной боковой панели MBOX (SettingsSidebar), здесь только выбранный раздел: заголовок и карточки
 * из одного набора кирпичей (parts.tsx, src/styles/settings.css). На узкой вкладке и телефоне, где боковой панели нет, разделы —
 * лентой сверху.
 */
export function SettingsPage({ user, theme, onThemeChange, onLogout, projects, companies, runs, decisions, pulse, onReload }: {
  user: User;
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  onLogout: () => void;
  projects: Project[];
  companies: Company[];
  runs: AgentRun[];
  decisions: DecisionEntry[];
  pulse: number;
  onReload: () => void;
}) {
  const owner = user.role === "owner";
  const [requested, setSection] = useSettingsSection();
  const groups = visibleGroups(owner);
  const allowed = groups.flatMap((group) => group.items);
  const current = allowed.find((item) => item.id === requested) ?? allowed[0];

  const body: Record<SettingsSectionId, () => ReactNode> = {
    profile: () => <ProfileSection user={user} onLogout={onLogout} />,
    security: () => <SecuritySection onSignedOut={onLogout} />,
    appearance: () => <AppearanceSection theme={theme} onChange={onThemeChange} />,
    google: () => <GoogleSection owner={owner} />,
    telegram: () => <div className="st-legacy"><TelegramBotPanel projects={projects} companies={companies} /></div>,
    agents: () => <div className="st-legacy"><AgentsOnThisComputer username={user.username} /></div>,
    mcp: () => <McpHttpPanel />,
    passwords: () => <PasswordsSection projects={projects} />,
    skills: () => <div className="st-legacy"><SkillAccessBoard /></div>,
    team: () => <TeamSection projects={projects} companies={companies} onReload={onReload} />,
    server: () => <ServerSection pulse={pulse} />,
    logs: () => <LogsSection runs={runs} decisions={decisions} />,
  };

  return (
    <div className="st-page">
      <nav className="st-strip" aria-label="Разделы настроек">
        {allowed.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className={item.id === current.id ? "is-active" : undefined} aria-current={item.id === current.id ? "page" : undefined} onClick={() => setSection(item.id)}>
              <Icon size={14} aria-hidden="true" /> {item.label}
            </button>
          );
        })}
      </nav>
      <main className="st-main" key={current.id}>
        <header className="st-head">
          <h1>{sectionById(current.id).label}</h1>
          <p>{current.hint}</p>
        </header>
        <div className="st-content">{body[current.id]()}</div>
      </main>
    </div>
  );
}

function ProfileSection({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [username, setUsername] = useState(user.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = username.trim() !== user.username;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await fetchJson("/api/mbox/account/username", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: username.trim(), current_password: password }) });
      showNotice("Логин изменён", "Приложение обновится, чтобы подхватить новое имя.");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setError(accountErrorText(cause, "Не удалось сменить логин. Попробуйте ещё раз"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="st-stack">
      <Card>
        <div className="st-profile">
          <span className="st-avatar is-large" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
          <div className="st-profile-text">
            <strong>{user.username}</strong>
            <span>{user.role === "owner" ? "Владелец: ваш MBOX, команда и сервер" : "Участник: свои проекты, навыки и подключения; общие проекты — по приглашению"}</span>
          </div>
          <button type="button" className="st-btn" onClick={async () => { await notifyDesktopSignedOut(); await fetch("/api/mbox/auth/logout", { method: "POST" }); onLogout(); }}><LogOut size={14} /> Выйти</button>
        </div>
      </Card>
      <Card title="Сменить логин" hint="2–32 символа: буквы, цифры, пробел, точка, дефис, подчёркивание. Устройства, ключи и агенты останутся на месте; старые подписи в истории сохранят прежнее имя.">
        <form className="st-form is-plain" onSubmit={submit}>
          <div className="st-fields st-fields-2">
            <Field label="Новый логин"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={2} maxLength={32} required /></Field>
            <Field label="Текущий пароль" hint="Для подтверждения"><PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></Field>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="st-actions"><button type="submit" className="st-btn is-primary" disabled={busy || !changed || !password}>{busy ? "Сохраняю…" : "Сменить логин"}</button></div>
        </form>
      </Card>
    </div>
  );
}

type Session = { id: string; user_agent: string; ip: string; created_at: string; last_used_at: string | null; expires_at: string; current: boolean };

/** «Chrome · Windows», «MBOX Desktop · Windows», «Агент или скрипт» — человеку важно устройство, а не строка User-Agent. */
function deviceOf(agent: string) {
  const ua = agent || "";
  const system = /Windows/i.test(ua) ? "Windows" : /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const browser = /MBOXDesktop/i.test(ua) ? "MBOX Desktop" : /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /node|undici|curl/i.test(ua) ? "Агент или скрипт" : ua ? "Другой клиент" : "Неизвестное устройство";
  return { label: [browser, system].filter(Boolean).join(" · "), icon: (/Android|iPhone|iPad/i.test(ua) ? Smartphone : /MBOXDesktop/i.test(ua) ? Monitor : Laptop) as LucideIcon };
}

function SecuritySection({ onSignedOut }: { onSignedOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);

  const load = useCallback(() => fetchJson<{ sessions: Session[] }>("/api/mbox/account/sessions").then((result) => setSessions(result.sessions)).catch(() => setError("Не удалось загрузить устройства")), []);
  useEffect(() => {
    void load();
    fetchJson<{ default_password: boolean; temporary_password?: boolean }>("/api/mbox/account/security").then((result) => {
      setWarning(result.default_password ? "Сейчас задан пароль из установки — смените его." : result.temporary_password ? "Пароль выдан владельцем при сбросе — задайте свой. Временный введите как текущий." : "");
    }).catch(() => undefined);
  }, [load]);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (next !== repeat) { setError("Новые пароли не совпадают"); return; }
    setBusy("password");
    try {
      await fetchJson("/api/mbox/account/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current_password: current, new_password: next }) });
      setCurrent(""); setNext(""); setRepeat(""); setWarning("");
      showNotice("Пароль изменён", "На других устройствах придётся войти заново.");
      void load();
    } catch (cause) { setError(accountErrorText(cause, "Не удалось сменить пароль. Попробуйте ещё раз")); }
    finally { setBusy(""); }
  }

  async function revoke(session: Session) {
    if (session.current && !(await askConfirm({ title: "Выйти на этом устройстве?", message: "Вы выйдете из MBOX здесь.", confirmLabel: "Выйти", danger: true }))) return;
    setBusy(session.id);
    try {
      await fetchJson(`/api/mbox/account/sessions/${session.id}`, { method: "DELETE" });
      if (session.current) { onSignedOut(); return; }
      await load();
    } catch { setError("Не удалось завершить сессию"); }
    finally { setBusy(""); }
  }

  async function revokeOthers() {
    if (!(await askConfirm({ title: "Завершить все остальные сессии?", message: "На других устройствах и у агентов, которые вошли по паролю, придётся войти заново.", confirmLabel: "Завершить", danger: true }))) return;
    setBusy("others");
    try { await fetchJson("/api/mbox/account/sessions/revoke-others", { method: "POST" }); await load(); }
    catch { setError("Не удалось завершить сессии"); }
    finally { setBusy(""); }
  }

  const others = sessions.filter((session) => !session.current).length;

  return (
    <div className="st-stack">
      {warning && <Notice tone="warn">{warning}</Notice>}
      <Card title="Пароль входа" hint="Минимум 8 знаков. После смены на других устройствах придётся войти заново.">
        <form className="st-form is-plain" onSubmit={changePassword}>
          <div className="st-fields st-fields-3">
            <Field label="Текущий"><PasswordInput value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required /></Field>
            <Field label="Новый"><PasswordInput value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={8} required /></Field>
            <Field label="Ещё раз"><PasswordInput value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" minLength={8} required /></Field>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="st-actions"><button type="submit" className="st-btn is-primary" disabled={busy !== "" || !current || next.length < 8 || !repeat}>{busy === "password" ? "Сохраняю…" : "Сменить пароль"}</button></div>
        </form>
      </Card>
      <Card
        title={`Где выполнен вход · ${sessions.length}`}
        actions={others > 0 && <button type="button" className="st-btn is-danger" disabled={busy !== ""} onClick={() => void revokeOthers()}><LogOut size={14} /> Завершить остальные ({others})</button>}
      >
        <Rows empty="Активных сессий нет.">
          {sessions.map((session) => {
            const device = deviceOf(session.user_agent);
            return (
              <Row
                key={session.id}
                icon={device.icon}
                title={<>{device.label}{session.current && <Badge tone="ok">это устройство</Badge>}</>}
                meta={`${session.ip ? `${session.ip} · ` : ""}вход ${formatDateTime(session.created_at)} · активность ${session.last_used_at ? formatSince(session.last_used_at) : "—"}`}
                side={<button type="button" className="st-btn" disabled={busy !== ""} onClick={() => void revoke(session)}>{session.current ? "Выйти" : "Завершить"}</button>}
              />
            );
          })}
        </Rows>
      </Card>
    </div>
  );
}

const THEME_OPTIONS: Array<{ id: AppTheme; title: string; description: string; icon: LucideIcon }> = [
  { id: "light", title: "Светлая", description: "Чистая спокойная поверхность для дневной работы", icon: Sun },
  { id: "graphite", title: "Графитовая", description: "Мягкий тёмно-серый фон с умеренным контрастом", icon: Contrast },
  { id: "black", title: "Тёмная", description: "Глубокий чёрный фон для работы вечером", icon: Moon },
];

function AppearanceSection({ theme, onChange }: { theme: AppTheme; onChange: (theme: AppTheme) => void }) {
  const hidden = useRailHidden();
  const toggle = (id: RailItemId, show: boolean) => setRailHidden(show ? hidden.filter((item) => item !== id) : [...hidden.filter((item) => item !== id), id]);
  return (
    <div className="st-stack">
      <Card title="Тема" hint="Сохраняется на этом устройстве.">
        <div className="st-themes" role="radiogroup" aria-label="Тема интерфейса">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = theme === option.id;
            return (
              <button key={option.id} type="button" role="radio" aria-checked={selected} className={selected ? "st-theme is-selected" : "st-theme"} onClick={() => onChange(option.id)}>
                <span className={`st-theme-preview is-${option.id}`} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
                <span className="st-theme-copy"><strong><Icon size={14} aria-hidden="true" /> {option.title}</strong><small>{option.description}</small></span>
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Разделы в левой полосе" hint="Что показывать значками слева. Сохраняется на этом устройстве.">
        <div className="st-rail">
          {RAIL_GROUPS.map((group) => (
            <div key={group.id} className="st-rail-group">
              <h4>{group.title}</h4>
              {group.items.map((item) => {
                const shown = !hidden.includes(item.id);
                return (
                  <label key={item.id} className="st-check">
                    <input type="checkbox" checked={shown} disabled={item.required} onChange={(event) => toggle(item.id, event.target.checked)} />
                    <img src={item.icon} alt="" width={18} height={18} />
                    <span>{item.label.replace(/\s*\([^)]*\)$/, "")}</span>
                    {item.required && <small>всегда виден</small>}
                    {item.desktopOnly && <small>только в приложении</small>}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
