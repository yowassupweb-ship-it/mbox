import { Check, Copy, KeyRound, Link2, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchJson } from "../../lib/api";
import { serverOrigin } from "../../lib/serverOrigin";

/**
 * «Поделиться» SEO Wizard (только владелец). Два способа: ссылка (просмотр или управление) и вход по логину и паролю.
 * Человек видит только SEO Wizard: настройки, ключи и остальной MBOX ему недоступны. Ссылку можно отозвать или перевыпустить,
 * логин — удалить, смена пароля закрывает его открытые сессии.
 */
type Link = { mode: "view" | "manage"; token: string; created_at?: string; last_used_at?: string | null; use_count?: number } | null;
type Login = { id: string; login: string; mode: "view" | "manage"; label: string; created_at: string; last_used_at: string | null; expires_at: string | null; use_count: number; sessions: number };
type State = { base_url?: string; links: { view: Link; manage: Link }; logins: Login[] };

const MODE_WORD = { view: "Просмотр", manage: "Управление" } as const;
const MODE_HINT = {
  view: "Видит все таблицы, находки, календарь и карточки страниц, может перепроверять находки. Ничего не меняет.",
  manage: "Всё то же, плюс: переводит находки в задачи и в шум, пишет решения и журнал изменений, запускает сбор. Настроек и ключей не видит.",
} as const;

