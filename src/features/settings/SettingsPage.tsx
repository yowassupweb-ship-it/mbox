import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bot, Contrast, History, LockKeyhole, LogOut, Moon, Plug, Send, Server, ShieldCheck, Sparkles, Sun, UserRound, Users, type LucideIcon } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { notifyDesktopSignedOut } from "../../lib/desktopAccount";
import { PasswordInput } from "../../ui";
import { showNotice } from "../../ui/askText";
import { RAIL_GROUPS, setRailHidden, useRailHidden, type RailItemId } from "../../app/workbench/rail";
import { scopedStorageKey } from "../../app/workbench/tabs";
import { accountErrorText } from "../accounts/accountErrors";
import { PasswordPanel } from "../accounts/PasswordPanel";
import { SessionsPanel } from "../accounts/SessionsPanel";
import { AgentsOnThisComputer } from "../agents/AgentsOnThisComputer";
import { TelegramBotPanel } from "../integrations/TelegramBotPanel";
import { McpHttpPanel } from "./McpHttpPanel";
import type { Company, Project } from "../../types";

export type AppTheme = "light" | "graphite" | "black";

type SectionId = "profile" | "security" | "appearance" | "team" | "agents" | "telegram" | "mcp" | "skills" | "secrets" | "server" | "logs";
type Section = { id: SectionId; label: string; hint: string; icon: LucideIcon; show: boolean; body: ReactNode };

const STORAGE = "mbox.settings.section";

/**
 * Настройки: слева разделы по группам, справа выбранный раздел карточками. Раньше это была полоса из семи «таблеток» и под каждой
 * своя свёрстка в старом стиле панелей; теперь одна навигация и один набор карточек (src/styles/settings.css, токены доктрины).
 * Внутри карточек — прежние компоненты (команда, секреты, сервер): их оболочку `.panel` стили settings.css приводят к тому же виду.
 */
