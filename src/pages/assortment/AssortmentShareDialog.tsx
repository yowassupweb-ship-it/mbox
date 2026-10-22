import { Check, Copy, KeyRound, Link2, MessageSquare, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { ApiError, fetchJson } from "../../lib/api";
import { serverOrigin } from "../../lib/serverOrigin";
import "../../styles/shared-seo.css";

/**
 * «Поделиться» ассортиментом (только владелец). Два способа: ссылка и вход по логину и паролю. У каждого доступа два выбора:
 * права (просмотр или управление) и состав (только инструмент или инструмент + чат с агентом). Человек видит только ассортимент:
 * настройки, ключи и остальной MBOX ему недоступны. Ссылку можно отозвать или перевыпустить, смена пароля, прав и чата закрывает открытые сессии.
 */
type Mode = "view" | "manage";
type Agent = "jarvis" | "claude" | "codex";
type Link = { id: string; mode: Mode; chat: boolean; chat_agent: Agent; advice: boolean; token: string; label: string; created_at: string; last_used_at: string | null; use_count: number; chat_messages: number };
type Login = { id: string; login: string; mode: Mode; chat: boolean; chat_agent: Agent; advice: boolean; label: string; created_at: string; last_used_at: string | null; expires_at: string | null; use_count: number; sessions: number; chat_messages: number };
type State = { base_url?: string; links: Link[]; logins: Login[] };

const MODE_WORD: Record<Mode, string> = { view: "Просмотр", manage: "Управление" };
const MODE_HINT: Record<Mode, string> = {
  view: "Видит отчёт, выводы, конфликты и направления. Ничего не меняет.",
  manage: "Всё то же, плюс ставит оценки находкам, выводит туры из анализа и обучает инструмент. Обновить данные с сайта и настройки не может.",
};
const CHAT_HINT = "Рядом с отчётом чат с агентом. Вопросов — до 20 в час.";

const stamp = (value?: string | null) => {
  if (!value) return "ещё не открывали";
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? value.slice(0, 16) : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const AGENT_WORD: Record<Agent, string> = { jarvis: "Джарвис", claude: "Claude", codex: "GPT" };
const AGENT_HINT: Record<Agent, string> = {
  jarvis: "Джарвис: жёсткое ограничение, он технически видит только инструменты ассортимента. Отвечает за секунды.",
  claude: "Claude: облачный агент на сервере, умнее и подробнее, отвечает дольше (через очередь MBOX). Работает под вашим аккаунтом, а границу «только ассортимент» держит инструкция, а не замок: давайте тем, кому доверяете.",
  codex: "GPT: облачный агент (Codex) на сервере, отвечает дольше (через очередь MBOX). Работает под вашим аккаунтом, а границу «только ассортимент» держит инструкция, а не замок: давайте тем, кому доверяете.",
};
const kindWord = (chat: boolean, agent: Agent = "jarvis") => (chat ? `Инструмент + чат (${AGENT_WORD[agent]})` : "Только инструмент");

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

const BASE = "/api/mbox/assortment/shares";

export function AssortmentShareDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  const [fresh, setFresh] = useState<{ login: string; password: string } | null>(null);
  const [linkForm, setLinkForm] = useState<{ mode: Mode; chat: boolean; agent: Agent; advice: boolean }>({ mode: "view", chat: false, agent: "jarvis", advice: true });
  const [form, setForm] = useState({ login: "", password: "", mode: "view" as Mode, chat: false, agent: "jarvis" as Agent, advice: true, label: "", days: "0" });
  const origin = (state?.base_url || serverOrigin()).replace(/\/+$/, "");

  const load = useCallback(async () => {
    try { setState(await fetchJson<State>(BASE)); setError(""); } catch (cause) { setError(errorText(cause)); }
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

  const createLink = (mode: Mode, chat: boolean, agent: Agent, advice: boolean, regenerate = false) => act(`link:${mode}:${chat}:${agent}:${advice}`, () => fetchJson(`${BASE}/link`, { method: "POST", headers: json, body: JSON.stringify({ mode, chat, agent, advice, regenerate }) }));
  const removeLink = (item: Link) => act(`link:${item.id}`, () => fetchJson(`${BASE}/link/${item.id}`, { method: "DELETE" }));
  const createLogin = () => act("login:new", async () => {
    const result = await fetchJson<{ login: Login; password?: string }>(`${BASE}/login`, { method: "POST", headers: json, body: JSON.stringify({ login: form.login, password: form.password, mode: form.mode, chat: form.chat, agent: form.agent, advice: form.advice, label: form.label, days: Number(form.days) || 0 }) });
    setFresh({ login: result.login.login, password: result.password || form.password });
    setForm({ login: "", password: "", mode: form.mode, chat: form.chat, agent: form.agent, advice: form.advice, label: "", days: "0" });
  });
  const patchLogin = (item: Login, body: Record<string, unknown>) => act(`login:${item.id}`, () => fetchJson(`${BASE}/login/${item.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) }));
  const removeLogin = (item: Login) => act(`login:${item.id}`, () => fetchJson(`${BASE}/login/${item.id}`, { method: "DELETE" }));
  const newPassword = (item: Login) => act(`login:${item.id}`, async () => {
    const result = await fetchJson<{ password: string }>(`${BASE}/login/${item.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ regeneratePassword: true }) });
    setFresh({ login: item.login, password: result.password });
  });

  const loginUrl = `${origin}/assortment-access`;
  const message = (value: { login: string; password: string }) => `Ассортимент: ${loginUrl}\nЛогин: ${value.login}\nПароль: ${value.password}`;
  const exists = state?.links.some((item) => item.mode === linkForm.mode && item.chat === linkForm.chat && item.advice === linkForm.advice && (!linkForm.chat || item.chat_agent === linkForm.agent));

  return (
    <div className="seo-detail-scrim" onClick={onClose}>
      <aside className="seo-detail seo-share" role="dialog" aria-modal="true" aria-label="Поделиться ассортиментом" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Поделиться ассортиментом</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <p className="seo-form-hint">Человек увидит только ассортимент. Настройки, ключи подключённых сервисов и остальной MBOX ему недоступны ни по ссылке, ни по паролю. Чат с агентом даётся отдельно и по желанию.</p>
        {error && <p className="seo-error" role="alert">{error}</p>}
        {!state && !error && <OctopusSpinner compact label="Загружаю…" />}

        {state && (
          <>
            <h3><Link2 size={14} aria-hidden="true" /> По ссылке</h3>
            <p className="seo-form-hint">Любой, у кого есть ссылка, откроет ассортимент без входа. Не публикуйте её открыто. Отозвать или заменить можно в любой момент.</p>
            <div className="seo-share-row">
              <div className="seo-share-form">
                <label>Что дать
                  <select value={linkForm.chat ? "chat" : "tool"} onChange={(event) => setLinkForm({ ...linkForm, chat: event.currentTarget.value === "chat" })}>
                    <option value="tool">Только инструмент</option>
                    <option value="chat">Инструмент + чат с агентом</option>
                  </select>
                </label>
                {linkForm.chat && (
                  <label>Кто отвечает в чате
                    <select value={linkForm.agent} onChange={(event) => setLinkForm({ ...linkForm, agent: event.currentTarget.value as Agent })}>
                      <option value="jarvis">Джарвис</option>
                      <option value="claude">Claude</option>
                      <option value="codex">GPT</option>
                    </select>
                  </label>
                )}
                <label>Права
                  <select value={linkForm.advice ? "full" : "facts"} onChange={(event) => setLinkForm({ ...linkForm, advice: event.currentTarget.value === "full" })} aria-label="Рекомендации в отчёте">
                  <option value="full">С рекомендациями</option>
                  <option value="facts">Без рекомендаций — только цифры</option>
                </select>
              </label>
              <label>
                <select value={linkForm.mode} onChange={(event) => setLinkForm({ ...linkForm, mode: event.currentTarget.value as Mode })}>
                    <option value="view">Просмотр</option>
                    <option value="manage">Управление</option>
                  </select>
                </label>
              </div>
              <small>{MODE_HINT[linkForm.mode]}{linkForm.chat ? ` ${CHAT_HINT} ${AGENT_HINT[linkForm.agent]}` : ""}{linkForm.advice ? "" : " Рекомендации «что снять» скрыты: сотрудник видит продажи, заполнение и конфликты, а решения остаются у вас."}</small>
              <div className="seo-share-actions">
                <button type="button" className="is-primary" disabled={busy.startsWith("link:") || exists} onClick={() => void createLink(linkForm.mode, linkForm.chat, linkForm.agent, linkForm.advice)}>
                  {linkForm.chat ? <MessageSquare size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />} {exists ? "Такая ссылка уже есть" : "Создать ссылку"}
                </button>
              </div>
            </div>
            {state.links.map((item) => {
              const url = `${origin}/a/${item.token}`;
              return (
                <div key={item.id} className="seo-share-row">
                  <div className="seo-share-head"><strong>{MODE_WORD[item.mode]} · {kindWord(item.chat, item.chat_agent)}{item.advice ? "" : " · без рекомендаций"}</strong><span>{MODE_HINT[item.mode]}{item.chat ? ` ${CHAT_HINT} ${AGENT_HINT[item.chat_agent]}` : ""}</span></div>
                  <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${MODE_WORD[item.mode]}, ${kindWord(item.chat, item.chat_agent)}`} />
                  <div className="seo-share-actions">
                    <button type="button" onClick={() => void copyText(`link:${item.id}`, url)}>{copied === `link:${item.id}` ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied === `link:${item.id}` ? "Скопировано" : "Копировать"}</button>
                    <button type="button" disabled={busy.startsWith("link:")} onClick={() => void createLink(item.mode, item.chat, item.chat_agent, item.advice, true)} title="Старая ссылка перестанет работать"><RefreshCw size={13} aria-hidden="true" /> Заменить</button>
                    <button type="button" disabled={busy.startsWith("link:")} onClick={() => void removeLink(item)}><Trash2 size={13} aria-hidden="true" /> Отключить</button>
                  </div>
                  <small>Открывали: {item.use_count} · последний раз: {stamp(item.last_used_at)}{item.chat ? ` · вопросов агенту: ${item.chat_messages}` : ""}</small>
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
                      <small>{stamp(item.last_used_at)} · входов {item.use_count} · сейчас открыто {item.sessions}{item.chat ? ` · вопросов агенту ${item.chat_messages}` : ""}{item.expires_at ? ` · до ${stamp(item.expires_at)}` : ""}</small>
                    </div>
                    <select value={item.mode} onChange={(event) => void patchLogin(item, { mode: event.currentTarget.value })} disabled={busy === `login:${item.id}`} aria-label={`Права ${item.login}`}>
                      <option value="view">Просмотр</option>
                      <option value="manage">Управление</option>
                    </select>
                    <select value={item.chat ? "chat" : "tool"} onChange={(event) => void patchLogin(item, { chat: event.currentTarget.value === "chat" })} disabled={busy === `login:${item.id}`} aria-label={`Состав доступа ${item.login}`}>
                      <option value="tool">Только инструмент</option>
                      <option value="chat">Инструмент + чат</option>
                    </select>
                    <select value={item.advice ? "full" : "facts"} onChange={(event) => void patchLogin(item, { advice: event.currentTarget.value === "full" })} disabled={busy === `login:${item.id}`} aria-label={`Рекомендации у ${item.login}`}>
                      <option value="full">С рекомендациями</option>
                      <option value="facts">Без рекомендаций</option>
                    </select>
                    {item.chat && (
                      <select value={item.chat_agent} onChange={(event) => void patchLogin(item, { agent: event.currentTarget.value })} disabled={busy === `login:${item.id}`} aria-label={`Кто отвечает в чате ${item.login}`}>
                        <option value="jarvis">Джарвис</option>
                        <option value="claude">Claude</option>
                        <option value="codex">GPT</option>
                      </select>
                    )}
                    <button type="button" disabled={busy === `login:${item.id}`} onClick={() => void newPassword(item)} title="Выдать новый пароль, старый перестанет работать">Новый пароль</button>
                    <button type="button" disabled={busy === `login:${item.id}`} onClick={() => void removeLogin(item)} aria-label={`Удалить доступ ${item.login}`}><Trash2 size={13} aria-hidden="true" /></button>
                  </li>
                ))}
              </ul>
            )}
            <form className="seo-share-form" onSubmit={(event) => { event.preventDefault(); void createLogin(); }}>
              <label>Логин<input value={form.login} onChange={(event) => setForm({ ...form, login: event.currentTarget.value })} autoComplete="off" placeholder="например, ivan" required /></label>
              <label>Пароль<input value={form.password} onChange={(event) => setForm({ ...form, password: event.currentTarget.value })} autoComplete="off" placeholder="пусто — придумаю сам" /></label>
              <label>Права
                <select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.currentTarget.value as Mode })}>
                  <option value="view">Просмотр</option>
                  <option value="manage">Управление</option>
                </select>
              </label>
              <label>Что дать
                <select value={form.advice ? "full" : "facts"} onChange={(event) => setForm({ ...form, advice: event.currentTarget.value === "full" })} aria-label="Рекомендации в отчёте">
                  <option value="full">С рекомендациями</option>
                  <option value="facts">Без рекомендаций</option>
                </select>
              </label>
              <label>
                <select value={form.chat ? "chat" : "tool"} onChange={(event) => setForm({ ...form, chat: event.currentTarget.value === "chat" })}>
                  <option value="tool">Только инструмент</option>
                  <option value="chat">Инструмент + чат</option>
                </select>
              </label>
              {form.chat && (
                <label>Кто отвечает
                  <select value={form.agent} onChange={(event) => setForm({ ...form, agent: event.currentTarget.value as Agent })}>
                    <option value="jarvis">Джарвис</option>
                    <option value="claude">Claude</option>
                    <option value="codex">GPT</option>
                  </select>
                </label>
              )}
              <label>Подпись<input value={form.label} onChange={(event) => setForm({ ...form, label: event.currentTarget.value })} placeholder="кто это" /></label>
              <label>Срок, дней<input type="number" min="0" max="365" value={form.days} onChange={(event) => setForm({ ...form, days: event.currentTarget.value })} title="0 — без срока" /></label>
              <button type="submit" className="is-primary" disabled={busy === "login:new" || !form.login}><KeyRound size={13} aria-hidden="true" /> Создать доступ</button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
