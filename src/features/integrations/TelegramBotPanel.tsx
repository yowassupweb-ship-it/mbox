import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Bot, ExternalLink, LoaderCircle, MessageCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import type { Company, Project } from "../../types";
import { Panel, PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { AccessPicker } from "../accounts/AccessPicker";

type TelegramChat = {
  id: string; title: string; chat_type: string; status: "pending" | "active" | "paused" | "left";
  project_ids: string[]; company_ids: string[]; notes_enabled: boolean; answers_enabled: boolean;
  last_message_at: string | null; last_digest_at: string | null; last_digest_summary: string; notes_count: number; messages: number;
};
type TelegramBot = { id: string; username: string; name: string; can_read_all: boolean; last_error: string; created_at: string; chats: TelegramChat[] };
type TelegramState = { account: { linked: boolean; tg_username: string }; bots: TelegramBot[] };
type TelegramLink = { url: string; expires_at: string };
type TelegramInvite = { bot_id: string; url: string; expires_at: string };
type Waiting = { kind: "link" | "chat"; baseline: number; needActive: boolean; until: number };
type Preset = { projects: string[]; companies: string[] };
type Mutate = (key: string, path: string, method: string, body?: unknown) => Promise<void>;

const STATUS: Record<TelegramChat["status"], string> = { pending: "Ожидает настройки", active: "Работает", paused: "На паузе", left: "Бот удалён из чата" };
const WAIT_MS = 10 * 60 * 1000;
const countChats = (state: TelegramState, activeOnly: boolean) => state.bots.reduce((sum, bot) => sum + bot.chats.filter((chat) => !activeOnly || chat.status === "active").length, 0);

/** Подключение Telegram-ботов (их может быть несколько), привязка своего аккаунта и настройка проектного контекста чатов. */
export function TelegramBotPanel({ projects, companies }: { projects: Project[]; companies: Company[] }) {
  const [state, setState] = useState<TelegramState>({ account: { linked: false, tg_username: "" }, bots: [] });
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [invite, setInvite] = useState<TelegramInvite | null>(null);
  const [adding, setAdding] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const load = useCallback(async () => {
    setState(await fetchJson<TelegramState>("/api/mbox/telegram"));
  }, []);
  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить Telegram")).finally(() => setLoading(false)); }, [load]);

  // Пока человек в Telegram нажимает Start или выбирает чат, подтягиваем состояние — результат появится здесь сам.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { if (Date.now() > waiting.until) setWaiting(null); else void load().catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [waiting, load]);
  useEffect(() => {
    if (!waiting) return;
    if (waiting.kind === "link" && state.account.linked) { setWaiting(null); setLink(null); }
    if (waiting.kind === "chat" && countChats(state, waiting.needActive) > waiting.baseline) { setWaiting(null); setInvite(null); }
  }, [state, waiting]);

  const mutate: Mutate = useCallback(async (key, path, method, body) => {
    setBusy(key); setError("");
    try {
      setState(await fetchJson<TelegramState>(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить изменения"); }
    finally { setBusy(""); }
  }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("bot"); setError("");
    try {
      setState(await fetchJson<TelegramState>("/api/mbox/telegram/bot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
      setToken(""); setAdding(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подключить бота"); }
    finally { setBusy(""); }
  }

  async function startLink(botId?: string) {
    setBusy("link"); setError("");
    try {
      const next = await fetchJson<TelegramState & { link: TelegramLink }>("/api/mbox/telegram/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_id: botId }) });
      setState({ account: next.account, bots: next.bots });
      setLink(next.link);
      setWaiting({ kind: "link", baseline: 0, needActive: false, until: Date.now() + WAIT_MS });
      window.open(next.link.url, "_blank", "noopener");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать ссылку"); }
    finally { setBusy(""); }
  }
  async function unlink() {
    if (await askConfirm({ title: "Отвязать Telegram?", message: "Добавлять ботов в чаты и звать Claude и GPT станет нельзя, пока вы не привяжете аккаунт снова. Уже подключённые чаты продолжат работать.", confirmLabel: "Отвязать", danger: true })) {
      setLink(null);
      await mutate("link", "/api/mbox/telegram/link", "DELETE");
    }
  }

  async function addToChat(bot: TelegramBot, preset: Preset) {
    setBusy(`invite:${bot.id}`); setError("");
    try {
      const next = await fetchJson<TelegramState & { invite: TelegramInvite }>(`/api/mbox/telegram/bots/${bot.id}/invite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_ids: preset.projects, company_ids: preset.companies }) });
      setState({ account: next.account, bots: next.bots });
      setInvite(next.invite);
      const needActive = preset.projects.length > 0 || preset.companies.length > 0;
      setWaiting({ kind: "chat", baseline: countChats(next, needActive), needActive, until: Date.now() + WAIT_MS });
      window.open(next.invite.url, "_blank", "noopener");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать ссылку"); }
    finally { setBusy(""); }
  }

  async function disconnectBot(bot: TelegramBot) {
    if (await askConfirm({ title: `Отключить бота @${bot.username}?`, message: "Настройка бота, список его чатов и сохранённые сообщения будут удалены из MBOX.", confirmLabel: "Отключить", danger: true })) {
      await mutate(`bot:${bot.id}`, `/api/mbox/telegram/bots/${bot.id}`, "DELETE");
    }
  }

  if (loading) return <Panel title="Telegram-боты" icon={Bot}><p className="telegram-hint">Загружаю настройки…</p></Panel>;

  const connectForm = (
    <form className="telegram-connect" onSubmit={(event) => void connect(event)}>
      <div className="telegram-token-field"><span>Токен бота</span><PasswordInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456:ABC…" autoComplete="off" required /></div>
      <button className="primary-action" type="submit" disabled={busy === "bot" || !token.trim()}>{busy === "bot" ? <LoaderCircle size={16} className="telegram-spin" /> : <Bot size={16} />} Подключить бота</button>
      <span>Токен хранится в зашифрованном виде. Ботов можно подключить сколько нужно — например, отдельного для клиентов и отдельного для команды.</span>
    </form>
  );

  return (
    <Panel title="Telegram-боты" icon={Bot} className="telegram-panel">
      {error && <p className="telegram-error" role="alert">{error}</p>}

      {!state.bots.length ? (
        <>
          <p className="telegram-hint">Бот отвечает на вопросы в рабочих чатах, записывает важное в память проектов, а вам лично даёт Claude и GPT прямо из Telegram.</p>
          <ol className="telegram-steps">
            <li>В Telegram откройте <b>@BotFather</b> и отправьте <code>/newbot</code>: имя и username на <code>bot</code>.</li>
            <li>Скопируйте токен, который пришлёт BotFather, и вставьте ниже.</li>
            <li>Чтобы бот видел всю переписку чата, а не только упоминания, отправьте BotFather <code>/setprivacy</code>, выберите бота и нажмите <b>Disable</b>.</li>
          </ol>
          {connectForm}
        </>
      ) : (
        <>
          <div className="telegram-bot-row">
            <div>
              <strong>Ваш Telegram</strong>
              <span>{state.account.linked ? `Привязан${state.account.tg_username ? `: @${state.account.tg_username}` : ""}. Только вы добавляете ботов в чаты и зовёте агентов.` : "Не привязан. Привяжите, чтобы добавлять ботов в чаты, писать им в личку и звать Claude и GPT."}</span>
            </div>
            {state.account.linked
              ? <button className="account-save" type="button" disabled={busy === "link"} onClick={() => void unlink()}>Отвязать</button>
              : link
                ? <a className="primary-action" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Открыть в Telegram</a>
                : <button className="primary-action" type="button" disabled={busy === "link"} onClick={() => void startLink()}>{busy === "link" ? <LoaderCircle size={16} className="telegram-spin" /> : <MessageCircle size={16} />} Привязать Telegram</button>}
          </div>
          {link && !state.account.linked && <p className="telegram-hint">Нажмите Start в Telegram: привязка появится здесь сама. Ссылка действует 15 минут и подходит одному аккаунту.</p>}
          {state.account.linked && state.bots[0] && (
            <ul className="telegram-usage">
              <li><span>Джарвис</span> <code>@{state.bots[0].username} вопрос</code> <i>в группе; в личке упоминание не нужно</i></li>
              <li><span>Claude на компьютере</span> <code>@{state.bots[0].username} --claude вопрос</code></li>
              <li><span>Claude на сервере</span> <code>@{state.bots[0].username} --claudecloud вопрос</code></li>
              <li><span>GPT на компьютере</span> <code>@{state.bots[0].username} --gpt вопрос</code></li>
              <li><span>GPT на сервере</span> <code>@{state.bots[0].username} --gptcloud вопрос</code></li>
              <li><span>То же командами</span> <code>/claude</code> <code>/claudecloud</code> <code>/gpt</code> <code>/gptcloud</code> <code>/ask</code> <i>работают и при включённом Privacy Mode</i></li>
            </ul>
          )}

          {state.bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} linked={state.account.linked} projects={projects} companies={companies} busy={busy} mutate={mutate}
              invite={invite?.bot_id === bot.id ? invite : null} waitingChat={waiting?.kind === "chat" && invite?.bot_id === bot.id}
              onInvite={(preset) => void addToChat(bot, preset)} onDisconnect={() => void disconnectBot(bot)}
              onLink={() => void startLink(bot.id)} />
          ))}

          {adding ? connectForm : <button className="account-save telegram-add-bot" type="button" onClick={() => setAdding(true)}><Plus size={14} /> Подключить ещё одного бота</button>}
        </>
      )}
    </Panel>
  );
}

function BotCard({ bot, linked, projects, companies, busy, mutate, invite, waitingChat, onInvite, onDisconnect, onLink }: {
  bot: TelegramBot; linked: boolean; projects: Project[]; companies: Company[]; busy: string; mutate: Mutate;
  invite: TelegramInvite | null; waitingChat: boolean; onInvite: (preset: Preset) => void; onDisconnect: () => void; onLink: () => void;
}) {
  const [preset, setPreset] = useState<Preset>({ projects: [], companies: [] });
  const picked = preset.projects.length + preset.companies.length;
  const inviting = busy === `invite:${bot.id}`;
  const live = bot.chats.filter((chat) => chat.status !== "left");

  return (
    <section className="telegram-bot-card">
      <header className="telegram-chat-head">
        <div><h3>{bot.name || bot.username}</h3><span><a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer">@{bot.username}</a> · чатов: {live.length}</span></div>
        <div className="telegram-bot-actions">
          <button className="account-save" type="button" disabled={busy === `refresh:${bot.id}`} onClick={() => void mutate(`refresh:${bot.id}`, `/api/mbox/telegram/bots/${bot.id}/refresh`, "POST")}><RefreshCw size={14} /> Проверить</button>
          <button className="account-save" type="button" disabled={busy === `bot:${bot.id}`} onClick={onDisconnect}>Отключить</button>
        </div>
      </header>
      {bot.last_error && <p className="telegram-error">{bot.last_error}</p>}
      {!bot.can_read_all && <p className="telegram-warning">У бота включён Privacy Mode: в группе, где он не администратор, Telegram показывает ему только /команды и ответы на его сообщения, а «@бот текст» не доставляет. Чаты, добавленные кнопкой «Добавить в чат», получают бота администратором без полномочий, и ему видно всё. Для остальных: сделайте бота администратором группы или отключите режим в @BotFather (<code>/setprivacy</code> → бот → <b>Disable</b>, потом верните бота в чат). Команды <code>/ask</code>, <code>/claude</code> работают при любом режиме.</p>}

      <div className="telegram-add">
        <strong>Добавить в чат</strong>
        <span>Выберите, к чему относится чат, и нажмите кнопку: Telegram предложит выбрать группу и добавит бота администратором без полномочий (так он видит все сообщения), а чат сразу заработает с этими проектами. Добавить бота в чат может только вы.</span>
        <AccessPicker projects={projects} companies={companies} selectedProjects={preset.projects} selectedCompanies={preset.companies} disabled={inviting} onChange={(next) => setPreset(next)} />
        <div className="telegram-options">
          {linked
            ? <button className="primary-action" type="button" disabled={inviting} onClick={() => onInvite(preset)}>{inviting ? <LoaderCircle size={16} className="telegram-spin" /> : <Plus size={16} />} Добавить в чат{picked ? ` · выбрано: ${picked}` : ""}</button>
            : <button className="primary-action" type="button" disabled={busy === "link"} onClick={onLink}><MessageCircle size={16} /> Сначала привяжите Telegram</button>}
          {invite && waitingChat && <span className="telegram-hint"><LoaderCircle size={13} className="telegram-spin" /> Выберите чат в Telegram — он появится здесь. Ссылка действует 30 минут. <a href={invite.url} target="_blank" rel="noreferrer">Открыть ещё раз</a></span>}
        </div>
      </div>

      <div className="telegram-chats">
        {!bot.chats.length && <p className="telegram-hint">Чатов пока нет.</p>}
        {bot.chats.map((chat) => <ChatCard key={chat.id} chat={chat} projects={projects} companies={companies} busy={busy} mutate={mutate} />)}
      </div>
    </section>
  );
}

function ChatCard({ chat, projects, companies, busy, mutate }: { chat: TelegramChat; projects: Project[]; companies: Company[]; busy: string; mutate: Mutate }) {
  const saveChat = (patch: Partial<TelegramChat>) => mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}`, "PATCH", patch);
  async function forgetChat() {
    if (await askConfirm({ title: `Удалить чат «${chat.title}»?`, message: "MBOX забудет этот чат и удалит сохранённые сообщения.", confirmLabel: "Удалить", danger: true })) {
      await mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}`, "DELETE");
    }
  }
  return (
    <article className="telegram-chat">
      <header className="telegram-chat-head">
        <div><h3>{chat.title}</h3><span>{STATUS[chat.status]} · {chat.messages} сообщений</span></div>
        {chat.status !== "left" && <label className="telegram-switch"><input type="checkbox" checked={chat.status === "active"} disabled={busy === chat.id || chat.status === "pending"} onChange={(event) => void saveChat({ status: event.target.checked ? "active" : "paused" })} />{chat.status === "active" ? "Работает" : "Пауза"}</label>}
      </header>
      {chat.status !== "left" && <>
        <AccessPicker projects={projects} companies={companies} selectedProjects={chat.project_ids} selectedCompanies={chat.company_ids} disabled={busy === chat.id} onChange={(next) => void saveChat({ project_ids: next.projects, company_ids: next.companies, ...(chat.status === "pending" && (next.projects.length || next.companies.length) ? { status: "active" } : {}) })} />
        <div className="telegram-options">
          <label><input type="checkbox" checked={chat.answers_enabled} disabled={busy === chat.id} onChange={(event) => void saveChat({ answers_enabled: event.target.checked })} /> Отвечать на упоминания и вопросы</label>
          <label><input type="checkbox" checked={chat.notes_enabled} disabled={busy === chat.id} onChange={(event) => void saveChat({ notes_enabled: event.target.checked })} /> Записывать важное и поручения</label>
          <button className="account-save" type="button" disabled={busy === chat.id || chat.status !== "active"} onClick={() => void mutate(chat.id, `/api/mbox/telegram/chats/${chat.id}/digest`, "POST")}><RefreshCw size={14} /> Разобрать сейчас</button>
        </div>
        {chat.last_digest_summary && <p className="telegram-summary"><MessageCircle size={14} /> {chat.last_digest_summary}</p>}
      </>}
      {chat.status === "left" && <button className="account-save" type="button" disabled={busy === chat.id} onClick={() => void forgetChat()}><Trash2 size={14} /> Удалить из списка</button>}
    </article>
  );
}