export function SettingsPage({ user, theme, onThemeChange, onLogout, projects, companies, team, skills, secrets, server, logs }: {
  user: { id?: string; username: string; role: string };
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  onLogout: () => void;
  projects: Project[];
  companies: Company[];
  team: ReactNode;
  skills: ReactNode;
  secrets?: ReactNode;
  server?: ReactNode;
  logs: ReactNode;
}) {
  const owner = user.role === "owner";
  const groups: Array<{ title: string; items: Section[] }> = [
    {
      title: "Аккаунт",
      items: [
        { id: "profile", label: "Профиль", hint: "Логин и роль", icon: UserRound, show: true, body: <ProfileSection user={user} onLogout={onLogout} /> },
        { id: "security", label: "Безопасность", hint: "Пароль и устройства", icon: ShieldCheck, show: true, body: <SecuritySection onSignedOut={onLogout} /> },
        { id: "appearance", label: "Интерфейс", hint: "Тема и боковые вкладки", icon: Contrast, show: true, body: <AppearanceSection theme={theme} onChange={onThemeChange} /> },
      ],
    },
    {
      title: "Рабочее пространство",
      items: [
        { id: "team", label: "Команда", hint: "Люди, приглашения, доступ", icon: Users, show: true, body: team },
        { id: "agents", label: "Агенты", hint: "Claude и Codex на этом компьютере", icon: Bot, show: true, body: <AgentsOnThisComputer username={user.username} /> },
        { id: "telegram", label: "Telegram", hint: "Боты, чаты и доступ агентов", icon: Send, show: true, body: <TelegramBotPanel projects={projects} companies={companies} /> },
        { id: "mcp", label: "MCP для ChatGPT", hint: "Публичный адрес и ключи доступа", icon: Plug, show: true, body: <McpHttpPanel /> },
        { id: "skills", label: "Мои навыки", hint: "Кому открыты ваши навыки", icon: Sparkles, show: true, body: skills },
        { id: "secrets", label: "Секреты", hint: "Пароли и ключи для агентов", icon: LockKeyhole, show: Boolean(secrets), body: secrets },
      ],
    },
    {
      title: "Система",
      items: [
        { id: "server", label: "Сервер", hint: "Нагрузка, контейнеры, узлы", icon: Server, show: owner && Boolean(server), body: server },
        { id: "logs", label: "Логи", hint: "Запуски агентов и решения", icon: History, show: true, body: logs },
      ],
    },
  ];
  const visible = groups.map((group) => ({ ...group, items: group.items.filter((item) => item.show) })).filter((group) => group.items.length);
  const all = visible.flatMap((group) => group.items);

  const [active, setActive] = useState<SectionId>(() => {
    try { const saved = window.localStorage.getItem(scopedStorageKey(STORAGE)); return saved && all.some((item) => item.id === saved) ? (saved as SectionId) : "profile"; } catch { return "profile"; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(scopedStorageKey(STORAGE), active); } catch { /* без памяти раздела */ }
  }, [active]);
  const current = all.find((item) => item.id === active) ?? all[0];

  return (
    <div className="st-page">
      <div className="st-layout">
      <nav className="st-nav" aria-label="Разделы настроек">
        {visible.map((group) => (
          <div className="st-nav-group" key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} type="button" className={item.id === current.id ? "st-nav-item is-active" : "st-nav-item"} aria-current={item.id === current.id ? "page" : undefined} onClick={() => setActive(item.id)}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <main className="st-main" key={current.id}>
        <header className="st-head">
          <h1>{current.label}</h1>
          <p>{current.hint}</p>
        </header>
        <div className="st-content">{current.body}</div>
      </main>
      </div>
    </div>
  );
}

function ProfileSection({ user, onLogout }: { user: { username: string; role: string }; onLogout: () => void }) {
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
      await fetchJson("/api/mbox/account/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), current_password: password }),
      });
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
      <div className="st-card">
        <header className="st-card-head"><h3>Учётная запись</h3></header>
        <dl className="st-facts">
          <div><dt>Логин</dt><dd>{user.username}</dd></div>
          <div><dt>Роль</dt><dd>{user.role === "owner" ? "Владелец: ваш MBOX, команда и настройки сервера" : "Участник: свой MBOX, свои проекты, навыки и интеграции; общие проекты — по приглашению"}</dd></div>
        </dl>
        <div className="st-actions">
          <button type="button" className="st-btn" onClick={async () => { await notifyDesktopSignedOut(); await fetch("/api/mbox/auth/logout", { method: "POST" }); onLogout(); }}><LogOut size={14} /> Выйти</button>
        </div>
      </div>
      <form className="st-card" onSubmit={submit}>
        <header className="st-card-head"><h3>Сменить логин</h3></header>
        <p className="st-muted">2–32 символа: буквы, цифры, пробел, точка, дефис или подчёркивание. Токены, устройства и агенты останутся на месте; старые подписи в истории сохранят прежнее имя.</p>
        <div className="st-fields">
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Новый логин" aria-label="Новый логин" autoComplete="username" minLength={2} maxLength={32} required />
          <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Текущий пароль для подтверждения" autoComplete="current-password" required />
        </div>
        {error && <p className="st-error" role="alert">{error}</p>}
        <div className="st-actions">
          <button type="submit" className="st-btn is-primary" disabled={busy || !changed || !password}>{busy ? "Сохраняю…" : "Сменить логин"}</button>
        </div>
      </form>
    </div>
  );
}

function SecuritySection({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <div className="st-stack">
      <PasswordPanel />
      <SessionsPanel onSignedOut={onSignedOut} />
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
      <div className="st-card">
        <header className="st-card-head"><h3>Тема</h3><span className="st-note">Сохраняется на этом устройстве</span></header>
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
        <p className="st-muted">Inter — для интерфейса и документов. Моноширинный шрифт остаётся только в коде, терминале и технических данных.</p>
      </div>
      <div className="st-card">
        <header className="st-card-head"><h3>Разделы в левой полосе</h3><span className="st-note">Сохраняется на этом устройстве</span></header>
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
      </div>
    </div>
  );
}