const stamp = (value?: string | null) => {
  if (!value) return "ещё не открывали";
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? value.slice(0, 16) : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function errorText(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.code === "login_taken") return "Такой логин уже есть: выберите другой.";
    if (cause.code === "invalid_login") return "Логин: 3–40 знаков, латиница, цифры, точка, дефис, подчёркивание.";
    if (cause.code === "weak_password") return "Пароль короче 8 знаков.";
    return `Сервер ответил ошибкой ${cause.status}${cause.code ? `: ${cause.code}` : ""}.`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function SeoShareDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  const [fresh, setFresh] = useState<{ login: string; password: string; mode: "view" | "manage" } | null>(null);
  const [form, setForm] = useState({ login: "", password: "", mode: "view" as "view" | "manage", label: "", days: "0" });
  // Ссылки отдаём наружу, поэтому адрес сервера, а не внутренний адрес окна приложения (mbox://app).
  // Адрес для ссылок: сначала тот, что назвал сервер (верный в любой версии приложения), иначе адрес сервера из окна.
  const origin = (state?.base_url || serverOrigin()).replace(/\/+$/, "");

  const load = useCallback(async () => {
    try { setState(await fetchJson<State>("/api/mbox/seo/shares")); setError(""); } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try { await run(); await load(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(""); }
  };
  const json = { "content-type": "application/json" };
  const copyText = async (key: string, text: string) => {
    if (await copy(text)) { setCopied(key); window.setTimeout(() => setCopied((value) => (value === key ? "" : value)), 2000); }
  };

  const createLink = (mode: "view" | "manage", regenerate = false) => act(`link:${mode}`, () => fetchJson("/api/mbox/seo/shares/link", { method: "POST", headers: json, body: JSON.stringify({ mode, regenerate }) }));
  const removeLink = (mode: "view" | "manage") => act(`link:${mode}`, () => fetchJson(`/api/mbox/seo/shares/link/${mode}`, { method: "DELETE" }));
  const createLogin = () => act("login:new", async () => {
    const result = await fetchJson<{ login: Login; password?: string }>("/api/mbox/seo/shares/login", { method: "POST", headers: json, body: JSON.stringify({ login: form.login, password: form.password, mode: form.mode, label: form.label, days: Number(form.days) || 0 }) });
    setFresh({ login: result.login.login, password: result.password || form.password, mode: form.mode });
    setForm({ login: "", password: "", mode: form.mode, label: "", days: "0" });
  });
  const removeLogin = (item: Login) => act(`login:${item.id}`, () => fetchJson(`/api/mbox/seo/shares/login/${item.id}`, { method: "DELETE" }));
  const newPassword = (item: Login) => act(`login:${item.id}`, async () => {
    const result = await fetchJson<{ password: string }>(`/api/mbox/seo/shares/login/${item.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ regeneratePassword: true }) });
    setFresh({ login: item.login, password: result.password, mode: item.mode });
  });
  const setMode = (item: Login, mode: "view" | "manage") => act(`login:${item.id}`, () => fetchJson(`/api/mbox/seo/shares/login/${item.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ mode }) }));

  const loginUrl = `${origin}/seo-access`;
  const message = (value: { login: string; password: string }) => `SEO Wizard: ${loginUrl}\nЛогин: ${value.login}\nПароль: ${value.password}`;

  return (
    <div className="seo-detail-scrim" onClick={onClose}>
      <aside className="seo-detail seo-share" role="dialog" aria-modal="true" aria-label="Поделиться SEO Wizard" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Поделиться SEO Wizard</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <p className="seo-form-hint">Человек увидит только SEO Wizard. Настройки, ключи подключённых сервисов и остальной MBOX ему недоступны ни по ссылке, ни по паролю.</p>
        {error && <p className="seo-error" role="alert">{error}</p>}
        {!state && !error && <p className="seo-form-hint">Загружаю…</p>}

        {state && (
          <>
            <h3><Link2 size={14} aria-hidden="true" /> По ссылке</h3>
            <p className="seo-form-hint">Любой, у кого есть ссылка, откроет SEO Wizard без входа. Не публикуйте её открыто. Отозвать или заменить можно в любой момент.</p>
            {(["view", "manage"] as const).map((mode) => {
              const link = state.links[mode];
              const url = link ? `${origin}/s/${link.token}` : "";
              return (
                <div key={mode} className="seo-share-row">
                  <div className="seo-share-head"><strong>{MODE_WORD[mode]}</strong><span>{MODE_HINT[mode]}</span></div>
                  {link ? (
                    <>
                      <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${MODE_WORD[mode]}`} />
                      <div className="seo-share-actions">
                        <button type="button" onClick={() => void copyText(`link:${mode}`, url)}>{copied === `link:${mode}` ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied === `link:${mode}` ? "Скопировано" : "Копировать"}</button>
                        <button type="button" disabled={busy === `link:${mode}`} onClick={() => void createLink(mode, true)} title="Старая ссылка перестанет работать"><RefreshCw size={13} aria-hidden="true" /> Заменить</button>
                        <button type="button" disabled={busy === `link:${mode}`} onClick={() => void removeLink(mode)}><Trash2 size={13} aria-hidden="true" /> Отключить</button>
                      </div>
                      <small>Открывали: {link.use_count ?? 0} · последний раз: {stamp(link.last_used_at)}</small>
                    </>
                  ) : (
                    <div className="seo-share-actions"><button type="button" disabled={busy === `link:${mode}`} onClick={() => void createLink(mode)}><Link2 size={13} aria-hidden="true" /> Создать ссылку</button></div>
                  )}
                </div>
              );
            })}

            <h3><KeyRound size={14} aria-hidden="true" /> По логину и паролю</h3>
            <p className="seo-form-hint">Вы задаёте логин и пароль, человек входит на странице <code>{loginUrl}</code>. Надёжнее ссылки: доступ привязан к человеку, его можно отключить отдельно, а после пяти неверных паролей вход замедляется.</p>
            {fresh && (
              <div className="seo-share-fresh" role="status">
                <strong>Доступ создан. Пароль покажу один раз: сохраните или отправьте сейчас.</strong>
                <pre>{message(fresh)}</pre>
                <button type="button" onClick={() => void copyText("fresh", message(fresh))}>{copied === "fresh" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied === "fresh" ? "Скопировано" : "Копировать сообщение"}</button>
              </div>
            )}
            {state.logins.length > 0 && (
              <ul className="seo-share-logins">
                {state.logins.map((item) => (
                  <li key={item.id}>
                    <div>
                      <span className="seo-share-name"><strong>{item.login}</strong>{item.label && <em>{item.label}</em>}</span>
                      <small>{stamp(item.last_used_at)} · входов {item.use_count} · сейчас открыто {item.sessions}{item.expires_at ? ` · до ${stamp(item.expires_at)}` : ""}</small>
                    </div>
                    <select value={item.mode} onChange={(event) => void setMode(item, event.currentTarget.value as "view" | "manage")} disabled={busy === `login:${item.id}`} aria-label={`Режим доступа ${item.login}`}>
                      <option value="view">Просмотр</option>
                      <option value="manage">Управление</option>
                    </select>
                    <button type="button" disabled={busy === `login:${item.id}`} onClick={() => void newPassword(item)} title="Выдать новый пароль, старый перестанет работать">Новый пароль</button>
                    <button type="button" disabled={busy === `login:${item.id}`} onClick={() => void removeLogin(item)} aria-label={`Удалить доступ ${item.login}`}><Trash2 size={13} aria-hidden="true" /></button>
                  </li>
                ))}
              </ul>
            )}
            <h4 className="seo-share-subhead">Новый доступ</h4>
            <form className="seo-share-form" onSubmit={(event) => { event.preventDefault(); void createLogin(); }}>
              <label>Логин<input value={form.login} onChange={(event) => setForm({ ...form, login: event.currentTarget.value })} placeholder="например, ivan" autoComplete="off" required /></label>
              <label>Пароль<input value={form.password} onChange={(event) => setForm({ ...form, password: event.currentTarget.value })} placeholder="пусто — придумаю сам" autoComplete="off" /></label>
              <label>Режим<select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.currentTarget.value as "view" | "manage" })}><option value="view">Просмотр</option><option value="manage">Управление</option></select></label>
              <label>Кому<input value={form.label} onChange={(event) => setForm({ ...form, label: event.currentTarget.value })} placeholder="имя, чтобы не забыть" /></label>
              <label>Срок<select value={form.days} onChange={(event) => setForm({ ...form, days: event.currentTarget.value })}><option value="0">Без срока</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="90">90 дней</option></select></label>
              <button type="submit" className="is-primary" disabled={busy === "login:new" || !form.login.trim()}>{busy === "login:new" ? "Создаю…" : "Создать доступ"}</button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
