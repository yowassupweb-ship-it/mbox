// Telegram-бот в рабочих чатах: свой бот у каждого человека, привязанный к его Джарвису.
//
// Человек создаёт бота в @BotFather и вставляет токен в MBOX («Настройки → Команда → Telegram-бот»). Сервер регистрирует
// вебхук (POST /api/mbox/telegram/hook/<id>, подлинность — секрет в заголовке X-Telegram-Bot-Api-Secret-Token), и бота
// можно добавлять в групповые чаты. Каждый чат получает свою выборку: компании целиком (все их проекты, включая
// будущие) и/или отдельные проекты. Пока выборки нет, бот в чате молчит и ничего не записывает.
//
// Что бот делает в настроенном чате:
//   • ответы — когда его упоминают (@бот) или отвечают на его сообщение: вопрос уходит Джарвису владельца бота
//     (replyAsJarvis) с allowed_project_ids = проекты чата, в контексте — последние сообщения чата;
//   • записи — в фоне, после паузы в переписке или когда новых сообщений много: Джарвис разбирает новое и пишет
//     важное (решения, договорённости, сроки, цифры, контакты, риски) в память нужного проекта, поручения — задачами.
//     В чат при этом ничего не отправляется.
// Всё, что Джарвис делает, он делает только в проектах чата: доступ сужен так же, как у участника команды.
//
// Свой аккаунт Telegram человек привязывает в MBOX (кнопка «Привязать Telegram» → ссылка t.me/<бот>?start=<код>).
// Привязанный аккаунт — единственный, кто может звать агентов: «@бот --claude вопрос» или «@бот --gpt вопрос» уходит
// Claude / Codex из инбокса MBOX (те же наблюдатели, что отвечают в чате MBOX), ответ приходит в Telegram, когда агент
// закончит. Без флага отвечает Джарвис. В личной переписке с ботом (только привязанный аккаунт) упоминание не нужно.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { JARVIS_NAME, replyAsJarvis } from "./jarvis.mjs";
import { projectScopeFor } from "./spaces.mjs";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telegram_bots (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token_ciphertext BYTEA NOT NULL,
  bot_user_id BIGINT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  webhook_secret TEXT NOT NULL,
  can_read_all BOOLEAN NOT NULL DEFAULT false,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_chats (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  chat_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  project_ids BIGINT[] NOT NULL DEFAULT '{}',
  company_ids BIGINT[] NOT NULL DEFAULT '{}',
  notes_enabled BOOLEAN NOT NULL DEFAULT true,
  answers_enabled BOOLEAN NOT NULL DEFAULT true,
  last_message_at TIMESTAMPTZ,
  last_digest_at TIMESTAMPTZ,
  last_digest_message_id BIGINT NOT NULL DEFAULT 0,
  last_digest_summary TEXT NOT NULL DEFAULT '',
  notes_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, chat_id)
);
CREATE TABLE IF NOT EXISTS telegram_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_row_id BIGINT NOT NULL REFERENCES telegram_chats(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  from_id BIGINT,
  from_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reply_to BIGINT,
  is_bot BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_row_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_row_id, id);
