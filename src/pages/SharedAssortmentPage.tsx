import { useEffect, useState, type FormEvent } from "react";
import { Contrast, LogOut, Lock } from "lucide-react";
import { OctopusSpinner } from "../components/OctopusSpinner";
import { AssortmentBoard, type AssortmentShared } from "./Assortment";
import "../styles/shared-seo.css";

/**
 * Ассортимент без входа в MBOX: по ссылке (/a/<токен>) или по логину и паролю (/assortment-access).
 * Все вызовы идут через /api/share/assortment/…: сервер сам решает, что можно (просмотр или управление, чат или нет).
 */
type Theme = "light" | "graphite" | "black";
const THEME_KEY = "mbox.shared-seo-theme";
const THEMES: Theme[] = ["light", "graphite", "black"];
const THEME_LABEL: Record<Theme, string> = { light: "Светлая", graphite: "Графитовая", black: "Чёрная" };

type Phase = "loading" | "login" | "ready" | "revoked" | "error";
type Me = { mode: "view" | "manage"; chat: boolean; chat_agent?: "jarvis" | "claude" | "codex"; label: string; kind: "link" | "login" };

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "graphite" || stored === "black") return stored;
  } catch { /* без памяти — графитовая */ }
  return "graphite";
}

export function SharedAssortmentPage({ token }: { token: string | null }) {
  const base = token ? `/api/share/assortment/${token}/` : "/api/share/assortment/session/";
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [form, setForm] = useState({ login: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* не сохранилось — не страшно */ }
  }, [theme]);

  useEffect(() => {
    document.title = "Ассортимент";
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${base}me`, { credentials: "same-origin" });
        if (cancelled) return;
        if (response.ok) { setMe((await response.json()) as Me); setPhase("ready"); return; }
        setPhase(token ? "revoked" : "login");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => { cancelled = true; };
  }, [base, token]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/share/assortment/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(form) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 429) { setError(`Слишком много неверных попыток. Подождите ${Math.ceil((body.retry_after_seconds || 60) / 60)} мин и повторите.`); return; }
      if (!response.ok) { setError("Неверный логин или пароль. Проверьте раскладку и регистр."); return; }
      window.location.reload();
    } catch {
      setError("Нет связи с сервером. Повторите, когда сеть появится.");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/share/assortment/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    window.location.reload();
  };

  const shared: AssortmentShared | null = me ? { base, mode: me.mode, chat: me.chat, agent: me.chat_agent ?? "jarvis", label: me.label, kind: me.kind } : null;
  const nextTheme = () => setTheme((value) => THEMES[(THEMES.indexOf(value) + 1) % THEMES.length]);

  return (
    <div className="shared-seo shared-assortment">
      <div className="shared-seo-bar">
        <span className="shared-seo-name">Ассортимент</span>
        {me && <span className="shared-seo-badge">{me.mode === "manage" ? "Управление" : "Просмотр"}{me.kind === "login" && me.label ? ` · ${me.label}` : ""}</span>}
        <span className="shared-seo-space" />
        <button type="button" onClick={nextTheme} title="Сменить тему"><Contrast size={14} aria-hidden="true" /> {THEME_LABEL[theme]}</button>
        {me?.kind === "login" && <button type="button" onClick={() => void signOut()}><LogOut size={14} aria-hidden="true" /> Выйти</button>}
      </div>
      {phase === "loading" && <div className="shared-seo-center"><OctopusSpinner size={32} /></div>}
      {phase === "revoked" && <div className="shared-seo-center"><div className="shared-seo-card"><h1>Ссылка не работает</h1><p>Её отозвали или заменили новой. Попросите у владельца свежую ссылку.</p></div></div>}
      {phase === "error" && <div className="shared-seo-center"><div className="shared-seo-card"><h1>Нет связи с сервером</h1><p>Не удалось открыть ассортимент. Обновите страницу, когда сеть появится.</p></div></div>}
      {phase === "login" && (
        <div className="shared-seo-center">
          <form className="shared-seo-card" onSubmit={signIn}>
            <h1><Lock size={18} aria-hidden="true" /> Вход в ассортимент</h1>
            <p>Введите логин и пароль, которые вам дал владелец.</p>
            <label>Логин<input value={form.login} onChange={(event) => setForm({ ...form, login: event.currentTarget.value })} autoComplete="username" autoFocus required /></label>
            <label>Пароль<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.currentTarget.value })} autoComplete="current-password" required /></label>
            {error && <p className="shared-seo-error" role="alert">{error}</p>}
            <button type="submit" disabled={busy || !form.login || !form.password}>{busy ? "Проверяю…" : "Войти"}</button>
          </form>
        </div>
      )}
      {phase === "ready" && shared && <AssortmentBoard shared={shared} />}
    </div>
  );
}
