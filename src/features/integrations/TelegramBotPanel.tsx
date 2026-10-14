import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Bot, LoaderCircle, MessageCircle, RefreshCw, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import type { Company, Project } from "../../types";
import { Panel, PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { AccessPicker } from "../accounts/AccessPicker";

type TelegramBot = { username: string; name: string; last_error: string; created_at: string; linked: boolean; tg_username: string };
type TelegramLink = { url: string; expires_at: string };
type TelegramChat = {
  id: string; title: string; chat_type: string; status: "pending" | "active" | "paused" | "left";
  project_ids: string[]; company_ids: string[]; notes_enabled: boolean; answers_enabled: boolean;
  last_message_at: string | null; last_digest_at: string | null; last_digest_summary: string; notes_count: number; messages: number;
};
type TelegramState = { bot: TelegramBot | null; chats: TelegramChat[] };

const STATUS: Record<TelegramChat["status"], string> = { pending: "Ожидает настройки", active: "Работает", paused: "На паузе", left: "Бот удалён из чата" };

/** Подключение личного Telegram-бота и настройка проектного контекста его рабочих чатов. */
export function TelegramBotPanel({ projects, companies }: { projects: Project[]; companies: Company[] }) {
  const [state, setState] = useState<TelegramState>({ bot: null, chats: [] });
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState<TelegramLink | null>(null);

  const load = useCallback(async () => {
    const next = await fetchJson<TelegramState>("/api/mbox/telegram");
    setState(next);
  }, []);
  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить Telegram" )).finally(() => setLoading(false)); }, [load]);

  async function mutate(key: string, path: string, method: string, body?: unknown) {
    setBusy(key); setError("");
    try {
      const next = await fetchJson<TelegramState>(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      setState(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить изменения"); }
    finally { setBusy(""); }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("bot"); setError("");
    try {
      setState(await fetchJson<TelegramState>("/api/mbox/telegram/bot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
      setToken("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подключить бота"); }
    finally { setBusy(""); }
  }

  // Пока ждём, что человек нажмёт Start в Telegram, подтягиваем состояние — привязка появится сама.
  useEffect(() => {
    if (!link || state.bot?.linked) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [link, state.bot?.linked, load]);
  useEffect(() => { if (state.bot?.linked) setLink(null); }, [state.bot?.linked]);

  async function startLink() {
    setBusy("link"); setError("");
    try {
      const next = await fetchJson<TelegramState & { link: TelegramLink }>("/api/mbox/telegram/link", { method: "POST" });
      setState({ bot: next.bot, chats: next.chats });
      setLink(next.link);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать ссылку"); }
    finally { setBusy(""); }
  }
  async function unlink() {
    if (await askConfirm({ title: "Отвязать Telegram?", message: "Агенты Claude и GPT перестанут отвечать в Telegram, а личная переписка с ботом закроется, пока вы не привяжете аккаунт снова.", confirmLabel: "Отвязать", danger: true })) {
      await mutate("link", "/api/mbox/telegram/link", "DELETE");
    }
  }

  const saveChat = (chat: TelegramChat, patch: Partial<TelegramChat>) => mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}`, "PATCH", patch);
  async function disconnectBot() {
    if (await askConfirm({ title: "Отключить Telegram-бота?", message: "Настройка бота, список чатов и сохранённые сообщения будут удалены из MBOX.", confirmLabel: "Отключить", danger: true })) {
      await mutate("bot", "/api/mbox/telegram/bot", "DELETE");
    }
  }
  async function forgetChat(chat: TelegramChat) {
    if (await askConfirm({ title: `Удалить чат «${chat.title}»?`, message: "MBOX забудет этот чат и удалит сохранённые сообщения.", confirmLabel: "Удалить", danger: true })) {
      await mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}`, "DELETE");
    }
  }
  if (loading) return <Panel title="Telegram-бот" icon={Bot}><p className="telegram-hint">Загружаю настройки…</p></Panel>;

  return (
    <Panel title="Telegram-бот" icon={Bot} className="telegram-panel">
      <p className="telegram-hint">Создайте бота через @BotFather, отключите ему Privacy Mode командой /setprivacy и добавьте в рабочие группы. После подключения назначьте каждому чату проекты. Джарвис сможет отвечать на вопросы и записывать важное в память выбранных проектов. Привяжите свой Telegram, чтобы писать боту в личку и звать Claude и GPT.</p>
      {error && <p className="telegram-error" role="alert">{error}</p>}
      {!state.bot ? (
        <form className="telegram-connect" onSubmit={(event) => void connect(event)}>
          <div className="telegram-token-field"><span>Токен бота</span><PasswordInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456:ABC…" autoComplete="off" required /></div>
          <button className="primary-action" type="submit" disabled={busy === "bot" || !token.trim()}>{busy === "bot" ? <LoaderCircle size={16} className="telegram-spin" /> : <Bot size={16} />} Подключить бота</button>
          <span>Создайте бота через @BotFather и скопируйте его токен. Токен хранится в зашифрованном виде.</span>
        </form>
      ) : (
        <>
          <div className="telegram-bot-row">
            <div><strong>{state.bot.name || state.bot.username}</strong><span>@{state.bot.username}</span></div>
            {state.bot.last_error && <span className="telegram-error">{state.bot.last_error}</span>}
            <button className="account-save" type="button" disabled={busy === "bot"} onClick={() => void disconnectBot()}>Отключить бота</button>
          </div>
          <div className="telegram-bot-row">
            <div>
              <strong>Ваш Telegram</strong>
              <span>{state.bot.linked ? `Привязан${state.bot.tg_username ? `: @${state.bot.tg_username}` : ""}. Агентов звать можете только вы.` : "Не привязан: бот не знает, что вы владелец, и агентам не ответит."}</span>
            </div>
            {state.bot.linked
              ? <button className="account-save" type="button" disabled={busy === "link"} onClick={() => void unlink()}>Отвязать</button>
              : link
                ? <a className="primary-action" href={link.url} target="_blank" rel="noreferrer"><MessageCircle size={16} /> Открыть в Telegram</a>
                : <button className="primary-action" type="button" disabled={busy === "link"} onClick={() => void startLink()}>{busy === "link" ? <LoaderCircle size={16} className="telegram-spin" /> : <MessageCircle size={16} />} Привязать Telegram</button>}
          </div>
          {link && !state.bot.linked && <p className="telegram-hint">Откройте ссылку и нажмите Start в Telegram: привязка появится здесь сама. Ссылка действует 15 минут и подходит одному аккаунту.</p>}
          {state.bot.linked && (
            <ul className="telegram-usage">
              <li><span>Джарвис</span> <code>@{state.bot.username} вопрос</code> — в группе, в личке без упоминания</li>
              <li><span>Claude на компьютере</span> <code>@{state.bot.username} --claude вопрос</code></li>
              <li><span>Claude на сервере</span> <code>@{state.bot.username} --claudecloud вопрос</code></li>
              <li><span>GPT на компьютере</span> <code>@{state.bot.username} --gpt вопрос</code></li>
              <li><span>GPT на сервере</span> <code>@{state.bot.username} --gptcloud вопрос</code></li>
            </ul>
          )}
          <div className="telegram-chats">
            {!state.chats.length && <p className="telegram-hint">Пока чатов нет. Добавьте бота в группу — она появится здесь после первого обновления Telegram.</p>}
            {state.chats.map((chat) => (
              <article className="telegram-chat" key={chat.id}>
                <header className="telegram-chat-head">
                  <div><h3>{chat.title}</h3><span>{STATUS[chat.status]} · {chat.messages} сообщений</span></div>
                  {chat.status !== "left" && <label className="telegram-switch"><input type="checkbox" checked={chat.status === "active"} disabled={busy === chat.id || chat.status === "pending"} onChange={(event) => void saveChat(chat, { status: event.target.checked ? "active" : "paused" })} />{chat.status === "active" ? "Работает" : "Пауза"}</label>}
                </header>
                {chat.status !== "left" && <>
                  <AccessPicker projects={projects} companies={companies} selectedProjects={chat.project_ids} selectedCompanies={chat.company_ids} disabled={busy === chat.id} onChange={(next) => void saveChat(chat, { project_ids: next.projects, company_ids: next.companies, ...(chat.status === "pending" && (next.projects.length || next.companies.length) ? { status: "active" } : {}) })} />
                  <div className="telegram-options">
                    <label><input type="checkbox" checked={chat.answers_enabled} disabled={busy === chat.id} onChange={(event) => void saveChat(chat, { answers_enabled: event.target.checked })} /> Отвечать на упоминания и вопросы</label>
                    <label><input type="checkbox" checked={chat.notes_enabled} disabled={busy === chat.id} onChange={(event) => void saveChat(chat, { notes_enabled: event.target.checked })} /> Записывать важное и поручения</label>
                    <button className="account-save" type="button" disabled={busy === chat.id || chat.status !== "active"} onClick={() => void mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}/digest`, "POST")}><RefreshCw size={14} /> Разобрать сейчас</button>
                  </div>
                  {chat.last_digest_summary && <p className="telegram-summary"><MessageCircle size={14} /> {chat.last_digest_summary}</p>}
                </>}
                {chat.status === "left" && <button className="account-save" type="button" disabled={busy === chat.id} onClick={() => void forgetChat(chat)}><Trash2 size={14} /> Удалить из списка</button>}
              </article>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