-- Ботов у человека может быть несколько (для разных проектов и чатов): уникален сам бот, а не владелец.
ALTER TABLE telegram_bots DROP CONSTRAINT IF EXISTS telegram_bots_owner_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_bots_bot_user ON telegram_bots(bot_user_id);
-- Личный аккаунт Telegram человека: один на все его боты. Только он добавляет ботов в чаты и зовёт агентов.
CREATE TABLE IF NOT EXISTS telegram_accounts (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id BIGINT,
  tg_username TEXT NOT NULL DEFAULT '',
  link_code TEXT,
  link_code_expires TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Ссылка «добавить бота в чат» с заранее выбранными проектами: после добавления чат сразу начинает работать.
CREATE TABLE IF NOT EXISTS telegram_invites (
  code TEXT PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  project_ids BIGINT[] NOT NULL DEFAULT '{}',
  company_ids BIGINT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS telegram_agent_requests (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  tg_chat_id BIGINT NOT NULL,
  chat_row_id BIGINT,
  reply_to BIGINT,
  inbox_id BIGINT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  done BOOLEAN NOT NULL DEFAULT false,
  last_typing_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telegram_agent_requests_open ON telegram_agent_requests(done, id);
`;

const API = "https://api.telegram.org";
const DIGEST_IDLE_MS = 5 * 60 * 1000; // пауза в переписке, после которой разбираем новое
const DIGEST_BATCH = 30; // столько новых сообщений — разбираем, не дожидаясь паузы
const DIGEST_GAP_MS = 10 * 60 * 1000; // не чаще раза в 10 минут на чат
const CONTEXT_MESSAGES = 30; // сколько последних сообщений видит Джарвис, отвечая на вопрос
const KEEP_DAYS = 45;
const AGENT_WAIT_MS = 20 * 60 * 1000; // дольше агента не ждём: скорее всего, наблюдатель не запущен
const AGENT_REPLY_MAX = 16000;
const LINK_CODE_MINUTES = 15;
const INVITE_MINUTES = 30;
// Флаг → агент MBOX. Локальный (на компьютере человека, с его файлами) и серверный (облачный) — разные агенты, выбор явный.
const AGENTS = {
  claude: { agent: "Claude", label: "Claude (локальный)", suffix: "c", other: "claudecloud" },
  claudecloud: { agent: "ClaudeCloud", label: "Claude (сервер)", suffix: "cc", other: "claude" },
  gpt: { agent: "Codex", label: "GPT (локальный)", suffix: "g", other: "gptcloud" },
  gptcloud: { agent: "CodexCloud", label: "GPT (сервер)", suffix: "gc", other: "gpt" },
};
const FLAG_ALIASES = { codex: "gpt", codexcloud: "gptcloud", chatgpt: "gpt" };
// Телефонные клавиатуры превращают «--» в тире, поэтому принимаем и его.
const AGENT_FLAG = /(^|\s)(?:--|—|–)(claude|claudecloud|gpt|gptcloud|codex|codexcloud|chatgpt)(?=\s|$)/i;

// В режиме приватности Telegram доставляет боту в группе только /команды и ответы на его сообщения, а «@бот текст» — нет.
// Поэтому у каждого флага есть команда: /claude, /claudecloud, /gpt, /gptcloud, а /ask — вопрос Джарвису.
const COMMAND = /^\s*\/(ask|claude|claudecloud|gpt|gptcloud|codex|codexcloud)(?:@(\w+))?(?=\s|$)/i;
const BOT_COMMANDS = [
  { command: "ask", description: "Спросить Джарвиса" },
  { command: "claude", description: "Спросить Claude на компьютере" },
  { command: "claudecloud", description: "Спросить Claude на сервере" },
  { command: "gpt", description: "Спросить GPT на компьютере" },
  { command: "gptcloud", description: "Спросить GPT на сервере" },
  { command: "help", description: "Как пользоваться ботом" },
];

/**
 * Разбор обращения к боту: «@бот --claude вопрос» или «/claude вопрос». agent пустой — отвечает Джарвис;
 * viaCommand — это /команда (она дойдёт до бота и при включённом режиме приватности); skip — команда чужого бота.
 */
function parseCall(text, botUsername) {
  let body = String(text || "");
  let commandAgent = "";
  let viaCommand = false;
  const command = body.match(COMMAND);
  if (command) {
    if (command[2] && command[2].toLowerCase() !== String(botUsername).toLowerCase()) return { skip: true, agent: "", text: "", viaCommand: false };
    viaCommand = true;
    const name = command[1].toLowerCase();
    if (name !== "ask") commandAgent = FLAG_ALIASES[name] || name;
    body = body.slice(command[0].length);
  }
  body = body.replace(new RegExp(`@${botUsername}\\b`, "gi"), " ");
  const flagged = splitAgentFlag(body);
  return { skip: false, agent: commandAgent || flagged.agent, text: flagged.text, viaCommand };
}

/** «--claude вопрос» → { agent: "claude", text: "вопрос" }. Без флага agent пустой — отвечает Джарвис. */
function splitAgentFlag(text) {
  const match = String(text || "").match(AGENT_FLAG);
  if (!match) return { agent: "", text: String(text || "").trim() };
  const raw = match[2].toLowerCase();
  const rest = (text.slice(0, match.index) + " " + text.slice(match.index + match[0].length)).replace(/[ \t]{2,}/g, " ").trim();
  return { agent: FLAG_ALIASES[raw] || raw, text: rest };
}

let deps = null;
const working = new Set(); // чаты, где сейчас идёт ответ или разбор — второй параллельно не запускаем

export async function ensureTelegramSchema(query) {
  await query(SCHEMA_SQL);
}

const secretKey = () => process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";

async function tg(token, method, params = {}) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.description || `Telegram ответил ${response.status}`);
  return body.result;
}

async function botToken(query, botId) {
  const row = (await query("SELECT pgp_sym_decrypt(token_ciphertext, $2) AS token FROM telegram_bots WHERE id = $1", [botId, secretKey()])).rows[0];
  return row?.token || "";
}

/** Markdown ответа Джарвиса → HTML, который понимает Telegram (жирный, код, ссылки, заголовки, списки). */
function toTelegramHtml(markdown) {
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(markdown || "")
    .split("\n")
    .map((raw) => {
      let line = escape(raw);
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return `<b>${heading[1]}</b>`;
      line = line.replace(/^\s*[-*]\s+/, "• ");
      line = line.replace(/`([^`]+)`/g, "<code>$1</code>");
      line = line.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      line = line.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>");
      line = line.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunks(text, size = 3900) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

async function send(token, chatId, text, replyTo) {
  const html = toTelegramHtml(text);
  const sent = [];
  for (const [index, part] of chunks(html).entries()) {
    try {
      sent.push(await tg(token, "sendMessage", { chat_id: chatId, text: part, parse_mode: "HTML", disable_web_page_preview: true, ...(index === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }));
    } catch {
      // Разметка не понравилась Telegram — отправляем тем же текстом без неё.
      sent.push(await tg(token, "sendMessage", { chat_id: chatId, text: part.replace(/<[^>]+>/g, ""), disable_web_page_preview: true, ...(index === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }));
    }
  }
  return sent;
}

const displayName = (user) => [user?.first_name, user?.last_name].filter(Boolean).join(" ") || (user?.username ? `@${user.username}` : "Кто-то");

function messageText(message) {
  const text = message.text || message.caption || "";
  if (text) return text;
  if (message.photo) return "[фото]";
  if (message.document) return `[файл ${message.document.file_name || ""}]`.trim();
  if (message.voice) return "[голосовое сообщение]";
  if (message.video) return "[видео]";
  if (message.sticker) return `[стикер ${message.sticker.emoji || ""}]`.trim();
  if (message.location) return "[геолокация]";
  return "";
}

/** Проекты чата: выбранные отдельно + все проекты выбранных компаний, но только из тех, что видит владелец бота. */
async function chatProjects(query, chat, ownerUserId) {
  const owner = (await query("SELECT id::text, role FROM users WHERE id = $1", [ownerUserId])).rows[0];
  if (!owner) return [];
  const scope = await projectScopeFor(query, owner);
  const rows = (await query(
    `SELECT id::text, name FROM projects
     WHERE (id = ANY($1::bigint[]) OR company_id = ANY($2::bigint[]))
       AND ($3::boolean OR id = ANY($4::bigint[]))
     ORDER BY name`,
    [chat.project_ids || [], chat.company_ids || [], scope.all, scope.projectIds],
  )).rows;
  return rows;
}

async function recentLines(query, chatRowId, limit, afterId = 0, exceptMessageId = 0) {
  const rows = (await query(
    `SELECT id, message_id, from_name, text, is_bot, sent_at FROM telegram_messages
     WHERE chat_row_id = $1 AND id > $2 AND message_id <> $4 ORDER BY id DESC LIMIT $3`,
    [chatRowId, afterId, limit, exceptMessageId],
  )).rows.reverse();
  return rows;
}

const stamp = (date) => new Date(date).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Проекты, которые видит владелец бота целиком: all — без ограничения (владелец без личных пространств). */
async function ownerScope(query, ownerUserId) {
  const owner = (await query("SELECT id::text, role FROM users WHERE id = $1", [ownerUserId])).rows[0];
  if (!owner) return null;
  const scope = await projectScopeFor(query, owner);
  const projects = (await query(
    "SELECT id::text, name FROM projects WHERE $1::boolean OR id = ANY($2::bigint[]) ORDER BY name",
    [scope.all, scope.projectIds],
  )).rows;
  return { owner, all: Boolean(scope.all), projects };
}

/**
 * Отдаёт вопрос Джарвису владельца бота и ждёт его ответа (тот же путь, что у чата в MBOX).
 * project_id у записи обязателен, если доступ ограничен: история диалога Джарвиса фильтруется по проектам, и вопрос без
 * проекта в неё не попадал — модель видела пустой разговор и отвечала «уточните, что требуется».
 * thread: для группы — свой на каждый вопрос (контекст чата и так в тексте), для личной переписки — общий.
 */
async function askJarvis(query, { bot, projects, allProjects = false, title, body, kind, thread, chat = null, question = "" }) {
  const owner = (await query("SELECT id::text, role, COALESCE((to_jsonb(users)->>'jarvis_enabled')::boolean, true) AS jarvis_enabled FROM users WHERE id = $1", [bot.owner_user_id])).rows[0];
  if (!owner || (owner.role !== "owner" && owner.jarvis_enabled === false)) return { error: "Джарвис у владельца бота выключен" };
  const projectId = projects[0]?.id || null;
  const props = {
    to: JARVIS_NAME,
    source: "telegram",
    ...(chat ? { telegram_chat: String(chat.id) } : {}),
    telegram_kind: kind,
    ...(question ? { question } : {}),
    mbox_user_id: owner.id,
    mbox_owner: owner.role === "owner",
    thread: thread || `tg${chat?.id || `dm${bot.id}`}`,
    allowed_project_ids: allProjects ? null : projects.map((project) => project.id),
  };
  const row = (await query(
    `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
     VALUES ($1, 'Человек', 'question', $2, $3, 'open', 'normal', false, $4)
     RETURNING id::text`,
    [projectId, title.slice(0, 200), body, JSON.stringify(props)],
  )).rows[0];
  await replyAsJarvis({ id: row.id, project_id: projectId, title, body, props });
  const answer = (await query(
    `SELECT body, item_type, COALESCE((props->>'failed')::boolean, false) AS failed FROM agent_inbox
     WHERE props->>'re' = $1 AND item_type IN ('answer', 'agent_error') ORDER BY id DESC LIMIT 1`,
    [row.id],
  )).rows[0];
  if (!answer) return { error: "Джарвис не ответил" };
  return answer.item_type === "agent_error" || answer.failed ? { error: answer.body } : { text: answer.body };
}

/**
 * Вопрос агенту MBOX (Claude / Codex, локальному или серверному): кладём его в инбокс так же, как чат MBOX, — наблюдатель
 * агента подхватит и ответит. Ответ в Telegram отправит pollAgentRequests, когда агент закончит.
 */
/**
 * В каком проекте лежит вопрос агенту. Наблюдатель агента привязан к одному проекту (MBOX_PROJECT, по умолчанию «MBOX») и
 * берёт только вопросы этого проекта или без проекта; а при личных пространствах (spaces_v1) сервер не отдаёт ему записи
 * без проекта вовсе. Поэтому вопрос кладём в проект наблюдателя; проекты чата передаём агенту в тексте.
 */
async function agentProjectId(query, owner) {
  const scope = await projectScopeFor(query, owner);
  if (scope.all) return null;
  const visible = (await query("SELECT id::text, name FROM projects WHERE id = ANY($1::bigint[]) ORDER BY id", [scope.projectIds])).rows;
  const watched = process.env.MBOX_PROJECT || "MBOX";
  return visible.find((row) => row.name === watched)?.id || visible.find((row) => row.name === "Общее")?.id || visible[0]?.id || null;
}

async function askAgent(query, { bot, token, tgChatId, chatRowId = null, replyTo = null, flag, text, intro = "" }) {
  const target = AGENTS[flag];
  const owner = (await query("SELECT id::text, role FROM users WHERE id = $1", [bot.owner_user_id])).rows[0];
  if (!target || !owner) return;
  const online = (await query(
    "SELECT 1 FROM agent_presence WHERE owner_user_id = $1 AND agent_name = $2 AND last_seen > now() - interval '2 minutes'",
    [owner.id, target.agent],
  )).rows.length > 0;
  if (!online) {
    const cloud = target.agent.endsWith("Cloud");
    const advice = cloud ? `Серверный агент сейчас не отвечает. Локальный: --${target.other}.` : `Запустите MBOX Desktop на компьютере — или спросите серверного: --${target.other}.`;
    await send(token, tgChatId, `${target.label} сейчас не в сети. ${advice}`, replyTo).catch(() => undefined);
    return;
  }
  const projectId = await agentProjectId(query, owner);
  const body = [
    intro || "[Telegram · личная переписка] Владелец пишет тебе через Telegram-бота MBOX. Ответь для Telegram: коротко и по делу, простое форматирование (абзацы, списки, **жирный**, без таблиц). Если просят что-то сделать — сделай и коротко скажи, что получилось.",
    "",
    text,
  ].join("\n");
  const props = {
    to: target.agent,
    source: "telegram",
    telegram_bot: String(bot.id),
    mbox_user_id: owner.id,
    mbox_owner: owner.role === "owner",
    thread: `tg${chatRowId ? `c${chatRowId}` : `dm${bot.id}`}${target.suffix}`,
  };
  const row = (await query(
    `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
     VALUES ($1, 'Человек', 'question', $2, $3, 'open', 'normal', false, $4)
     RETURNING id::text`,
    [projectId, `Telegram → ${target.label}: ${text.slice(0, 120)}`, body, JSON.stringify(props)],
  )).rows[0];
  await query(
    `INSERT INTO telegram_agent_requests(bot_id, tg_chat_id, chat_row_id, reply_to, inbox_id, label, last_typing_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [bot.id, tgChatId, chatRowId, replyTo, row.id, target.label],
  );
  deps?.broadcast?.("agent_inbox");
  void tg(token, "sendChatAction", { chat_id: tgChatId, action: "typing" }).catch(() => undefined);
}

let polling = false;
/** Забирает готовые ответы агентов и отправляет их в Telegram; пока агент работает — держит «печатает…». */
async function pollAgentRequests(query) {
  if (polling) return;
  polling = true;
  try {
    const open = (await query("SELECT * FROM telegram_agent_requests WHERE NOT done ORDER BY id LIMIT 20")).rows;
    for (const request of open) {
      const reply = (await query(
        `SELECT body, item_type FROM agent_inbox
         WHERE (props->>'re' = $1 OR props->>'in_reply_to' = $1) AND item_type IN ('agent_response', 'agent_error', 'answer') ORDER BY id DESC LIMIT 1`,
        [String(request.inbox_id)],
      )).rows[0];
      const expired = Date.now() - new Date(request.created_at).getTime() > AGENT_WAIT_MS;
      const token = await botToken(query, request.bot_id);
      if (reply || expired) {
        const claimed = (await query("UPDATE telegram_agent_requests SET done = true WHERE id = $1 AND NOT done RETURNING id", [request.id])).rows[0];
        if (!claimed || !token) continue;
        const failed = !reply || reply.item_type === "agent_error";
        let text = !reply ? `${request.label} не ответил за ${Math.round(AGENT_WAIT_MS / 60000)} минут: вероятно, наблюдатель не запущен. Вопрос остался в MBOX.`
          : failed ? `${request.label} не смог ответить: ${String(reply.body || "").slice(0, 600)}`
          : String(reply.body || "Готово.");
        if (text.length > AGENT_REPLY_MAX) text = `${text.slice(0, AGENT_REPLY_MAX)}\n\n…ответ обрезан, полный текст — в чате MBOX.`;
        const sent = await send(token, request.tg_chat_id, request.chat_row_id && !failed ? `**${request.label}:**\n${text}` : text, request.reply_to).catch(() => []);
        if (request.chat_row_id) {
          const bot = (await query("SELECT bot_user_id FROM telegram_bots WHERE id = $1", [request.bot_id])).rows[0];
          for (const item of sent) {
            await query(
              `INSERT INTO telegram_messages(chat_row_id, message_id, from_id, from_name, text, is_bot, sent_at) VALUES ($1, $2, $3, $4, $5, true, now()) ON CONFLICT DO NOTHING`,
              [request.chat_row_id, item.message_id, bot?.bot_user_id, request.label, text.slice(0, 4000)],
            ).catch(() => undefined);
          }
        }
      } else if (token && (!request.last_typing_at || Date.now() - new Date(request.last_typing_at).getTime() > 4000)) {
        await query("UPDATE telegram_agent_requests SET last_typing_at = now() WHERE id = $1", [request.id]);
        void tg(token, "sendChatAction", { chat_id: request.tg_chat_id, action: "typing" }).catch(() => undefined);
      }
    }
    await query("DELETE FROM telegram_agent_requests WHERE done AND created_at < now() - interval '2 days'");
  } catch (error) {
    console.error(`[telegram] agent poll: ${error.message}`);
  } finally {
    polling = false;
  }
}

async function answerInChat(query, bot, chat, message, asked = "") {
  const token = await botToken(query, bot.id);
  if (!token) return;
  if (working.has(`answer:${chat.id}`)) {
    await send(token, chat.chat_id, "Сейчас отвечаю на предыдущий вопрос — задайте этот через минуту.", message.message_id).catch(() => undefined);
    return;
  }
  working.add(`answer:${chat.id}`);
  const typing = setInterval(() => { void tg(token, "sendChatAction", { chat_id: chat.chat_id, action: "typing" }).catch(() => undefined); }, 4500);
  void tg(token, "sendChatAction", { chat_id: chat.chat_id, action: "typing" }).catch(() => undefined);
  try {
    const projects = await chatProjects(query, chat, bot.owner_user_id);
    if (!projects.length) {
      await send(token, chat.chat_id, "У этого чата нет доступных проектов. Владелец бота выбирает их в Настройки → Команда → Telegram-бот.", message.message_id);
      return;
    }
    const question = asked.trim() || "(пустое сообщение)";
    const context = await recentLines(query, chat.id, CONTEXT_MESSAGES, 0, message.message_id);
    const body = [
      `[Telegram · групповой чат «${chat.title}»] Тебя спросили в рабочем чате. Отвечай для чата: коротко, по делу, без таблиц и длинных списков; обращайся к человеку по имени.`,
      `Работай только с проектами: ${projects.map((project) => `${project.name} (#${project.id})`).join(", ")}. Других проектов для тебя здесь нет — не упоминай и не трогай их.`,
      `Если тебя просят что-то сделать (записать, создать задачу, найти, посчитать) — сделай это в этих проектах и коротко скажи, что сделал.`,
      "",
      "Последние сообщения чата:",
      ...context.map((line) => `[${stamp(line.sent_at)}] ${line.is_bot ? "Бот" : line.from_name}: ${line.text}`),
      "",
      `Вопрос от ${displayName(message.from)}: ${question}`,
    ].join("\n");
    const result = await askJarvis(query, { bot, chat, projects, title: `Telegram · ${chat.title}: ${question.slice(0, 120)}`, body, kind: "question", question, thread: `tg${chat.id}-${Date.now().toString(36)}` });
    const reply = result.text || `Не получилось ответить: ${String(result.error || "").slice(0, 300)}`;
    const sent = await send(token, chat.chat_id, reply, message.message_id);
    for (const item of sent) {
      await query(
        `INSERT INTO telegram_messages(chat_row_id, message_id, from_id, from_name, text, is_bot, sent_at) VALUES ($1, $2, $3, $4, $5, true, now())
         ON CONFLICT DO NOTHING`,
        [chat.id, item.message_id, bot.bot_user_id, bot.name || bot.username, reply.slice(0, 4000)],
      );
    }
  } catch (error) {
    await send(token, chat.chat_id, `Не получилось ответить: ${error instanceof Error ? error.message : String(error)}`, message.message_id).catch(() => undefined);
  } finally {
    clearInterval(typing);
    working.delete(`answer:${chat.id}`);
  }
}

/** Фоновый разбор новых сообщений чата: важное — в память проектов, поручения — задачами. В чат ничего не пишет. */
export async function digestChat(query, chatRowId, { force = false } = {}) {
  const chat = (await query("SELECT * FROM telegram_chats WHERE id = $1", [chatRowId])).rows[0];
  if (!chat || chat.status !== "active" || (!chat.notes_enabled && !force)) return { skipped: "off" };
  if (working.has(`digest:${chat.id}`)) return { skipped: "busy" };
  const bot = (await query("SELECT * FROM telegram_bots WHERE id = $1", [chat.bot_id])).rows[0];
  if (!bot) return { skipped: "no_bot" };
  const fresh = (await query(
    `SELECT id, from_name, text, sent_at FROM telegram_messages
     WHERE chat_row_id = $1 AND id > $2 AND NOT is_bot AND text <> '' ORDER BY id LIMIT 300`,
    [chat.id, chat.last_digest_message_id],
  )).rows;
  if (!fresh.length) return { skipped: "nothing_new" };
  const projects = await chatProjects(query, chat, bot.owner_user_id);
  if (!projects.length) return { skipped: "no_projects" };
  working.add(`digest:${chat.id}`);
  try {
    const body = [
      `[Telegram · групповой чат «${chat.title}» · фоновые записи] Ниже новые сообщения рабочего чата. Ты ведёшь по нему записи для проектов: ${projects.map((project) => `${project.name} (#${project.id})`).join(", ")}.`,
      "Выбери только важное: решения и договорённости, задачи и сроки, цифры и цены, контакты и реквизиты, проблемы и риски, новые факты о клиенте или проекте.",
      "Каждый важный пункт запиши в память нужного проекта (record_memory): заголовок — суть, в тексте — что именно, кто сказал и когда. Явные поручения с исполнителем или сроком оформи задачами проекта (create_todo). Принятые решения можно записать в журнал решений.",
      "Приветствия, болтовню, повторы и то, что уже записано раньше, пропусти. Если важного нет — ничего не записывай.",
      "Твой ответ в чат не отправляется: в нём коротко перечисли, что и куда записал, или напиши «Ничего важного».",
      "",
      "Сообщения:",
      ...fresh.map((line) => `[${stamp(line.sent_at)}] ${line.from_name}: ${line.text}`),
    ].join("\n");
    const result = await askJarvis(query, { bot, chat, projects, title: `Telegram · ${chat.title}: записи по чату`, body, kind: "digest", thread: `tg${chat.id}-d${Date.now().toString(36)}` });
    const summary = String(result.text || result.error || "").slice(0, 2000);
    const recorded = result.text && !/^\s*ничего важного/i.test(result.text) ? 1 : 0;
    await query(
      `UPDATE telegram_chats SET last_digest_at = now(), last_digest_message_id = $2, last_digest_summary = $3, notes_count = notes_count + $4, updated_at = now() WHERE id = $1`,
      [chat.id, fresh[fresh.length - 1].id, summary, recorded],
    );
    deps?.broadcast?.("telegram_chats");
    return { ok: true, summary };
  } finally {
    working.delete(`digest:${chat.id}`);
  }
}

async function upsertChat(query, bot, chat, status) {
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id);
  return (await query(
    `INSERT INTO telegram_chats(bot_id, chat_id, title, chat_type, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bot_id, chat_id) DO UPDATE SET title = EXCLUDED.title, chat_type = EXCLUDED.chat_type,
       status = CASE WHEN $6::boolean THEN EXCLUDED.status WHEN telegram_chats.status = 'left' THEN 'pending' ELSE telegram_chats.status END,
       updated_at = now()
     RETURNING *`,
    [bot.id, chat.id, title, chat.type || "", status, status === "left"],
  )).rows[0];
}

/** «/start <код>» в группе: привязывает чат к проектам из приглашения. true — это было приглашение (сообщение дальше не нужно). */
async function applyInvite(query, bot, token, chat, message, code) {
  const invite = (await query("SELECT * FROM telegram_invites WHERE code = $1 AND bot_id = $2", [code, bot.id])).rows[0];
  if (!invite) return false;
  const say = (body) => send(token, chat.chat_id, body, message.message_id).catch(() => []);
  if (!isLinkedSender(bot, message)) { await say("Эту ссылку может использовать только владелец бота."); return true; }
  const claimed = (await query("UPDATE telegram_invites SET used_at = now() WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING code", [code])).rows[0];
  if (!claimed) { await say("Ссылка уже использована или устарела. Создайте новую в MBOX: Настройки → Команда → Telegram-бот."); return true; }
  await query(
    `UPDATE telegram_chats SET project_ids = $2, company_ids = $3, status = 'active',
       last_digest_message_id = COALESCE((SELECT max(id) FROM telegram_messages WHERE chat_row_id = telegram_chats.id), 0), updated_at = now()
     WHERE id = $1`,
    [chat.id, invite.project_ids, invite.company_ids],
  );
  deps?.broadcast?.("telegram_chats");
  const fresh = { ...chat, project_ids: invite.project_ids, company_ids: invite.company_ids };
  const names = (await chatProjects(query, fresh, bot.owner_user_id)).map((project) => project.name);
  await say([
    names.length ? `Готово: чат работает с проектами ${names.join(", ")}.` : "Готово: чат подключён.",
    `Спросите меня: @${bot.username} вопрос. Важное из переписки я буду сам записывать в память проектов.`,
  ].join("\n"));
  return true;
}

const isLinkedSender = (bot, message) => bot.tg_user_id != null && Number(bot.tg_user_id) === message.from?.id;

const HELP = [
  "Как со мной говорить:",
  "• просто текст — отвечает Джарвис;",
  "• --claude вопрос — Claude на вашем компьютере, --claudecloud — Claude на сервере;",
  "• --gpt вопрос — GPT (Codex) на компьютере, --gptcloud — на сервере.",
  "Флаг можно поставить в любое место сообщения. В группах так же, после упоминания: @бот --claude вопрос; то же командами: /claude, /claudecloud, /gpt, /gptcloud (в группе — /claude@бот вопрос). Агенты отвечают, когда закончат работу — это может занять несколько минут.",
].join("\n");

/** Личная переписка с ботом: привязка аккаунта по коду (/start <код>) и общение привязанного владельца. */
async function handlePrivate(query, bot, token, message) {
  const text = messageText(message).trim();
  if (!token || !text || !message.from || message.from.is_bot) return;
  const reply = (body) => send(token, message.chat.id, body, message.message_id).catch(() => []);

  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  if (start?.[1]) {
    const linked = (await query(
      `UPDATE telegram_accounts SET tg_user_id = $2, tg_username = $3, link_code = NULL, link_code_expires = NULL, updated_at = now()
       WHERE user_id = $1 AND link_code = $4 AND link_code_expires > now() RETURNING user_id`,
      [bot.owner_user_id, message.from.id, message.from.username || "", start[1]],
    )).rows[0];
    if (!linked) { await reply("Код привязки не подошёл или устарел. Нажмите «Привязать Telegram» в MBOX ещё раз и откройте новую ссылку."); return; }
    deps?.broadcast?.("telegram_chats");
    await reply(`Готово, ${displayName(message.from)}: этот Telegram привязан к вашему аккаунту MBOX. Теперь только вы можете добавлять моих ботов в чаты и звать агентов.\n\n${HELP}`);
    return;
  }

  if (!isLinkedSender(bot, message)) {
    await reply("Это личный бот владельца MBOX. Привязать свой Telegram можно в MBOX: Настройки → Команда → Telegram-бот. В рабочих группах я отвечаю после настройки чата.");
    return;
  }
  if (/^\/(start|help)(@\w+)?$/i.test(text)) { await reply(HELP); return; }

  const call = parseCall(text, bot.username);
  if (call.skip) return;
  const { agent, text: question } = call;
  if (!question) { await reply(agent ? `Напишите вопрос вместе с флагом, например: --${agent} что нового по проекту?` : HELP); return; }
  if (agent) {
    await askAgent(query, { bot, token, tgChatId: message.chat.id, replyTo: message.message_id, flag: agent, text: question });
    return;
  }

  const key = `dm:${bot.id}`;
  if (working.has(key)) { await reply("Сейчас отвечаю на предыдущий вопрос — задайте этот через минуту."); return; }
  working.add(key);
  const typing = setInterval(() => { void tg(token, "sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => undefined); }, 4500);
  void tg(token, "sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => undefined);
  try {
    const scope = await ownerScope(query, bot.owner_user_id);
    if (!scope) { await reply("Не нашёл ваш аккаунт MBOX."); return; }
    const result = await askJarvis(query, {
      bot, projects: scope.projects, allProjects: scope.all, title: `Telegram: ${question.slice(0, 120)}`,
      body: `[Telegram] ${question}`, kind: "dm", question, thread: `tgdm${bot.id}`,
    });
    await reply(result.text || `Не получилось ответить: ${String(result.error || "").slice(0, 300)}`);
  } catch (error) {
    await reply(`Не получилось ответить: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearInterval(typing);
    working.delete(key);
  }
}

async function handleUpdate(query, bot, update) {
  const token = await botToken(query, bot.id);
  if (update.my_chat_member) {
    const { chat, new_chat_member: member, old_chat_member: before, from: adder } = update.my_chat_member;
    if (chat.type === "private") return;
    const gone = ["left", "kicked"].includes(member?.status);
    // Бота в чат добавляет только его владелец (привязанный аккаунт): чужое добавление — выходим и ничего не сохраняем.
    const justJoined = ["left", "kicked"].includes(before?.status) && ["member", "administrator"].includes(member?.status);
    if (justJoined && !isLinkedSender(bot, { from: adder })) {
      if (token) {
        await send(token, chat.id, bot.tg_user_id == null
          ? "Меня может добавлять в чаты только владелец бота, а он ещё не привязал свой Telegram в MBOX. Выхожу."
          : "Меня может добавлять в чаты только владелец бота. Выхожу.").catch(() => undefined);
        await tg(token, "leaveChat", { chat_id: chat.id }).catch(() => undefined);
      }
      return;
    }
    const row = await upsertChat(query, bot, chat, gone ? "left" : "pending");
    deps?.broadcast?.("telegram_chats");
    if (!gone && row.status === "pending" && token) {
      await send(token, chat.id, `Привет! Я помощник MBOX. Чтобы я начал работать, мой владелец выберет в Настройки → Команда → Telegram-бот, к каким проектам относится этот чат. До этого я ничего не читаю и не записываю.`).catch(() => undefined);
    }
    return;
  }
  const message = update.message || update.edited_message;
  if (!message || !message.chat) return;
  if (message.chat.type === "private") {
    await handlePrivate(query, bot, token, message);
    return;
  }
  const chat = await upsertChat(query, bot, message.chat, "pending");
  const text = messageText(message);
  // Ссылка «Добавить в чат» из MBOX: после добавления Telegram сам шлёт в группу «/start <код>» — настраиваем чат по выбору владельца.
  const invite = text.match(/^\/start(?:@\w+)?\s+(\S+)/i);
  if (invite && token && !update.edited_message) {
    if (await applyInvite(query, bot, token, chat, message, invite[1])) return;
  }
  if (text) {
    await query(
      `INSERT INTO telegram_messages(chat_row_id, message_id, from_id, from_name, text, reply_to, is_bot, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
       ON CONFLICT (chat_row_id, message_id) DO UPDATE SET text = EXCLUDED.text`,
      [chat.id, message.message_id, message.from?.id ?? null, displayName(message.from), text.slice(0, 8000), message.reply_to_message?.message_id ?? null, Boolean(message.from?.is_bot), message.date || Math.floor(Date.now() / 1000)],
    );
    await query("UPDATE telegram_chats SET last_message_at = now() WHERE id = $1", [chat.id]);
  }
  if (update.edited_message || message.from?.is_bot) return;
  const helpCommand = text.match(/^\s*\/help(?:@(\w+))?\s*$/i);
  if (helpCommand && token && (!helpCommand[1] || helpCommand[1].toLowerCase() === bot.username.toLowerCase())) {
    await send(token, message.chat.id, HELP, message.message_id).catch(() => undefined);
    return;
  }
  const call = parseCall(text, bot.username);
  if (call.skip) return;
  const mentioned = (message.entities || message.caption_entities || []).some((entity) => entity.type === "mention" && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${bot.username}`.toLowerCase())
    || message.reply_to_message?.from?.id === Number(bot.bot_user_id)
    || call.viaCommand;
  if (!mentioned || !token) return;
  // «@бот --claude вопрос» или «/claude вопрос»: агентов зовёт только привязанный аккаунт владельца. Без флага отвечает Джарвис.
  const { agent, text: agentQuestion } = call;
  if (agent) {
    if (!isLinkedSender(bot, message)) {
      await send(token, message.chat.id, bot.tg_user_id == null
        ? "Агентов можно звать, когда привязан ваш Telegram: Настройки → Команда → Telegram-бот → «Привязать Telegram»."
        : "Claude и GPT отвечают только владельцу бота.", message.message_id).catch(() => undefined);
      return;
    }
    if (!agentQuestion) {
      await send(token, message.chat.id, `Напишите вопрос после флага, например: @${bot.username} --${agent} что нового по проекту?`, message.message_id).catch(() => undefined);
      return;
    }
    const projects = await chatProjects(query, chat, bot.owner_user_id);
    const context = await recentLines(query, chat.id, 15, 0, message.message_id);
    const intro = [
      `[Telegram · групповой чат «${chat.title}»] Владелец обращается к тебе из рабочего чата через Telegram-бота MBOX. Ответь для Telegram: коротко, по делу, простое форматирование (абзацы, списки, **жирный**, без таблиц). Если просят что-то сделать — сделай и коротко скажи, что получилось.`,
      projects.length ? `Проекты этого чата: ${projects.map((project) => `${project.name} (#${project.id})`).join(", ")}.` : "",
      "Последние сообщения чата:",
      ...context.map((line) => `[${stamp(line.sent_at)}] ${line.is_bot ? "Бот" : line.from_name}: ${line.text}`),
      "",
      `Вопрос от ${displayName(message.from)}:`,
    ].join("\n");
    await askAgent(query, { bot, token, tgChatId: message.chat.id, chatRowId: chat.id, replyTo: message.message_id, flag: agent, text: agentQuestion, intro });
    return;
  }
  if (chat.status !== "active") {
    await send(token, message.chat.id, "Меня ещё не настроили для этого чата: владелец бота выбирает проекты в Настройки → Команда → Telegram-бот.", message.message_id).catch(() => undefined);
    return;
  }
  if (!chat.answers_enabled) return;
  await answerInChat(query, bot, chat, message, call.text);
}

/** Публичный вебхук Telegram (без сессии MBOX). Подлинность — секрет, который сервер сам выдал при регистрации. */
export async function handleTelegramWebhook({ req, res, url, query, readBody }) {
  const match = url.pathname.match(/^\/api\/mbox\/telegram\/hook\/(\d+)$/);
  if (!match || req.method !== "POST") return false;
  const bot = (await query("SELECT b.*, a.tg_user_id, a.tg_username FROM telegram_bots b LEFT JOIN telegram_accounts a ON a.user_id = b.owner_user_id WHERE b.id = $1", [match[1]])).rows[0];
  const header = String(req.headers["x-telegram-bot-api-secret-token"] || "");
  const valid = bot && header.length === bot.webhook_secret.length && timingSafeEqual(Buffer.from(header), Buffer.from(bot.webhook_secret));
  if (!valid) { res.writeHead(403); res.end(); return true; }
  const update = await readBody(req).catch(() => null);
  // Telegram ждёт быстрый ответ — обработка (в том числе ответ Джарвиса) идёт после.
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
  if (update) {
    handleUpdate(query, bot, update).catch(async (error) => {
      console.error(`[telegram] update ${update.update_id}: ${error.message}`);
      await query("UPDATE telegram_bots SET last_error = $2 WHERE id = $1", [bot.id, String(error.message).slice(0, 300)]).catch(() => undefined);
    });
  }
  return true;
}

/** Плановый обход: какие чаты пора разобрать, и уборка старых сообщений. */
export function startTelegramScheduler(query) {
  const tick = async () => {
    try {
      const due = (await query(
        `SELECT c.id FROM telegram_chats c
         WHERE c.status = 'active' AND c.notes_enabled
           AND (c.last_digest_at IS NULL OR c.last_digest_at < now() - make_interval(secs => $1))
           AND EXISTS (SELECT 1 FROM telegram_messages m WHERE m.chat_row_id = c.id AND m.id > c.last_digest_message_id AND NOT m.is_bot)
           AND (c.last_message_at < now() - make_interval(secs => $2)
                OR (SELECT count(*) FROM telegram_messages m WHERE m.chat_row_id = c.id AND m.id > c.last_digest_message_id AND NOT m.is_bot) >= $3)
         ORDER BY c.last_message_at LIMIT 3`,
        [DIGEST_GAP_MS / 1000, DIGEST_IDLE_MS / 1000, DIGEST_BATCH],
      )).rows;
      for (const row of due) await digestChat(query, row.id).catch((error) => console.error(`[telegram] digest ${row.id}: ${error.message}`));
      await query(`DELETE FROM telegram_messages WHERE sent_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    } catch (error) {
      console.error(`[telegram] scheduler: ${error.message}`);
    }
  };
  const timer = setInterval(() => void tick(), 60 * 1000);
  timer.unref?.();
  // Ответы агентов (Claude / GPT) приходят в инбокс MBOX в любой момент — забираем их каждые 3 секунды.
  const agentTimer = setInterval(() => void pollAgentRequests(query), 3000);
  agentTimer.unref?.();
  return timer;
}

function publicChat(row) {
  return {
    id: String(row.id), title: row.title, chat_type: row.chat_type, status: row.status,
    project_ids: (row.project_ids || []).map(String), company_ids: (row.company_ids || []).map(String),
    notes_enabled: row.notes_enabled, answers_enabled: row.answers_enabled,
    last_message_at: row.last_message_at, last_digest_at: row.last_digest_at, last_digest_summary: row.last_digest_summary,
    notes_count: row.notes_count, messages: Number(row.messages || 0),
  };
}

/** Всё, что видит интерфейс: привязанный Telegram человека и его боты, у каждого — свои чаты. */
async function state(query, userId) {
  const account = (await query("SELECT tg_user_id IS NOT NULL AS linked, tg_username FROM telegram_accounts WHERE user_id = $1", [userId])).rows[0] || { linked: false, tg_username: "" };
  const bots = (await query("SELECT id::text, username, name, can_read_all, last_error, created_at FROM telegram_bots WHERE owner_user_id = $1 ORDER BY id", [userId])).rows;
  for (const bot of bots) {
    bot.chats = (await query(
      `SELECT c.*, (SELECT count(*) FROM telegram_messages m WHERE m.chat_row_id = c.id) AS messages
       FROM telegram_chats c WHERE c.bot_id = $1 ORDER BY (c.status = 'left'), c.updated_at DESC`,
      [bot.id],
    )).rows.map(publicChat);
  }
  return { account, bots };
}

/** Выборка проектов и компаний — только из того, что видит сам человек. */
async function pickScope(query, user, body) {
  const scope = await projectScopeFor(query, user);
  const ids = (value) => [...new Set((Array.isArray(value) ? value : []).map(String).filter((id) => /^\d+$/.test(id)))];
  const projectIds = ids(body.project_ids).filter((id) => scope.all || scope.projectIds.includes(id));
  const companyIds = user.role === "owner" ? ids(body.company_ids) : ids(body.company_ids).filter((id) => (scope.companyIds || []).includes(id));
  // Только то, что существует: несуществующий номер в чат не попадёт.
  const [projects, companies] = await Promise.all([
    projectIds.length ? query("SELECT id::text FROM projects WHERE id = ANY($1::bigint[])", [projectIds]) : { rows: [] },
    companyIds.length ? query("SELECT id::text FROM companies WHERE id = ANY($1::bigint[])", [companyIds]) : { rows: [] },
  ]);
  const known = (rows) => new Set(rows.map((row) => row.id));
  const knownProjects = known(projects.rows);
  const knownCompanies = known(companies.rows);
  return { projectIds: projectIds.filter((id) => knownProjects.has(id)), companyIds: companyIds.filter((id) => knownCompanies.has(id)) };
}

const webhookParams = (origin, botId, secret) => ({ url: `${origin}/api/mbox/telegram/hook/${botId}`, secret_token: secret, allowed_updates: ["message", "edited_message", "my_chat_member"], drop_pending_updates: true });

/**
 * Настройка в MBOX (любой аккаунт со своим Джарвисом): боты, привязка своего Telegram, чаты и выборка проектов чата.
 *   GET    /api/mbox/telegram                      — привязка Telegram, боты и их чаты
 *   PUT    /api/mbox/telegram/bot                  — {token}: подключить ещё одного бота (getMe + вебхук)
 *   DELETE /api/mbox/telegram/bots/:id             — отключить бота
 *   POST   /api/mbox/telegram/bots/:id/refresh     — перепроверить бота: getMe (режим приватности) и вебхук
 *   POST   /api/mbox/telegram/bots/:id/invite      — {project_ids, company_ids}: ссылка «добавить бота в чат» с готовой настройкой
 *   POST   /api/mbox/telegram/link                 — {bot_id?}: ссылка для привязки своего Telegram
 *   DELETE /api/mbox/telegram/link                 — отвязать Telegram
 *   PATCH  /api/mbox/telegram/chats/:id            — {project_ids, company_ids, notes_enabled, answers_enabled, status}
 *   DELETE /api/mbox/telegram/chats/:id            — выйти из чата и забыть его
 *   POST   /api/mbox/telegram/chats/:id/digest     — разобрать новое прямо сейчас
 */
export async function handleTelegramApi({ req, res, url, query, readBody, sendJson, user, origin }) {
  if (!url.pathname.startsWith("/api/mbox/telegram")) return false;
  const userId = String(user.id);
  const ownBot = async (id) => (await query("SELECT id::text, username FROM telegram_bots WHERE id = $1 AND owner_user_id = $2", [id, userId])).rows[0];

  if (url.pathname === "/api/mbox/telegram" && req.method === "GET") {
    sendJson(res, 200, await state(query, userId));
    return true;
  }

  if (url.pathname === "/api/mbox/telegram/bot" && req.method === "PUT") {
    const body = await readBody(req);
    const token = String(body.token || "").trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) { sendJson(res, 400, { error: "Это не похоже на токен бота: его выдаёт @BotFather в виде 123456:ABC…" }); return true; }
    let me;
    try { me = await tg(token, "getMe"); } catch (error) { sendJson(res, 400, { error: `Telegram не принял токен: ${error.message}` }); return true; }
    const taken = (await query("SELECT owner_user_id::text FROM telegram_bots WHERE bot_user_id = $1 AND owner_user_id <> $2", [me.id, userId])).rows[0];
    if (taken) { sendJson(res, 409, { error: "Этот бот уже подключён к другому аккаунту MBOX" }); return true; }
    const secret = randomBytes(24).toString("hex");
    const row = (await query(
      `INSERT INTO telegram_bots(owner_user_id, token_ciphertext, bot_user_id, username, name, webhook_secret, can_read_all)
       VALUES ($1, pgp_sym_encrypt($2, $3), $4, $5, $6, $7, $8)
       ON CONFLICT (bot_user_id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext,
         username = EXCLUDED.username, name = EXCLUDED.name, webhook_secret = EXCLUDED.webhook_secret, can_read_all = EXCLUDED.can_read_all,
         last_error = '', updated_at = now()
       RETURNING id::text`,
      [userId, token, secretKey(), me.id, me.username || "", me.first_name || "", secret, Boolean(me.can_read_all_group_messages)],
    )).rows[0];
    try {
      await tg(token, "setWebhook", webhookParams(origin, row.id, secret));
      await tg(token, "setMyCommands", { commands: BOT_COMMANDS }).catch(() => undefined);
    } catch (error) {
      await query("UPDATE telegram_bots SET last_error = $2 WHERE id = $1", [row.id, `Вебхук не зарегистрирован: ${error.message}`]);
    }
    sendJson(res, 200, await state(query, userId));
    return true;
  }

  const botMatch = url.pathname.match(/^\/api\/mbox\/telegram\/bots\/(\d+)(?:\/(refresh|invite))?$/);
  if (botMatch) {
    const bot = await ownBot(botMatch[1]);
    if (!bot) { sendJson(res, 404, { error: "not_found" }); return true; }
    const token = await botToken(query, bot.id);

    if (!botMatch[2] && req.method === "DELETE") {
      if (token) await tg(token, "deleteWebhook", { drop_pending_updates: true }).catch(() => undefined);
      await query("DELETE FROM telegram_bots WHERE id = $1", [bot.id]);
      sendJson(res, 200, await state(query, userId));
      return true;
    }

    if (botMatch[2] === "refresh" && req.method === "POST") {
      try {
        const me = await tg(token, "getMe");
        const secret = (await query("SELECT webhook_secret FROM telegram_bots WHERE id = $1", [bot.id])).rows[0].webhook_secret;
        await tg(token, "setWebhook", { ...webhookParams(origin, bot.id, secret), drop_pending_updates: false });
        await tg(token, "setMyCommands", { commands: BOT_COMMANDS }).catch(() => undefined);
        await query("UPDATE telegram_bots SET username = $2, name = $3, can_read_all = $4, last_error = '', updated_at = now() WHERE id = $1", [bot.id, me.username || bot.username, me.first_name || "", Boolean(me.can_read_all_group_messages)]);
      } catch (error) {
        await query("UPDATE telegram_bots SET last_error = $2 WHERE id = $1", [bot.id, `Проверка не прошла: ${error.message}`.slice(0, 300)]);
      }
      sendJson(res, 200, await state(query, userId));
      return true;
    }

    if (botMatch[2] === "invite" && req.method === "POST") {
      const { projectIds, companyIds } = await pickScope(query, user, await readBody(req));
      const code = randomBytes(12).toString("base64url");
      const expires = (await query(
        "INSERT INTO telegram_invites(code, bot_id, project_ids, company_ids, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING expires_at",
        [code, bot.id, projectIds, companyIds, INVITE_MINUTES],
      )).rows[0].expires_at;
      await query("DELETE FROM telegram_invites WHERE expires_at < now() - interval '1 day'");
      sendJson(res, 200, { ...(await state(query, userId)), invite: { bot_id: bot.id, url: `https://t.me/${bot.username}?startgroup=${code}&admin=manage_chat`, expires_at: expires } });
      return true;
    }
    return false;
  }

  // Привязка своего аккаунта Telegram: одноразовая ссылка t.me/<бот>?start=<код>, действует 15 минут. Один аккаунт на все боты.
  if (url.pathname === "/api/mbox/telegram/link" && req.method === "POST") {
    const body = await readBody(req);
    const bot = (body.bot_id && await ownBot(String(body.bot_id))) || (await query("SELECT id::text, username FROM telegram_bots WHERE owner_user_id = $1 ORDER BY id LIMIT 1", [userId])).rows[0];
    if (!bot) { sendJson(res, 404, { error: "Сначала подключите бота" }); return true; }
    const code = randomBytes(12).toString("base64url");
    const expires = (await query(
      `INSERT INTO telegram_accounts(user_id, link_code, link_code_expires) VALUES ($1, $2, now() + make_interval(mins => $3))
       ON CONFLICT (user_id) DO UPDATE SET link_code = EXCLUDED.link_code, link_code_expires = EXCLUDED.link_code_expires, updated_at = now()
       RETURNING link_code_expires`,
      [userId, code, LINK_CODE_MINUTES],
    )).rows[0].link_code_expires;
    sendJson(res, 200, { ...(await state(query, userId)), link: { url: `https://t.me/${bot.username}?start=${code}`, expires_at: expires } });
    return true;
  }

  if (url.pathname === "/api/mbox/telegram/link" && req.method === "DELETE") {
    await query("DELETE FROM telegram_accounts WHERE user_id = $1", [userId]);
    sendJson(res, 200, await state(query, userId));
    return true;
  }

  const match = url.pathname.match(/^\/api\/mbox\/telegram\/chats\/(\d+)(\/digest)?$/);
  if (!match) return false;
  const chat = (await query(
    "SELECT c.*, b.owner_user_id FROM telegram_chats c JOIN telegram_bots b ON b.id = c.bot_id WHERE c.id = $1",
    [match[1]],
  )).rows[0];
  if (!chat || String(chat.owner_user_id) !== userId) { sendJson(res, 404, { error: "not_found" }); return true; }

  if (match[2] && req.method === "POST") {
    const result = await digestChat(query, chat.id, { force: true });
    sendJson(res, 200, { result, ...(await state(query, userId)) });
    return true;
  }

  if (req.method === "PATCH") {
    const body = await readBody(req);
    const { projectIds, companyIds } = await pickScope(query, user, body);
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const nextStatus = has("status") && ["active", "paused"].includes(body.status) ? body.status
      : (projectIds.length || companyIds.length) && chat.status === "pending" ? "active" : chat.status;
    await query(
      `UPDATE telegram_chats SET
         project_ids = CASE WHEN $2::boolean THEN $3::bigint[] ELSE project_ids END,
         company_ids = CASE WHEN $4::boolean THEN $5::bigint[] ELSE company_ids END,
         notes_enabled = COALESCE($6, notes_enabled),
         answers_enabled = COALESCE($7, answers_enabled),
         status = $8,
         last_digest_message_id = CASE WHEN status = 'pending' AND $8 = 'active'
           THEN COALESCE((SELECT max(id) FROM telegram_messages WHERE chat_row_id = telegram_chats.id), 0) ELSE last_digest_message_id END,
         updated_at = now()
       WHERE id = $1`,
      [chat.id, has("project_ids"), projectIds, has("company_ids"), companyIds, typeof body.notes_enabled === "boolean" ? body.notes_enabled : null, typeof body.answers_enabled === "boolean" ? body.answers_enabled : null, nextStatus],
    );
    sendJson(res, 200, await state(query, userId));
    return true;
  }

  if (req.method === "DELETE") {
    const token = await botToken(query, chat.bot_id);
    if (token && chat.status !== "left") await tg(token, "leaveChat", { chat_id: chat.chat_id }).catch(() => undefined);
    await query("DELETE FROM telegram_chats WHERE id = $1", [chat.id]);
    sendJson(res, 200, await state(query, userId));
    return true;
  }
  return false;
}

export function configureTelegram(next) {
  deps = next;
}

