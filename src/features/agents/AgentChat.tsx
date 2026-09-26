import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, AppWindow, Archive, ArrowUp, AtSign, Brain, Bug, Check, ChevronDown, Cloud, CornerDownRight, DollarSign, FileText, Globe, Hash, MessageSquarePlus, MessagesSquare, Monitor, PanelLeft, Paperclip, Pencil, Reply, Slash, SquareCheck, StickyNote, Table2, Terminal, Wrench, X } from "lucide-react";
import { describeStep, isAccessError, stepsDigest } from "./chainSteps";
import { AgentAvatar, AgentName } from "../../components/AgentAvatar";
import { NeedsAnswer } from "./NeedsAnswer";
import { effectiveStatus, liveRunOf, CLOUD_AGENTS, agentDisplayName, isCloudAgent } from "../../lib/agents";
import { fetchJson } from "../../lib/api";
import { formatSince, plural } from "../../lib/format";
import type { AgentActivity, AgentInboxItem, AgentRun, Artifact, Project } from "../../types";
import { scopedStorageKey, usePersistentState } from "../../app/workbench/tabs";
import { useDraft } from "../../app/workbench/uiMemory";
import { storageFileUrl, uploadToStorage } from "../../lib/storageUpload";
import { serverOrigin } from "../../lib/serverOrigin";
import { AGENT_STEP_EVENT } from "../../hooks/useRealtime";
import { markOverlay } from "../../app/workbench/BrowserDocument";
import { formatBytes } from "../../lib/format";
import type { ChatDebug } from "../../app/workbench/ConsoleArea";
import { ChatHeadSlot } from "../../app/workbench/chatHeadSlot";
import { createPortal } from "react-dom";

const JARVIS_NAME = "Джарвис";
const CHAT_HISTORY_LIMIT = 50;
const CHAT_RENDER_LIMIT = 70;

const SLASH_COMMANDS = [
  { value: "help", hint: "эта справка" },
  { value: "status", hint: "кто сейчас на связи" },
  { value: "agents", hint: "кто сейчас на связи" },
  { value: "blocked", hint: "задачи, которые ждут решения" },
  { value: "who", hint: "что известно про агента" },
  { value: "jarvis", hint: "из чего состоит Джарвис — агенты, инструменты, скиллы" },
  { value: "clear", hint: "очистить окно" },
  { value: "new", hint: "новый чат — агент начнёт с чистого контекста" },
];

/** Ручной список — тот же набор function-схем живёт в JARVIS_TOOLS на сервере (см.
 * server/mbox-server.mjs), дублировать через сеть ради справочного текста не стоило. */
const JARVIS_DESCRIPTION = [
  "Джарвис — не одна модель, а система из нескольких ролей:",
  "",
  "агенты:",
  "  Джарвис сам (Gemini) — основной голос, ведёт диалог по умолчанию.",
  "  Прораб (openai/gpt-oss-120b, Groq) — резерв, если Gemini недоступна. Тесная квота",
  "    Groq (8К токенов/мин), поэтому бережём его для оркестрации, а не разовых задач.",
  "  Младший (openai/gpt-oss-20b, Groq) — однократные вызовы без своего контекста диалога: пересказ",
  "    страницы источника данных, классификация факт/лог. Своя, куда более щедрая квота Groq.",
  "  Claude — ОТДЕЛЬНЫЙ агент (Claude Sonnet, через Claude Code), не резервная модель Джарвиса.",
  "    Главный разработчик системы: тяжёлые задачи — код MBOX, деплой на прод, глубокий анализ",
  "    больших массивов данных (например, разбор постов канала для скилла контента). Джарвис не",
  "    подменяет собой Claude на таких задачах, а прямо говорит, что это к Claude.",
  "",
  "tools (настоящие действия, дергают базу):",
  "  задачи: create_todo, update_todo_status, set_todo_priority, delete_todo, update_todo_note,",
  "    list_project_todos, search_todos, get_task (полная карточка задачи по ID)",
  "  проекты: create_project, delete_project, update_project_info (стек/git/деплой/статус),",
  "    get_project_info, link_projects, find_file",
  "  компании: list_companies, get_company_info, create_company, update_company_info",
  "  память: record_memory, update_memory (правка по ID), delete_memory, search_memory, get_memory",
  "    (полный текст записи по ID), get_memory_actions (история правок записи), list_memory_links",
  "    (что связано с записью), link_memories (связать две записи отношением)",
  "  папки: create_folder, list_folders",
  "  артефакты: create_artifact, list_artifacts",
  "  решения: record_decision",
  "  источники данных: list_data_sources, create_data_source, refresh_data_source, search_tour_dates,",
  "    analyze_posts (инсайты по постам Telegram-канала: топ/антитоп, сравнение с фото/без)",
  "  служебное: get_groq_usage (расход токенов по всем моделям, включая Gemini — без известного лимита),",
  "    list_recent_activity, delegate_to_junior (скинуть Младшему мелкую текстовую подзадачу — черновик,",
  "    сводку, пересказ — внутри цепочки действий, не тратя контекст самого Джарвиса)",
  "",
  "комбо: Джарвис уверенно выполняет цепочку из 3-5 инструментов в одном ответе, не останавливаясь",
  "  после первого шага и не переспрашивая между шагами, если вся последовательность уже описана",
  "  одним сообщением (потолок — 8 шагов цикла на ответ).",
  "",
  "контекст: если сообщение отправлено со страницы конкретного проекта, Джарвис видит, какой именно",
  "  проект сейчас открыт, и по умолчанию имеет в виду его, если проект не назван явно.",
  "",
  "skills (одноразовые, без оркестрации — отданы Младшему):",
  "  пересказ веб-страницы источника данных (5-10 пунктов, без воды)",
  "  классификация записи памяти (факт/лог)",
  "",
  "назначение: библиотекарь (память, проекты) + начальник склада (задачи, источники данных)",
  "+ личный ассистент (чат, вопросы). Тяжёлая разработка и глубокий анализ — не к Джарвису, а к Claude.",
].join("\n");

const TRIGGER_ICON = { "@": AtSign, "/": Slash, "$": DollarSign, "#": Hash } as const;

type Suggestion = { value: string; hint?: string };

/**
 * Что у человека открыто в рабочем месте (активная вкладка и вторая область). Уходит агенту вместе с
 * сообщением (props.context), чтобы «поправь тут заголовок» не начиналось с поиска файла по диску.
 * Чип можно отжать — тогда этот пункт агенту не отправится.
 */
export type FocusItem = { key: string; kind: string; title: string; id?: string; detail?: string };

const FOCUS_ICON: Record<string, typeof FileText> = { file: FileText, diff: FileText, note: StickyNote, todo: SquareCheck, web: Globe, storage: Table2, memory: Brain };

/** Ведущее @Имя в начале сообщения — раньше был отдельный ростер кнопок для выбора адресата,
 * теперь то же самое просто печатается в тексте (см. подсказки по @) и парсится отсюда. */
function parseMention(raw: string): string {
  const match = raw.trim().match(/^@(\S+)/);
  return match ? match[1] : "";
}

// Ссылки идут первыми: внутри URL бывают «_» и «*», которые иначе съел бы курсив.
const MARKDOWN_TOKEN = /(\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]*[^\s<>().,;:!?»"'`]|\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<!\w)_[^_\n]+_(?!\w))/g;
const MARKDOWN_LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/** Ключ вкладки рабочего места из ссылки на MBOX: «/?tab=file:9» или «https://<сервер MBOX>/?tab=file:9». */
function workbenchTabOf(href: string) {
  try {
    const url = new URL(href, serverOrigin());
    const sameServer = url.origin === serverOrigin() || url.origin === window.location.origin;
    const tab = url.searchParams.get("tab");
    return sameServer && tab && url.pathname === "/" ? tab : null;
  } catch {
    return null;
  }
}

/** Локальный путь из markdown-ссылки, file:// URL или `инлайн-кода`. */
function localPathOf(href: string) {
  let value = href.trim();
  if (/^path:/i.test(value)) value = value.slice(5);
  else if (/^file:\/{2,3}/i.test(value)) value = value.replace(/^file:\/{2,3}/i, "");
  else if (!/^[a-zA-Z]:[\\/]/.test(value)) return null;
  try { value = decodeURIComponent(value); } catch { /* путь может содержать обычный % */ }
  if (/^\/[a-zA-Z]:[\\/]/.test(value)) value = value.slice(1);
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("~") ? value : null;
}

/** Ссылка в сообщении: MBOX и локальный файл открываются внутри рабочего места, остальное — в браузере. */
function ChatLink({ href, children }: { href: string; children: ReactNode }) {
  const localPath = localPathOf(href);
  if (!localPath && !/^(https?:\/\/|\/)/i.test(href)) return <>{children}</>;
  const tab = workbenchTabOf(href);
  const absolute = href.startsWith("/") ? `${serverOrigin()}${href}` : href;
  return (
    <a
      className="console-log-link"
      href={localPath ? "#" : absolute}
      target={localPath || tab ? undefined : "_blank"}
      rel="noreferrer noopener"
      onClick={(event) => {
        if (!localPath && !tab) return;
        event.preventDefault();
        const detail = localPath
          ? { kind: "path", path: localPath, actor: "", reply_to: "", title: String(children), note: "", quiet: true }
          : { kind: "tab", key: tab, actor: "", reply_to: "", title: "", note: "", quiet: true };
        window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail }));
      }}
      title={localPath ? `Открыть в MBOX: ${localPath}` : tab ? "Открыть во вкладке MBOX" : absolute}
    >
      {children}
    </a>
  );
}

function renderInlineMarkdown(content: string, keyPrefix: string): ReactNode[] {
  const parts = content.split(MARKDOWN_TOKEN).filter((part) => part !== "");
  return parts.map((part, partIndex) => {
    const key = `${keyPrefix}-${partIndex}`;
    const link = part.match(MARKDOWN_LINK);
    if (link) return <ChatLink key={key} href={link[2]}>{link[1]}</ChatLink>;
    if (/^https?:\/\//i.test(part)) return <ChatLink key={key} href={part}>{part}</ChatLink>;
    if (part.startsWith("**") && part.endsWith("**")) return <b key={key}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      return localPathOf(code) ? <ChatLink key={key} href={`path:${code}`}><code>{code}</code></ChatLink> : <code key={key}>{code}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith("_") && part.endsWith("_")) return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** `| a | b |` + разделитель `|---|---|` — Джарвис пересказывает даты туров именно так, и без
 * разбора это была нечитаемая простыня труб в моноширинном логе. Только через дефис/двоеточие,
 * без выравнивания колонок и вложенных markdown-таблиц — этого достаточно для реальных ответов. */
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** Модель (например, Джарвис) иногда шлёт **bold**/`code`/*italic*, списки и markdown-таблицы —
 * раньше это лежало в логе буквальным текстом со звёздочками и трубами. Без внешней библиотеки:
 * разбор построчно, таблицы — отдельным блоком поверх обычных строк. */
function renderMarkdownLite(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    // Блок кода ```…``` — раньше разбирался как инлайн-код, и от ограды оставались одиночные кавычки.
    if (lines[i].trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i += 1; }
      i += 1;
      blocks.push(<pre key={`pre-${blocks.length}`} className="console-log-pre">{code.join("\n")}</pre>);
      continue;
    }
    const isTableStart = lines[i].includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_ROW.test(lines[i + 1]);
    if (isTableStart) {
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <table key={`table-${blocks.length}`} className="console-log-table">
          <thead><tr>{header.map((cell, ci) => <th key={ci}>{renderInlineMarkdown(cell, `th-${ci}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInlineMarkdown(cell, `td-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const line = lines[i];
    const isListItem = /^\s*[-*]\s/.test(line);
    const content = isListItem ? line.replace(/^\s*[-*]\s/, "") : line;
    blocks.push(
      <span key={`line-${blocks.length}`}>
        {isListItem ? "• " : ""}
        {renderInlineMarkdown(content, `line-${blocks.length}`)}
        {i < lines.length - 1 && <br />}
      </span>,
    );
    i += 1;
  }
  return blocks;
}

/** Активный токен под курсором: символ-триггер сразу после пробела/начала строки и то, что после него набрано. */
function activeToken(value: string, cursor: number): { trigger: "@" | "/" | "$" | "#"; query: string; start: number } | null {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)([@/$#])(\S*)$/);
  if (!match) return null;
  const trigger = match[1] as "@" | "/" | "$" | "#";
  const query = match[2];
  const start = cursor - query.length - 1;
  // Слэш-команды — это ЦЕЛОЕ сообщение (см. runCommand), не мог быть где-то в середине текста.
  if (trigger === "/" && start !== 0) return null;
  return { trigger, query, start };
}

const HUMAN = "Человек";
const READ_KEY = "mbox.chat.readAt";
// agent_error здесь не случайно: когда наблюдатель агента спотыкается, ошибка ложилась в инбокс,
// но в переписке не показывалась вообще — человек сидел перед пустым чатом и считал, что «ничего
// не происходит», хотя ответ давно провалился. Молчание неотличимо от работы, и это хуже ошибки.
const CONVERSATION = new Set(["question", "answer", "agent_message", "agent_response", "chat", "agent_error"]);

/** На какое сообщение отвечает запись: кнопка «Ответить» пишет props.re, наблюдатели агентов — in_reply_to. */
function repliedId(item: AgentInboxItem) {
  return String(item.props?.re ?? item.props?.in_reply_to ?? "");
}

function snippet(text: string, max = 140) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Разговор с одним агентом: сообщения человека ему (props.to или ведущее @Имя) и ответы этого агента
 * человеку. Реплики агента, адресованные другому агенту, сюда не попадают.
 */
/**
 * Чат, к которому относится сообщение (props.thread). Пусто — старый общий чат.
 *
 * Зачем чаты: агенты Claude и Codex продолжают сессию своего CLI внутри чата и не перечитывают
 * историю заново, а новый чат начинается с чистого контекста. Раньше в каждый запрос вклеивались
 * десятки последних реплик всей консоли, и лимит подписки уходил на чтение чужих разговоров.
 */
function threadOfItem(item: AgentInboxItem) {
  return typeof item.props?.thread === "string" ? item.props.thread : "";
}

function newThreadId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

type ChatThread = { id: string; title: string; custom_title?: boolean; last_at: string; messages: number; peer: string | null; last_agent: string | null; last_work?: LogLine["work"] | null };

/** Сколько занимает контекст сессии агента в чате: последний ответ с этой цифрой. */
type ContextLoad = { tokens: number; window: number; agent: string };

function contextLoadText(load: ContextLoad) {
  const percent = load.window ? Math.round((load.tokens / load.window) * 100) : 0;
  return `${formatWorkTokens(load.tokens)}${load.window ? ` из ${formatWorkTokens(load.window)} · ${percent}%` : ""}`;
}

/**
 * Облачный напарник вкладки: у Claude — ClaudeCloud, у ChatGPT — CodexCloud (deploy/cloud-agents на сервере).
 * Во вкладке агента чат бывает локальным или облачным — это собеседник, записанный в чате (thread.peer).
 */
function cloudPeerOf(peer: string) {
  const name = peer.toLowerCase();
  if (name === "claude") return CLOUD_AGENTS.claude;
  if (name === "chatgpt" || name === "codex") return CLOUD_AGENTS.codex;
  return "";
}

/** Каталог моделей публикуют «Claude» и «ChatGPT»; облачные агенты — те же CLI и берут тот же набор. */
function catalogAgent(name: string) {
  const key = name.toLowerCase();
  if (key === CLOUD_AGENTS.claude.toLowerCase()) return "claude";
  if (key === CLOUD_AGENTS.codex.toLowerCase()) return "chatgpt";
  return key;
}

function peerNames(peer: string) {
  const name = peer.toLowerCase();
  const local = name === "chatgpt" ? ["chatgpt", "codex"] : [name];
  const cloud = cloudPeerOf(peer).toLowerCase();
  return cloud ? [...local, cloud] : local;
}

function threadMatchesPeer(thread: ChatThread, peer: string) {
  if (!peer) return true;
  const names = peerNames(peer);
  return names.includes(String(thread.peer || "").toLowerCase()) || names.includes(String(thread.last_agent || "").toLowerCase());
}

function belongsToPeer(item: AgentInboxItem, peer: string) {
  const names = new Set(peerNames(peer));
  const to = String(item.props?.to ?? "").toLowerCase();
  if (item.agent_name === HUMAN) return to ? names.has(to) : names.has(parseMention(item.body || item.title).toLowerCase());
  return names.has(item.agent_name.toLowerCase()) && (!to || names.has(to) || to === HUMAN.toLowerCase());
}

/**
 * Что агент делает прямо сейчас. Считается из живых сессий и присутствия, а не выдумывается.
 * Живой = по сессии стучит heartbeat; брошенный running не выдаётся за работу (см. lib/agents).
 */
function agentState(agent: AgentActivity, runs: AgentRun[]) {
  const live = liveRunOf(runs, agent.name);
  if (live) return { key: "working", label: "отвечает", detail: live.goal };
  const status = effectiveStatus(agent);
  // phase — живой сигнал, который агент сам присылает через POST /agent/ping (не выдумываем
  // "думает" статично: если фазы нет, значит агент сейчас реально ничего не делает).
  if (status === "active" && agent.phase) return { key: "working", label: agent.phase, detail: "" };
  if (status === "active") return { key: "active", label: "на связи", detail: "ждёт задачу" };
  if (status === "idle") return { key: "idle", label: "ожидает", detail: formatSince(agent.last_seen) };
  return { key: "offline", label: "отключён", detail: formatSince(agent.last_seen) };
}

const coarsePointer = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

const THINKING_FRAMES =[1, 2, 3, 4, 5].map((n) => `/assets/icons/ai-thinking-spinner/${n}.png`);

/** Живой спиннер вместо статичного "думает…" — кадры лежат в public/assets/icons/ai-thinking-spinner. */
function ThinkingSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % THINKING_FRAMES.length), 220);
    return () => window.clearInterval(timer);
  }, []);
  return <img className="console-thinking-spinner" src={THINKING_FRAMES[frame]} width={32} height={32} alt="" />;
}

// Пока сервер не прислал реальную фазу (setPhase в replyAsJarvis) — вместо голого "думает"
// плашка перебирает случайные варианты (см. интервал в AgentChat), с лёгкой самоиронией.
const THINKING_VERBS = [
  "думает",
  "размышляет",
  "подбирает инструмент",
  "готовится",
  "прикидывает",
  "взвешивает варианты",
  "листает память",
  "советуется с базой",
  "собирается с мыслями",
  "наводит справки",
  "сверяется с протоколом",
  "приводит мысли в порядок",
  "изображает бурную деятельность",
  "принимает благородный вид",
  "тщательно обдумывает",
  "не торопится, как подобает",
  "консультируется с внутренним голосом",
  "делает вид, что всё под контролем",
  "варит кофе для процессора",
  "считает ворон в облаке",
  "гуглит, но не признаётся",
  "спрашивает совета у осьминога",
  "перебирает варианты щупальцами",
  "притворяется занятым",
  "делает умное лицо",
  "тянет резину",
  "ищет вдохновение",
  "медитирует над задачей",
  "разговаривает сам с собой",
  "смотрит в потолок с важным видом",
  "перекладывает биты с места на место",
  "запрашивает мудрость предков",
  "втайне сомневается",
  "листает справочник хорошего дворецкого",
  "поправляет щупальца в манжетах",
  "гладит фрак всеми восемью руками",
  "разливает чай в восемь чашек одновременно",
  "полирует поднос щупальцем",
  "клянётся честью дворецкого",
  "щупальцем поправляет монокль",
  "восемь рук — восемь дел, но сначала думает",
  "прячется в чернильное облако от смущения",
  "меняет цвет от усердия",
  "раскладывает столовые приборы по этикету головоногих",
  "почтительно кланяется всеми щупальцами разом",
  "поправляет бабочку",
  "прочищает горло",
  "выигрывает время",
  "советуется с чайником",
  "созывает внутренний консилиум",
  "делает вид, что всё сложно",
  "притормаживает для эффекта",
  "наслаждается драматической паузой",
  "аккуратно паникует",
  "вспоминает, зачем пришёл",
  "торжественно молчит",
  "нагоняет важности",
  "делает три дела одновременно (на самом деле нет)",
];
// Исключаем текущий вариант, чтобы плашка не «мигала» одним и тем же словом два раза подряд.
function randomThinkingVerb(exclude?: string) {
  const pool = exclude ? THINKING_VERBS.filter((verb) => verb !== exclude) : THINKING_VERBS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Ошибка наблюдателя как её видит человек: «codex.exe завершился с кодом 1. Исчерпан лимит подписки:
 * {"type":"error","message":"…"}» превращается в текст из message, а код выхода уходит в подробности.
 */
function humanizeAgentError(text: string) {
  let message = text.trim();
  let detail = "";
  const exit = message.match(/^(\S+ завершился с кодом -?\d+)\.\s*/);
  if (exit) { detail = exit[1]; message = message.slice(exit[0].length); }
  const from = message.indexOf("{");
  const to = message.lastIndexOf("}");
  if (from >= 0 && to > from) {
    try {
      const parsed = JSON.parse(message.slice(from, to + 1)) as { message?: unknown; error?: { message?: unknown } };
      const inner = typeof parsed.message === "string" ? parsed.message : typeof parsed.error?.message === "string" ? parsed.error.message : "";
      if (inner) {
        const lead = message.slice(0, from).trim().replace(/:$/, "");
        message = lead ? `${lead}.\n${inner}` : inner;
      }
    } catch { /* не JSON — оставляем как есть */ }
  }
  const seen = new Set<string>();
  message = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[\w:.-]+\]\s*\{.*\}$/.test(line) && !/^\S+ завершился с кодом -?\d+\.?$/.test(line))
    .filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
    .join("\n");
  return { message, detail };
}

type MessageAction = { label: string; value: string };

/** Что сервер разрешает выбрать в поле ввода — см. jarvisModels в server/jarvis.mjs. */
type JarvisCatalog = {
  /** У моделей Claude и ChatGPT свой набор уровней effort — его публикует CLI на машине владельца. */
  models: Array<{ id: string; label: string; provider: string; role: string; agent?: string; efforts?: string[]; default_effort?: string }>;
  efforts: Array<{ id: string; label: string; hint: string }>;
  effortLabels: Record<string, { label: string; hint: string }>;
  /** Что сработает, если человек ничего не выбрал — показываем это же в поле ввода. */
  defaultModel: string;
  defaults: Record<string, string>;
  defaultEffort: string;
};

/** Один шаг работы агента: вызов инструмента с аргументами и результатом либо реплика между шагами. */
type ChainStep = {
  kind: "tool" | "text";
  name?: string;
  hint?: string;
  input?: string;
  output?: string;
  is_error?: boolean;
  ms?: number;
  text?: string;
};

/**
 * Цепочка работы агента — то, что в Claude Code видно прямо в переписке: шаг, его аргументы и то,
 * что инструмент вернул. Всё это приезжает из потока CLI (наблюдатель собирает props.steps).
 *
 * Чего здесь принципиально нет — текста размышления: блоки thinking приходят из CLI пустыми, сырую
 * цепочку рассуждений API не отдаёт. Поэтому шагов «Thinking» тут нет вовсе, а сколько модель
 * думала, видно строкой выше, в сводке хода работы.
 */
function ChainTimeline({ steps }: { steps: ChainStep[] }) {
  // Длинная цепочка целиком забивает переписку, поэтому по умолчанию видны только последние шаги:
  // они и есть «что происходит сейчас», а начало разворачивается по кнопке.
  const [full, setFull] = useState(false);
  const hidden = full ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = hidden ? steps.slice(hidden) : steps;
  return (
    <>
      {hidden > 0 && (
        <button type="button" className="console-chain-more" onClick={() => setFull(true)}>
          ещё {hidden} {plural(hidden, "шаг", "шага", "шагов")} выше
        </button>
      )}
      <ol className="console-chain">
        {shown.map((step, index) => {
          if (step.kind === "text") {
            return (
              <li key={hidden + index} className="is-text">
                <p className="console-chain-say">{step.text}</p>
              </li>
            );
          }
          const view = describeStep(step);
          const Icon = view.icon;
          return (
            <li key={hidden + index} className={step.is_error ? "is-error" : undefined}>
              {/* Аргументы и вывод свёрнуты: в строке — что за шаг словами и с чем, а содержимое
                  раскрывается щелчком по строке — иначе один Read забивает пол-экрана. */}
              <details className="console-chain-step">
                <summary title={view.tool}>
                  <Icon size={12} className="console-chain-icon" />
                  <b>{view.label}</b>
                  {view.detail && <span>{view.detail}</span>}
                  {step.is_error && <em className="console-chain-err">{isAccessError(view.error) ? "нет доступа" : "ошибка"}</em>}
                  {step.ms ? <time>{step.ms >= 1000 ? `${Math.round(step.ms / 1000)} с` : `${step.ms} мс`}</time> : null}
                </summary>
                {view.error && <p className="console-chain-reason">{view.error}</p>}
                {step.input && <pre className="console-chain-io" data-label="IN">{step.input}</pre>}
                {step.output && <pre className="console-chain-io" data-label="OUT">{step.output}</pre>}
              </details>
            </li>
          );
        })}
      </ol>
    </>
  );
}

type PickerOption = { value: string; label: string; hint?: string };

/**
 * Выпадающий список у поля ввода.
 *
 * Нативный <select> здесь не годился: Chromium рисует его список силами системы — белый на тёмной
 * теме, с нечитаемыми пунктами, без места под пояснение к варианту, и он выпадает за пределы окна
 * (а значит и поверх встроенного браузера его не положить). Свой список решает всё сразу: тема,
 * подписи-пояснения и markOverlay, который убирает страницу браузера, пока список открыт.
 * Раскрывается вверх — поле ввода стоит у нижнего края.
 */
function ComposerPicker({ label, value, onChange, options, placeholder, defaultValue = "" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  placeholder: string;
  /** Вариант, который сработает сам собой: он и есть строка «по умолчанию», в списке не повторяется. */
  defaultValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((item) => item.value === value);
  const rest = options.filter((item) => item.value !== defaultValue);

  useEffect(() => {
    if (!open) return;
    markOverlay(true);
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      markOverlay(false);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (next: string) => { onChange(next); setOpen(false); };

  return (
    <div className="console-picker" ref={rootRef}>
      <button
        type="button"
        className={open ? "console-picker-btn is-open" : "console-picker-btn"}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <span>{current ? current.label : placeholder}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="console-picker-menu" role="listbox" aria-label={label}>
          <button type="button" role="option" aria-selected={!value} className={!value ? "is-current" : undefined} onClick={() => pick("")}>
            <span>
              <strong>{placeholder}</strong>
              <small>по умолчанию</small>
            </span>
            {!value && <Check size={13} />}
          </button>
          {rest.map((item) => (
            <button
              type="button"
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              className={item.value === value ? "is-current" : undefined}
              onClick={() => pick(item.value)}
            >
              <span>
                <strong>{item.label}</strong>
                {item.hint && <small>{item.hint}</small>}
              </span>
              {item.value === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Сколько шагов цепочки показывать без разворота — остальные прячутся за кнопкой. */
const VISIBLE_STEPS = 6;

const EFFORT_LABEL: Record<string, string> = { low: "быстро", medium: "обычно", high: "тщательно" };

/**
 * «Ход работы · 1,3k токенов размышления · 12 с».
 *
 * У Claude Code текста размышления не получить — API не возвращает сырую цепочку рассуждений, а
 * блоки thinking приходят из CLI пустыми. Зато честно отдаётся, СКОЛЬКО он думал, сколько это
 * заняло и во сколько обошлось; вместе со списком инструментов ниже это и есть «что он делал».
 */
function workSummary(work: LogLine["work"]) {
  const parts = workParts(work);
  return parts.length ? `Ход работы · ${parts.join(" · ")}` : "";
}

function workParts(work: LogLine["work"]) {
  const parts: string[] = [];
  if (!work) return parts;
  const total = Number(work.total_tokens) || ((Number(work.input_tokens) || 0) + (Number(work.output_tokens) || 0));
  if (total) parts.push(`${formatWorkTokens(total)} токенов`);
  const input = Number(work.input_tokens) || 0;
  if (input) parts.push(`вход ${formatWorkTokens(input)}`);
  const cached = Number(work.cached_input_tokens) || 0;
  if (cached) parts.push(`кэш ${formatWorkTokens(cached)}`);
  const output = Number(work.output_tokens) || 0;
  if (output) parts.push(`выход ${formatWorkTokens(output)}`);
  const thinking = Number(work.thinking_tokens) || 0;
  if (thinking && !total) parts.push(`${formatWorkTokens(thinking)} токенов размышления`);
  else if (thinking) parts.push(`размышление ${formatWorkTokens(thinking)}`);
  const seconds = Math.round((Number(work.duration_ms) || 0) / 1000);
  if (seconds) parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`);
  if (work.resumed) parts.push("продолжение чата");
  return parts;
}

/** Заголовок цепочки: крупно — что агент делал, мелко рядом — шаги, время и токены. */
function ChainTitle({ steps, work }: { steps: ChainStep[]; work?: LogLine["work"] }) {
  const tools = steps.filter((step) => step.kind === "tool").length;
  const digest = stepsDigest(steps);
  const stats = workParts(work);
  return (
    <p className="console-chain-title">
      <strong>{digest || "Ход работы"}</strong>
      <span title={stats.join(" · ") || undefined}>
        {tools} {plural(tools, "шаг", "шага", "шагов")}{stats.length ? ` · ${stats.join(" · ")}` : ""}
      </span>
    </p>
  );
}

function formatWorkTokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(".", ",")}k` : String(count);
}

/** Квота провайдера словами: сколько ждать и что делать. Тот же смысл, что describeRateLimit на сервере. */
function rateLimitText(info: NonNullable<LogLine["rateLimit"]>) {
  // У Claude лимит не провайдерский, а подписочный: важно не «сколько ждать», а сколько окна съедено.
  if (info.provider === "claude") {
    const used = Number(info.used_percent) || 0;
    const hours = Math.round((Number(info.wait_seconds) || 0) / 3600);
    const when = hours >= 24 ? `обновится через ${Math.round(hours / 24)} сут` : hours ? `обновится через ${hours} ч` : "";
    return `Лимит подписки Claude Code: израсходовано ${used}%${info.detail ? ` (${info.detail})` : ""}${when ? `, ${when}` : ""}.`;
  }
  const where = `${info.provider === "gemini" ? "Gemini" : "Groq"}${info.model ? ` · ${info.model}` : ""}`;
  const wait = !info.wait_seconds
    ? "когда освободится — провайдер не сообщил"
    : info.wait_seconds >= 3600
      ? `освободится примерно через ${Math.round(info.wait_seconds / 3600)} ч`
      : info.wait_seconds >= 60
        ? `освободится примерно через ${Math.ceil(info.wait_seconds / 60)} мин`
        : `освободится через ${info.wait_seconds} с`;
  return `Лимит модели ${where}: ${wait}. Можно подождать или выбрать другую модель рядом с полем ввода.`;
}

type LogLine = {
  id: string;
  kind: "in" | "out" | "sys" | "cmd";
  actor: string;
  text: string;
  renderedText?: ReactNode;
  at: string;
  pending?: "sending" | "sent" | "failed";
  toolsUsed?: string[];
  trace?: string[];
  /** Выжимка размышления модели перед ответом — показываем, сколько отдал провайдер. */
  reasoning?: string[];
  /** Чем отвечено: модель и «усилие». */
  model?: string;
  effort?: string;
  /** Упёрлись в квоту провайдера — отдельная заметная плашка, а не строчка в тексте. */
  rateLimit?: { provider?: string; model?: string; wait_seconds?: number; detail?: string; used_percent?: number };
  /** Сколько стоила работа: размышление, время, деньги. У Claude это всё, что отдаёт его CLI. */
  // Стоимости здесь намеренно нет: Claude отвечает по подписке, а доллары из CLI считаются по
  // тарифам API — цифра выглядела бы как счёт, которого человек не платит.
  work?: {
    thinking_tokens?: number;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
    duration_ms?: number;
    turns?: number;
    /** Ответ продолжил сессию агента в этом чате — история шла из кеша, а не заново. */
    resumed?: boolean;
    /** Размер контекста сессии после ответа и окно модели — индикатор нагрузки чата. */
    context_tokens?: number;
    context_window?: number;
  };
  /** Ответ не получился: наблюдатель агента упал. Видно сразу, а не только в логе. */
  failed?: boolean;
  /** Цепочка работы: шаги с аргументами и результатами (props.steps у локальных агентов). */
  steps?: ChainStep[];
  highlights?: string[];
  actions?: MessageAction[];
  postBuilder?: PostPart[];
  /** id записи инбокса — есть только у настоящих сообщений, на них можно ответить. */
  inboxId?: string;
  replyTo?: ReplyTarget;
  attachments?: Attachment[];
};

type ReplyTarget = { id: string; actor: string; text: string };

/** Вложение сообщения: файл в S3 MBOX. В props.attachments — для интерфейса, в тексте — ссылками для агентов. */
type Attachment = { name: string; key: string; size: number; type: string };
type DraftAttachment = Attachment & { id: string; loaded: number; error?: string; done?: boolean };

const ATTACHMENTS_MARK = "Вложения:";

function parseAttachments(raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({ name: String(item.name ?? ""), key: String(item.key ?? ""), size: Number(item.size) || 0, type: String(item.type ?? "") }))
    .filter((item) => item.name && item.key);
  return list.length ? list : undefined;
}

/** Текст сообщения без приписанного списка вложений: в чате они показываются карточками. */
function withoutAttachmentList(text: string) {
  const index = text.lastIndexOf(`\n\n${ATTACHMENTS_MARK}\n`);
  if (index >= 0) return text.slice(0, index);
  return text.startsWith(`${ATTACHMENTS_MARK}\n`) ? "" : text;
}

function attachmentsBlock(list: Attachment[]) {
  return [ATTACHMENTS_MARK, ...list.map((file) => `- [${file.name}](${serverOrigin()}${storageFileUrl(file.key)}) · ${formatBytes(file.size)}`)].join("\n");
}

function AttachmentList({ files }: { files: Attachment[] }) {
  return (
    <span className="console-attachments">
      {files.map((file) => {
        const src = storageFileUrl(file.key);
        const href = `${serverOrigin()}${src}`;
        return file.type.startsWith("image/") ? (
          <a key={file.key} className="console-attachment is-image" href={href} target="_blank" rel="noreferrer" title={file.name}>
            <img src={src} alt={file.name} loading="lazy" />
          </a>
        ) : (
          <a key={file.key} className="console-attachment" href={href} target="_blank" rel="noreferrer" title="Открыть файл">
            <FileText size={14} /><span>{file.name}</span><em>{formatBytes(file.size)}</em>
          </a>
        );
      })}
    </span>
  );
}

/** props.actions — структурированный выбор (варианты поста, да/нет-развилки), которые todo #203
 * просил показывать кнопками, а не заставлять печатать текст вручную. Валидируем форму на входе:
 * агент может прислать что угодно в props, доверять чужому JSON нельзя. */
function parseActions(raw: unknown): MessageAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter((item): item is { label: unknown; value: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ label: String((item as { label?: unknown }).label ?? ""), value: String((item as { value?: unknown }).value ?? "") }))
    .filter((item) => item.label && item.value);
  return actions.length ? actions : undefined;
}

export type PostPart = { key: string; label: string; options: string[] };

/** props.post_builder — черновик поста по частям (заголовок/тело/CTA и т.п.), у каждой части
 * несколько вариантов, собираются в консоли свайпом карточек, не выбором одного целого варианта.
 * Часть скилла "Обучение на контенте": владелец должен собрать свой идеал из кусков, а не просто
 * выбрать А/Б/В целиком. */
function parsePostBuilder(raw: unknown): PostPart[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parts = (raw as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const result = parts
    .filter((p): p is { key: unknown; label: unknown; options: unknown } => typeof p === "object" && p !== null)
    .map((p) => ({
      key: String((p as { key?: unknown }).key ?? ""),
      label: String((p as { label?: unknown }).label ?? ""),
      options: Array.isArray((p as { options?: unknown }).options) ? (p as { options: unknown[] }).options.map((o) => String(o)).filter(Boolean) : [],
    }))
    .filter((p) => p.key && p.label && p.options.length > 0);
  return result.length ? result : undefined;
}

/**
 * Чат — настоящая консоль, не мессенджер: моноширинный лог строк вместо пузырей, слэш-команды
 * работают локально (без похода в MCP-очередь), обычный текст уходит агентам как раньше.
 *
 * Про скорость честно: постоянного соединения у агента нет. Но MCP-сервер прицепляет
 * непрочитанные сообщения человека к ответу ЛЮБОГО вызова инструмента, поэтому агент видит
 * написанное на первом же своём действии — и теперь не теряет его, пока реально не ответит
 * (см. pendingMessages в scripts/mbox-mcp-server.mjs).
 */
const SWIPE_THRESHOLD_PX = 60;

/**
 * Одна часть поста (заголовок/тело/CTA/...) — карточка с несколькими вариантами, листается свайпом
 * (pointer drag) или стрелками. Отдельная карточка на часть, не общий выбор "весь пост целиком":
 * скилл "Обучение на контенте" собирает идеал из кусков, а не заставляет брать готовый вариант.
 */
function PostPartCard({ part, index, onChange, onReject, onRate }: {
  part: PostPart; index: number; onChange: (index: number) => void; onReject: (comment: string) => void; onRate: (score: number) => void;
}) {
  const dragStartX = useRef<number | null>(null);
  const dragStartY = useRef<number | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState<number | null>(null);

  function submitRate(score: number) {
    setRated(score);
    onRate(score);
  }

  function submitReject() {
    onReject(comment.trim());
    setComment("");
    setRejecting(false);
  }

  // Оценка привязана к КОНКРЕТНОМУ показанному варианту — при листании на другой вариант
  // прежняя оценка больше не про него, сбрасываем, иначе цифра врёт про новый текст.
  useEffect(() => { setRated(null); }, [index]);

  function go(delta: number) {
    const next = (index + delta + part.options.length) % part.options.length;
    onChange(next);
  }

  function onPointerDown(event: ReactPointerEvent) {
    dragStartX.current = event.clientX;
    dragStartY.current = event.clientY;
    // Не захватываем указатель сразу — иначе браузер не может выделить текст обычным
    // click+drag, любое касание текста читалось бы как начало свайпа. Ловим курсор только
    // когда движение реально горизонтальное (см. onPointerMove) — до этого момента это
    // обычное выделение текста, браузер обрабатывает его сам.
  }
  function onPointerMove(event: ReactPointerEvent) {
    if (dragStartX.current === null || dragStartY.current === null) return;
    const dx = event.clientX - dragStartX.current;
    const dy = event.clientY - dragStartY.current;
    if (!swiping && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      if (Math.abs(dx) <= Math.abs(dy)) { dragStartX.current = null; dragStartY.current = null; return; } // вертикальное/диагональное — это выделение, отдаём браузеру
      setSwiping(true);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    if (swiping) setDragDx(dx);
  }
  function onPointerUp() {
    if (swiping) {
      if (dragDx > SWIPE_THRESHOLD_PX) go(-1);
      else if (dragDx < -SWIPE_THRESHOLD_PX) go(1);
    }
    dragStartX.current = null;
    dragStartY.current = null;
    setSwiping(false);
    setDragDx(0);
  }

  // Заголовок — это то, что реально решает, откроют ли пост; в листалке он тонул в том же
  // размере шрифта, что и тело. key/label проверяем оба — агент может прислать "title" или
  // человекочитаемое "Заголовок", один из них обычно совпадает.
  const isTitle = part.key.toLowerCase() === "title" || part.label.toLowerCase().includes("заголов");

  return (
    <div className="post-part-card">
      <div className="post-part-head">
        <span className="post-part-label">{part.label}</span>
        <span className="post-part-count">{index + 1}/{part.options.length}</span>
      </div>
      <div
        className={`post-part-swipe${isTitle ? " is-title" : ""}`}
        style={{ transform: dragDx ? `translateX(${dragDx}px)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {renderMarkdownLite(part.options[index] ?? "")}
      </div>
      <div className="post-part-nav">
        <button type="button" onClick={() => go(-1)} aria-label={`${part.label}: предыдущий вариант`}>‹</button>
        <span className="post-part-dots">
          {part.options.map((_, i) => <i key={i} className={i === index ? "is-active" : ""} />)}
        </span>
        <button type="button" onClick={() => go(1)} aria-label={`${part.label}: следующий вариант`}>›</button>
        <button type="button" className="post-part-reject-toggle" onClick={() => setRejecting((v) => !v)}>
          ✕ отклонить
        </button>
      </div>
      <div className="post-part-rating">
        <span className="post-part-rating-label">оценка:</span>
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            className={rated !== null && score <= rated ? "is-rated" : ""}
            onClick={() => submitRate(score)}
            aria-label={`Оценить «${part.label}» на ${score} из 5`}
          >
            {rated !== null && score <= rated ? "★" : "☆"}
          </button>
        ))}
      </div>
      {rejecting && (
        <div className="post-part-reject">
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={`Что не так с частью «${part.label}»?`}
            rows={2}
            autoFocus
          />
          <button type="button" onClick={submitReject}>Отклонить</button>
        </div>
      )}
    </div>
  );
}

/**
 * Сборка целого поста из выбранных частей + критика с "переделать". "Готово" отправляет собранный
 * текст обычным сообщением (тем же путём, что и клик по кнопке варианта) — дальше с ним работает
 * тот, кто отвечает в этом чате (обычно Claude, скилл рассчитан на старшую модель).
 */
function PostBuilderCard({ parts, onSend }: { parts: PostPart[]; onSend: (text: string) => void }) {
  const [selected, setSelected] = useState<number[]>(() => parts.map(() => 0));
  const [critique, setCritique] = useState("");

  function assembled() {
    return parts.map((part, i) => `${part.label}: ${part.options[selected[i]] ?? ""}`).join("\n\n");
  }

  function setPart(partIndex: number, optionIndex: number) {
    setSelected((current) => current.map((v, i) => (i === partIndex ? optionIndex : v)));
  }

  return (
    <div className="post-builder">
      {parts.map((part, i) => (
        <PostPartCard
          key={part.key}
          part={part}
          index={selected[i]}
          onChange={(next) => setPart(i, next)}
          onReject={(comment) => onSend(`Отклонить часть «${part.label}»${comment ? `: ${comment}` : " (без комментария)"}`)}
          // Явный адресат @Claude — иначе непомеченное сообщение подхватывает и Джарвис
          // (см. respondToRequests в mbox-archivist.mjs), и звёздочка-клик триггерит его ответ
          // почём зря. Рейтинг — сигнал для Claude, не вопрос, требующий чьей-то реакции.
          onRate={(score) => onSend(`@Claude Оценка части «${part.label}» (вариант ${selected[i] + 1}/${part.options.length}): ${score}/5`)}
        />
      ))}
      <div className="post-builder-actions">
        <button type="button" className="post-builder-done" onClick={() => onSend(`Собрал финальный вариант:\n\n${assembled()}`)}>
          ✓ Готово
        </button>
      </div>
      <div className="post-builder-critique">
        <textarea
          value={critique}
          onChange={(event) => setCritique(event.target.value)}
          placeholder="Что переделать? (необязательно — можно просто нажать «Готово» на подходящем)"
          rows={2}
        />
        <button
          type="button"
          className="post-builder-redo"
          disabled={!critique.trim()}
          onClick={() => { onSend(`Переделай: ${critique.trim()}`); setCritique(""); }}
        >
          ↻ Переделать
        </button>
      </div>
    </div>
  );
}

export function AgentChat({ inbox, agents, runs, projects, artifacts, projectId, currentProjectName, onSaved, embedded = false, visible = false, peer = "", debug, jarvisEnabled = true, defaultResponder = JARVIS_NAME, focus = [] }: {
  inbox: AgentInboxItem[];
  agents: AgentActivity[];
  runs: AgentRun[];
  projects: Project[];
  artifacts: Artifact[];
  projectId?: string;
  currentProjectName?: string;
  onSaved: (entity?: string) => void;
  /** Встроена в нижнюю панель рабочего места: без своей кнопки, пристыковки и ресайза. */
  embedded?: boolean;
  visible?: boolean;
  /** Чат с одним агентом: видна только переписка с ним, сообщения уходят ему без @. Пусто — общий чат. */
  peer?: string;
  /** Режим отладки: вывод процесса агента, спрятанный за кнопкой в шапке чата. */
  debug?: ChatDebug;
  /** Джарвис включён у аккаунта (у участника — по решению владельца). */
  jarvisEnabled?: boolean;
  /** Кто отвечает в общем чате без @: Джарвис или облачный Claude (JARVIS_AUTOREPLY=off на сервере). */
  defaultResponder?: string;
  /** Открытое сейчас в рабочем месте — чипы над полем ввода, уходят агенту в props.context. */
  focus?: FocusItem[];
}) {
  const [openState, setOpen] = useState(false);
  const open = embedded ? visible : openState;
  const effectiveProjectId = projectId || projects[0]?.id || "";
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(scopedStorageKey("mbox.console.width")));
    return stored > 0 ? stored : Math.round(window.innerWidth / 3);
  });
  const resizingRef = useRef(false);
  // У каждого разговора свой черновик: недописанное Claude не должно всплыть в чате с Codex.
  const [text, setText] = useDraft(peer ? `chat:input:${peer}` : "chat:input", "");
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  // Чем отвечать: модель и «усилие» размышления. Пусто — как было, решает сервер (см. jarvisModels).
  // У каждого вида чата свой выбор: gpt-6-luna, выбранная для ChatGPT, однажды ушла к Claude.
  const [model, setModel] = usePersistentState(`mbox.chat.model:${peer || "common"}`, "");
  const [effort, setEffort] = usePersistentState(`mbox.chat.effort:${peer || "common"}`, "");
  const [threadsAside, setThreadsAside] = usePersistentState("mbox.chat.threadsAside", false);
  // Отжатые чипы фокуса — по ключу вкладки: снова открытая вкладка остаётся отжатой, пока её не включат.
  const [mutedFocus, setMutedFocus] = useState<string[]>([]);
  const sharedFocus = focus.filter((item) => !mutedFocus.includes(item.key));
  const [catalog, setCatalog] = useState<JarvisCatalog>({ models: [], efforts: [], effortLabels: {}, defaultModel: "", defaults: {}, defaultEffort: "" });
  // Текущий чат у каждого собеседника свой; пусто — старый общий чат без thread.
  const [thread, setThread] = usePersistentState(peer ? `mbox.chat.thread:${peer}` : "mbox.chat.thread", "");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadMenu, setThreadMenu] = useState(false);
  // Выбор «локальный / в облаке» у кнопки «Новый чат» — только когда облачный агент на связи.
  const [newChatMenu, setNewChatMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Сообщения выбранного чата, которых нет среди 200 последних в общем inbox (старый чат).
  const [threadInbox, setThreadInbox] = useState<AgentInboxItem[]>([]);
  useEffect(() => {
    let alive = true;
    // Каталог публикуют наблюдатели при старте — перечитываем при возврате в окно и раз в 5 минут,
    // иначе чат, открытый раньше публикации, так и показывал бы запасной список.
    const load = () => fetchJson<Partial<JarvisCatalog> & { default_model?: string; default_effort?: string; effort_labels?: JarvisCatalog["effortLabels"] }>("/api/mbox/agent/models")
      .then((data) => { if (alive) setCatalog({ models: data.models || [], efforts: data.efforts || [], effortLabels: data.effort_labels || {}, defaultModel: data.default_model || "", defaults: data.defaults || {}, defaultEffort: data.default_effort || "" }); })
      .catch(() => { /* старый сервер без этой ручки — просто нет выбора, как раньше */ });
    void load();
    const timer = window.setInterval(load, 5 * 60_000);
    window.addEventListener("focus", load);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, []);
  const [cursor, setCursor] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [history, setHistory] = usePersistentState<string[]>("mbox.chat.history", []);
  const [historyPos, setHistoryPos] = useState(-1);
  const [localLines, setLocalLines] = useState<LogLine[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; body: string; at: string; inboxId?: string; sent?: boolean; failed?: boolean; attachments?: Attachment[] }>>([]);
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [dragFiles, setDragFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingFiles = drafts.some((file) => !file.done && !file.error);
  const readyFiles = drafts.filter((file) => file.done);
  const [awaitingJarvisId, setAwaitingJarvisId] = useState<string | null>(null);
  const [awaitingJarvisSince, setAwaitingJarvisSince] = useState<number | null>(null);
  const [awaitingJarvisPhase, setAwaitingJarvisPhase] = useState<string | null>(null);
  const [awaitingJarvisVerb, setAwaitingJarvisVerb] = useState("думает");
  // Кого ждём. Раньше плашка «думает» была только у Джарвиса, и работа Claude шла совершенно молча:
  // фаза уходила в нижнюю панель, а в самой переписке не появлялось ничего.
  const [awaitingAgent, setAwaitingAgent] = useState(defaultResponder);
  /**
   * Цепочка, которая растёт прямо во время работы: шаги приезжают по сокету отдельными событиями
   * (agent_step), в базе их нет. Ключ — номер шага: результат инструмента приходит вторым событием
   * и догоняет свой вызов. Когда придёт готовый ответ, у него будет своя полная цепочка в props,
   * а эта, живая, станет не нужна.
   */
  const [liveSteps, setLiveSteps] = useState<ChainStep[]>([]);
  // Значение не читается — сам факт смены форсирует re-render, чтобы Date.now() в
  // awaitingJarvisSeconds ниже пересчитывался каждую секунду.
  const [, setElapsedTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // В консоли шапка чата уезжает в строку «Общий · Claude · ChatGPT» (одна строка хрома вместо двух).
  const headSlot = useContext(ChatHeadSlot);
  const placeThreads = (node: ReactNode) => (headSlot ? createPortal(node, headSlot) : node);
  const lastComposerHeightRef = useRef(0);
  const liveMention = parseMention(text);
  // Собеседник текущего чата: во вкладке агента чат локальный (Claude на этом компьютере) или облачный.
  const cloudPeer = cloudPeerOf(peer);
  const cloudOnline = Boolean(cloudPeer && agents.some((agent) => agent.name === cloudPeer && effectiveStatus(agent) === "active"));
  const threadPeer = threads.find((item) => item.id === thread)?.peer || "";
  const cloudChat = Boolean(cloudPeer && isCloudAgent(threadPeer));
  const chatTarget = cloudChat ? cloudPeer : peer;
  // Модели у агентов разные: у Джарвиса это Gemini/Groq на сервере, у Claude — алиасы его CLI на
  // машине владельца. Показываем набор того, кому сейчас пишут; адресат не выбран — все подряд.
  const target = (liveMention || chatTarget || defaultResponder).toLowerCase();
  const addressee = catalog.models.some((item) => (item.agent || "").toLowerCase() === target) ? target : catalogAgent(target);
  const shownModels = catalog.models.filter((item) => {
    const agent = (item.agent || "").toLowerCase();
    return agent === addressee || (addressee === "chatgpt" && agent === "codex") || (addressee === "codex" && agent === "chatgpt");
  });
  const modelAllowed = !model || shownModels.some((item) => item.id === model);
  const effectiveModel = modelAllowed ? model : "";
  // undefined — сервер не прислал defaults (Джарвис или старый сервер); "" — «как настроено в CLI агента».
  const agentDefault = Object.entries(catalog.defaults).find(([agent]) => agent.toLowerCase() === (addressee === "codex" ? "chatgpt" : addressee))?.[1];
  const shownDefaultModel = agentDefault !== undefined
    ? (shownModels.some((item) => item.id === agentDefault) ? agentDefault : "")
    : ([catalog.defaultModel].find((id) => id && shownModels.some((item) => item.id === id)) || shownModels[0]?.id || "");
  const defaultModelLabel = shownModels.find((item) => item.id === shownDefaultModel)?.label || (agentDefault === "" ? "Как в CLI" : shownModels[0]?.label || "по умолчанию");
  // Уровни effort — у выбранной модели свои (у Codex есть «ultra», у Haiku их нет вовсе); у Джарвиса — общие три.
  const activeModel = shownModels.find((item) => item.id === (effectiveModel || shownDefaultModel));
  // Модель не выбрана и CLI решает сам — показываем только уровни, которые есть у всех его моделей.
  const commonEfforts = shownModels.every((item) => item.efforts)
    ? shownModels.reduce<string[] | null>((acc, item) => (acc ? acc.filter((id) => item.efforts!.includes(id)) : [...item.efforts!]), null)
    : null;
  const effortIds = activeModel?.efforts ?? (shownModels.length && !activeModel ? commonEfforts : null);
  const shownEfforts = effortIds
    ? effortIds.map((id) => ({ id, label: catalog.effortLabels[id]?.label || id, hint: catalog.effortLabels[id]?.hint || "" }))
    : catalog.efforts;
  const shownDefaultEffort = effortIds ? (activeModel?.default_effort || "") : catalog.defaultEffort;
  const effectiveEffort = effort && shownEfforts.some((item) => item.id === effort) ? effort : "";
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    window.requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, []);

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    // Measure from a neutral height, otherwise Chromium can accumulate a few px
    // when the picker/recipient row changes width and text wraps differently.
    el.style.height = "0px";
    const next = Math.min(Math.max(el.scrollHeight, 24), 220);
    if (next !== lastComposerHeightRef.current) {
      el.style.height = `${next}px`;
      lastComposerHeightRef.current = next;
    } else {
      el.style.height = `${next}px`;
    }
  }, []);

  // field-sizing: content is not available everywhere, so textarea growth is manual.
  useLayoutEffect(() => {
    resizeComposer();
  }, [text, liveMention, peer, replyTo, drafts.length, shownModels.length, resizeComposer]);

  useLayoutEffect(() => {
    const el = composerRef.current;
    const parent = el?.parentElement;
    if (!el || !parent || typeof ResizeObserver === "undefined") return;
    let lastWidth = parent.getBoundingClientRect().width;
    const resize = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? parent.getBoundingClientRect().width;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      resizeComposer();
    });
    resize.observe(parent);
    return () => resize.disconnect();
  }, [resizeComposer]);

  // Подсказки по вводу: @агент, /команда, $проект, #артефакт — набор символов, о котором просили
  // не тратить контекст на постоянное "MBOX"/"Джарвис" целиком, а выбирать мышью/стрелками.
  const token = activeToken(text, cursor);
  const tokenKey = token ? `${token.trigger}:${token.start}` : null;
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token || tokenKey === dismissedKey) return [];
    const q = token.query.toLowerCase();
    if (token.trigger === "@") {
      return agents.map((a) => ({ value: a.name, hint: agentState(a, runs).label })).filter((s) => s.value.toLowerCase().includes(q));
    }
    if (token.trigger === "/") {
      return SLASH_COMMANDS.filter((c) => c.value.startsWith(q));
    }
    if (token.trigger === "$") {
      return projects.map((p) => ({ value: p.name, hint: "проект" })).filter((s) => s.value.toLowerCase().includes(q));
    }
    if (token.trigger === "#") {
      return artifacts.map((a) => ({ value: a.name, hint: "артефакт" })).filter((s) => s.value.toLowerCase().includes(q)).slice(0, 20);
    }
    return [];
  }, [token, tokenKey, dismissedKey, agents, runs, projects, artifacts]);

  useEffect(() => { setHighlight(0); }, [tokenKey]);

  function acceptSuggestion(value: string) {
    if (!token) return;
    const before = text.slice(0, token.start);
    const after = text.slice(cursor);
    const insert = `${token.trigger}${value} `;
    setText(`${before}${insert}${after}`);
    const nextCursor = before.length + insert.length;
    setCursor(nextCursor);
    setDismissedKey(null);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) { el.focus(); el.setSelectionRange(nextCursor, nextCursor); }
    });
  }

  const inboxVersion = inbox.reduce((latest, item) => (item.updated_at > latest ? item.updated_at : latest), "");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchJson<{ threads: ChatThread[] }>("/api/mbox/agent/threads")
      .then((data) => { if (alive) setThreads(data.threads || []); })
      .catch(() => { /* старый сервер без чатов — остаётся общий */ });
    return () => { alive = false; };
  }, [open, inboxVersion]);
  useEffect(() => {
    if (!thread || !open) { setThreadInbox([]); return; }
    let alive = true;
    fetchJson<{ inbox: AgentInboxItem[] }>(`/api/mbox/agent/inbox?thread=${encodeURIComponent(thread)}&limit=200`)
      .then((data) => { if (alive) setThreadInbox(data.inbox || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [thread, open, inboxVersion]);
  const shownThreads = useMemo(() => threads.filter((item) => threadMatchesPeer(item, peer)), [threads, peer]);
  const currentThread = threads.find((item) => item.id === thread);
  const conversation = useMemo(() => {
    const byId = new Map<string, AgentInboxItem>();
    for (const item of [...threadInbox, ...inbox]) byId.set(String(item.id), item);
    const all = [...byId.values()].filter((item) => CONVERSATION.has(item.item_type) && (!peer || belongsToPeer(item, peer)));
    // Ответ агента, который ещё не знает про чаты (старая версия наблюдателя), приходит без метки —
    // но он отвечает на сообщение из этого чата, значит, и показывать его надо здесь.
    const own = new Set(all.filter((item) => threadOfItem(item) === thread).map((item) => String(item.id)));
    return all
      .filter((item) => threadOfItem(item) === thread || (thread !== "" && !threadOfItem(item) && own.has(repliedId(item))))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-CHAT_HISTORY_LIMIT);
  }, [inbox, threadInbox, peer, thread]);
  const refreshThreads = useCallback(() => {
    fetchJson<{ threads: ChatThread[] }>("/api/mbox/agent/threads").then((data) => setThreads(data.threads || [])).catch(() => {});
  }, []);
  const switchThread = useCallback((id: string) => {
    setThread(id);
    setThreadMenu(false);
    setRenaming(null);
    setLocalLines([]);
    setReplyTo(null);
  }, [setThread]);
  // Чат сохраняется на сервере сразу — он есть в списке до первого сообщения и на любом устройстве.
  const startNewChat = useCallback((scope: "local" | "cloud" = "local") => {
    const id = newThreadId();
    const owner = scope === "cloud" && cloudPeer ? cloudPeer : peer;
    setNewChatMenu(false);
    setThreads((current) => [{ id, title: "Новый чат", last_at: new Date().toISOString(), messages: 0, peer: owner || null, last_agent: null }, ...current]);
    switchThread(id);
    fetchJson("/api/mbox/agent/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, peer: owner }) })
      .then(refreshThreads)
      .catch(() => {});
  }, [peer, cloudPeer, refreshThreads, switchThread]);
  const renameThread = useCallback((id: string, title: string) => {
    setRenaming(null);
    const clean = title.trim();
    if (!clean) return;
    setThreads((current) => current.map((item) => item.id === id ? { ...item, title: clean, custom_title: true } : item));
    fetchJson(`/api/mbox/agent/threads/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: clean }) })
      .then(refreshThreads)
      .catch(() => {});
  }, [refreshThreads]);
  const archiveThread = useCallback((id: string) => {
    setThreads((current) => current.filter((item) => item.id !== id));
    if (id === thread) switchThread("");
    fetchJson(`/api/mbox/agent/threads/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) })
      .then(refreshThreads)
      .catch(() => {});
  }, [thread, refreshThreads, switchThread]);
  // Нагрузка контекста: последний ответ агента, у которого наблюдатель знает размер сессии.
  const contextLoad = useMemo<ContextLoad | null>(() => {
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      const work = conversation[index].props?.work as LogLine["work"] | undefined;
      const tokens = Number(work?.context_tokens) || 0;
      if (tokens) return { tokens, window: Number(work?.context_window) || 0, agent: conversation[index].agent_name };
    }
    return null;
  }, [conversation]);
  const contextShare = contextLoad?.window ? contextLoad.tokens / contextLoad.window : 0;
  const inboxById = useMemo(() => new Map(inbox.map((item) => [String(item.id), item])), [inbox]);

  const arrived = useMemo(() => new Set(conversation.map((item) => (item.body || item.title).trim())), [conversation]);
  const arrivedIds = useMemo(() => new Set(conversation.map((item) => String(item.id))), [conversation]);
  const stillPending = pending.filter((item) => item.failed || !(item.inboxId ? arrivedIds.has(item.inboxId) : arrived.has(item.body.trim())));

  // "Ответ приходит резко" — раньше не было вообще никакого признака, что Джарвис работает над
  // ответом (в отличие от "печатает" у сессионных агентов ниже, у него нет agent_runs). Плашка
  // "думает" висит с момента отправки до прихода ответа с props.re на этот же item, либо гаснет
  // по таймауту, если инлайн-путь не сработал и подхватил резервный cron (тогда ответ просто придёт
  // самостоятельным сообщением позже).
  useEffect(() => {
    if (!awaitingJarvisId) return;
    const answered = conversation.some((item) =>
      item.agent_name.toLowerCase() === awaitingAgent.toLowerCase()
      && [String(item.props?.re ?? ""), String(item.props?.in_reply_to ?? "")].includes(awaitingJarvisId));
    if (answered) {
      setAwaitingJarvisId(null);
      setAwaitingJarvisSince(null);
      setAwaitingJarvisPhase(null);
      return;
    }
    // Джарвис отвечает секунды, и если инлайн-путь не сработал, плашку надо снять быстро. Claude
    // через Claude Code работает минутами — обрывать его на 25-й секунде значило бы врать, что он
    // не работает, ровно тогда, когда он работает.
    const isJarvis = awaitingAgent.toLowerCase() === JARVIS_NAME.toLowerCase();
    const timeout = window.setTimeout(() => { setAwaitingJarvisId(null); setAwaitingJarvisSince(null); setAwaitingJarvisPhase(null); }, isJarvis ? 25000 : 20 * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [awaitingJarvisId, awaitingAgent, conversation]);

  // Раньше "думает…" висело одним и тем же текстом весь ответ — жалоба: непонятно, застрял агент
  // или реально работает. Опрашиваем ту же фазу, что сервер пишет в jarvisPhase (см. server/vite).
  useEffect(() => {
    if (!awaitingJarvisId) { setAwaitingJarvisPhase(null); return; }
    // Фаза Джарвиса привязана к сообщению (он отвечает внутри сервера), фаза локального агента —
    // к нему самому: наблюдатель шлёт её через POST /agent/ping, и она приезжает в списке агентов.
    if (awaitingAgent.toLowerCase() !== JARVIS_NAME.toLowerCase()) return;
    let cancelled = false;
    const poll = () => {
      fetchJson<{ phase: string | null }>(`/api/mbox/agent/inbox/${awaitingJarvisId}/phase`)
        .then((data) => { if (!cancelled) setAwaitingJarvisPhase(data.phase); })
        .catch(() => {});
    };
    poll();
    const interval = window.setInterval(poll, 1500);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [awaitingJarvisId, awaitingAgent]);

  useEffect(() => {
    if (!awaitingJarvisId) { setLiveSteps([]); return; }
    const listener = (event: Event) => {
      const payload = (event as CustomEvent<{ inbox_id?: string; step?: ChainStep & { i?: number } }>).detail;
      if (!payload?.step || String(payload.inbox_id || "") !== awaitingJarvisId) return;
      const { i = 0, ...patch } = payload.step;
      setLiveSteps((current) => {
        const next = [...current];
        while (next.length <= i) next.push({ kind: "tool" });
        next[i] = { ...next[i], ...patch };
        return next;
      });
    };
    window.addEventListener(AGENT_STEP_EVENT, listener);
    return () => window.removeEventListener(AGENT_STEP_EVENT, listener);
  }, [awaitingJarvisId]);

  // «Работает» — только когда агент правда работает: есть живой запуск или фаза от наблюдателя.
  // Раньше плашка писала «ChatGPT: работает… 80с», пока наблюдатель был мёртв или вне окна.
  const awaitingDead = Boolean(peer && (cloudChat ? !cloudOnline : debug?.process?.state === "dead") && awaitingAgent.toLowerCase() !== JARVIS_NAME.toLowerCase());
  const awaitingPhase = useMemo(() => {
    if (awaitingAgent.toLowerCase() === JARVIS_NAME.toLowerCase()) return awaitingJarvisPhase;
    const family = (name: string) => (/^(codex|chatgpt)$/i.test(name) ? "chatgpt" : name.toLowerCase());
    const row = agents.find((agent) => family(agent.name) === family(awaitingAgent));
    // Шаги по сокету — самый прямой признак работы: Codex не шлёт ни фазу, ни запуск, а цепочка идёт.
    const lastStep = liveSteps[liveSteps.length - 1];
    if (lastStep) return lastStep.kind === "text" ? "пишет ответ" : `${describeStep(lastStep).label.toLowerCase()}${liveSteps.length > 1 ? ` · шаг ${liveSteps.length}` : ""}`;
    if (row?.phase) return row.phase;
    if (!row) return "не на связи — сообщение ждёт, пока запустится наблюдатель";
    const state = agentState(row, runs);
    if (state.key === "working") return row.phase || state.label || "работает";
    if (state.key === "offline") return "не на связи — сообщение ждёт, пока запустится наблюдатель";
    return "в очереди, ещё не начал";
  }, [awaitingAgent, awaitingJarvisPhase, agents, runs, liveSteps]);

  // Секунды в "думает…" — раньше плашка просто висела без обратной связи, сколько ещё ждать.
  useEffect(() => {
    if (!awaitingJarvisSince) return;
    const interval = window.setInterval(() => setElapsedTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [awaitingJarvisSince]);

  // Пока не пришла настоящая фаза с сервера, плашка сама по себе выглядела застывшей — один и
  // тот же случайный глагол висел весь цикл ожидания. Перебираем каждые 2с, реальная фаза
  // (awaitingJarvisPhase) всё равно перебивает это в рендере, когда она известна.
  useEffect(() => {
    if (!awaitingJarvisSince) return;
    const interval = window.setInterval(() => setAwaitingJarvisVerb((current) => randomThinkingVerb(current)), 2000);
    return () => window.clearInterval(interval);
  }, [awaitingJarvisSince]);

  const awaitingJarvisSeconds = awaitingJarvisSince ? Math.max(0, Math.floor((Date.now() - awaitingJarvisSince) / 1000)) : 0;

  const cancelJarvis = useCallback(() => {
    if (!awaitingJarvisId) return;
    const id = awaitingJarvisId;
    setAwaitingJarvisId(null);
    setAwaitingJarvisSince(null);
    setAwaitingJarvisPhase(null);
    fetchJson(`/api/mbox/agent/inbox/${id}/cancel`, { method: "POST" }).catch(() => {});
  }, [awaitingJarvisId]);

  const states = useMemo(
    () => agents.filter((agent) => !peer || peerNames(peer).includes(agent.name.toLowerCase())).map((agent) => ({ agent, state: agentState(agent, runs) })),
    [agents, runs, peer],
  );
  // Плашки «Codex: отвечает» под лентой больше нет (todo #314): она держалась на живом запуске и
  // присутствии, а не на реальном ответе, и висела часами после того, как у агента кончился лимит,
  // выдавая протухший клейм за работу. Состав и занятость агентов и так видны в шапке консоли,
  // в пилюле хедера и в строке состояния. Ожидание Джарвиса ниже — другое дело: оно привязано
  // к конкретному отправленному сообщению и гаснет вместе с ответом.
  const working = states.filter((entry) => entry.state.key === "working");
  // "N агентов на связи: имена" — раньше жило в шапке страницы и дублировало этот же ростер под
  // другим текстом. Состав разговора — дело консоли, не глобальной шапки.
  const online = states.filter((entry) => entry.state.key !== "offline");
  const rosterSummary = online.length
    ? `${online.length} ${plural(online.length, "агент", "агента", "агентов")} на связи: ${online.map((entry) => entry.agent.name).join(", ")}`
    : "агентов нет на связи";

  const [readAt, setReadAt] = useState(() => {
    const stored = window.localStorage.getItem(scopedStorageKey(READ_KEY));
    if (stored) return stored;
    const now = new Date().toISOString();
    window.localStorage.setItem(scopedStorageKey(READ_KEY), now);
    return now;
  });

  const unreadItems = useMemo(
    () => conversation.filter((item) => item.agent_name !== HUMAN && item.created_at > readAt),
    [conversation, readAt],
  );
  const unread = unreadItems.length;

  useEffect(() => {
    if (!open || !unread) return;
    const last = unreadItems[unreadItems.length - 1].created_at;
    window.localStorage.setItem(scopedStorageKey(READ_KEY), last);
    setReadAt(last);
  }, [open, unread, unreadItems]);

  // Консоль на широком экране — не плавающий пузырь, а пристыкованная справа панель, которая
  // РЕАЛЬНО сдвигает контент (не перекрывает его): .workspace читает --console-width как
  // margin-right (см. chat.css, брейкпоинт ≥1201px — на более узких экранах поведение старое,
  // не трогаем уже выверенную мобильную раскладку). На уже открытых узких экранах переменная
  // просто не используется соответствующим медиа-запросом.
  useEffect(() => {
    if (embedded) return;
    document.documentElement.style.setProperty("--console-width", open ? `${panelWidth}px` : "0px");
    return () => { document.documentElement.style.setProperty("--console-width", "0px"); };
  }, [open, panelWidth, embedded]);

  function startResize(event: ReactMouseEvent) {
    event.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMove(moveEvent: MouseEvent) {
      if (!resizingRef.current) return;
      const next = Math.min(Math.max(window.innerWidth - moveEvent.clientX, 320), Math.round(window.innerWidth * 0.7));
      setPanelWidth(next);
    }
    function onUp() {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelWidth((current) => { window.localStorage.setItem(scopedStorageKey("mbox.console.width"), String(current)); return current; });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    if (!pending.length) return;
    setPending((current) => current.filter((item) => item.failed || !(item.inboxId ? arrivedIds.has(item.inboxId) : arrived.has(item.body.trim()))));
  }, [arrived, arrivedIds, pending.length]);

  // Единый лог: реальная переписка + оптимистичные отправки + локальные команды, всё по времени.
  const lines = useMemo<LogLine[]>(() => {
    const fromConversation: LogLine[] = conversation.map((item) => ({
      id: `msg-${item.id}`,
      kind: item.agent_name === HUMAN ? "out" : "in",
      actor: item.agent_name,
      text: parseAttachments(item.props?.attachments) ? withoutAttachmentList(item.body || item.title) : item.body || item.title,
      renderedText: renderMarkdownLite(parseAttachments(item.props?.attachments) ? withoutAttachmentList(item.body || item.title) : item.body || item.title),
      attachments: parseAttachments(item.props?.attachments),
      at: item.created_at,
      // Инструменты, реально вызванные при формировании ответа — бейджами под самим сообщением,
      // а не отдельной строкой лога, чтобы читалось как "приложено к", а не как что-то ещё.
      toolsUsed: Array.isArray(item.props?.tools_used)
        ? (item.props.tools_used as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      // Пошаговый трейс (что вызвано, с чем, что вернулось) — техническая деталь для проверки,
      // не для Джарвиса: это props, а не body, поэтому в его собственную историю не попадает
      // (см. комментарий в replyAsJarvis на сервере).
      trace: Array.isArray(item.props?.trace)
        ? (item.props.trace as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      // Ход мысли модели: Gemini отдаёт выжимку (includeThoughts), gpt-oss — поле reasoning.
      reasoning: Array.isArray(item.props?.reasoning)
        ? (item.props.reasoning as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
        : undefined,
      model: typeof item.props?.model === "string" ? item.props.model : undefined,
      effort: typeof item.props?.effort === "string" ? item.props.effort : undefined,
      rateLimit: item.props?.rate_limit && typeof item.props.rate_limit === "object"
        ? (item.props.rate_limit as LogLine["rateLimit"])
        : undefined,
      work: item.props?.work && typeof item.props.work === "object"
        ? (item.props.work as LogLine["work"])
        : undefined,
      steps: Array.isArray(item.props?.steps) ? (item.props.steps as ChainStep[]) : undefined,
      // Заметные действия (создано/удалено/объединено) — видны сразу, в отличие от trace выше.
      highlights: Array.isArray(item.props?.highlights)
        ? (item.props.highlights as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      actions: parseActions(item.props?.actions),
      postBuilder: parsePostBuilder(item.props?.post_builder),
      failed: item.item_type === "agent_error",
      inboxId: String(item.id),
      replyTo: (() => {
        const original = inboxById.get(repliedId(item));
        return original ? { id: String(original.id), actor: original.agent_name, text: original.body || original.title } : undefined;
      })(),
    }));
    const fromPending: LogLine[] = stillPending.map((item) => ({
      id: item.id,
      kind: "out",
      actor: "Ты",
      text: item.attachments ? withoutAttachmentList(item.body) : item.body,
      renderedText: renderMarkdownLite(item.attachments ? withoutAttachmentList(item.body) : item.body),
      attachments: item.attachments,
      at: item.at,
      pending: item.failed ? "failed" : item.sent ? "sent" : "sending",
      inboxId: item.inboxId,
    }));
    return [...fromConversation, ...fromPending, ...localLines].sort((a, b) => a.at.localeCompare(b.at));
  }, [conversation, stillPending, localLines, inboxById]);
  const visibleLines = useMemo(() => lines.slice(-CHAT_RENDER_LIMIT), [lines]);

  // Чат прилипает к низу, как в мессенджере. Прокрутка только на новое сообщение не спасала: если лог в
  // этот момент был скрыт (другая группа консоли, свёрнутая панель, неактивная вкладка), браузер её
  // игнорировал — и при переключении чатов человек оказывался в самом начале. Пока человек у нижнего
  // края, появление лога, смена размера и дорисовка содержимого (картинки, «думает…») держат низ;
  // отмотал вверх сам — не дёргаем, пока не вернётся вниз.
  const stickToBottomRef = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => { if (stickToBottomRef.current && el.clientHeight) el.scrollTop = el.scrollHeight; };
    const onScroll = () => {
      // У скрытого лога clientHeight 0 и scroll при сбросе — это не решение человека.
      if (!el.clientHeight) return;
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    const resize = new ResizeObserver(pin);
    resize.observe(el);
    const mutations = new MutationObserver(pin);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("load", pin, true);
    el.addEventListener("scroll", onScroll, { passive: true });
    pin();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      el.removeEventListener("load", pin, true);
      el.removeEventListener("scroll", onScroll);
    };
  }, [open]);

  // Новое сообщение или «агент думает» — вниз, даже если человек читал историю выше.
  useLayoutEffect(() => {
    if (!open) return;
    stickToBottomRef.current = true;
    scrollToBottom();
  }, [open, visibleLines.length, awaitingJarvisId, working.length, scrollToBottom]);

  function pushLocal(kind: "sys" | "cmd", text: string) {
    setLocalLines((current) => [...current, { id: `local-${Date.now()}-${Math.random()}`, kind, actor: kind === "cmd" ? "Ты" : "mbox", text, at: new Date().toISOString() }]);
  }

  /** Слэш-команды выполняются тут же, без похода в очередь агентов — быстрая справка и обзор. */
  function runCommand(raw: string) {
    const [cmd, ...rest] = raw.trim().slice(1).split(/\s+/);
    const arg = rest.join(" ");
    pushLocal("cmd", raw);

    switch (cmd) {
      case "help":
        pushLocal("sys", [
          "команды:",
          "  /status, /agents  — кто сейчас на связи",
          "  /blocked          — задачи, которые ждут решения",
          "  /who <имя>        — что известно про агента",
          "  /jarvis           — из чего состоит Джарвис: агенты, tools, skills",
          "  /clear            — очистить окно (переписка не удаляется)",
          "  /new              — новый чат: агент начнёт с чистого контекста",
          "  /help             — эта справка",
          "что угодно без / — уходит агентам в общую или адресную (кнопки выше) переписку",
          "",
          "подсказки по вводу (всплывают сами, выбор — стрелками/мышью, Enter или Tab):",
          "  @ — агент       (@Джарвис ...)",
          "  / — команда     (в начале сообщения)",
          "  $ — проект      ($MBOX вместо «мбокс/mbox/MBOX»)",
          "  # — артефакт",
        ].join("\n"));
        return;
      case "status":
      case "agents": {
        if (!agents.length) { pushLocal("sys", "агентов пока не подключено"); return; }
        pushLocal("sys", states.map(({ agent, state }) => `${agent.name.padEnd(10)} ${state.label}${state.detail ? " · " + state.detail : ""}`).join("\n"));
        return;
      }
      case "blocked": {
        const items = projects.flatMap((project) => project.todos
          .filter((todo) => todo.status === "blocked" || todo.status === "review")
          .map((todo) => `${project.name} · ${todo.status === "blocked" ? "заблокирована" : "на проверке"} · ${todo.title}`));
        pushLocal("sys", items.length ? items.join("\n") : "ничего не заблокировано и не ждёт проверки");
        return;
      }
      case "who": {
        const found = states.find(({ agent }) => agent.name.toLowerCase() === arg.toLowerCase());
        if (!found) { pushLocal("sys", arg ? `агент «${arg}» не найден` : "укажи имя: /who ChatGPT"); return; }
        pushLocal("sys", `${found.agent.name}: ${found.state.label}${found.state.detail ? " — " + found.state.detail : ""} · ${found.agent.kind}${found.agent.client ? " · " + found.agent.client : ""}`);
        return;
      }
      case "jarvis":
        pushLocal("sys", JARVIS_DESCRIPTION);
        return;
      case "clear":
        setLocalLines([]);
        setPending([]);
        return;
      case "new":
        startNewChat();
        return;
      default:
        pushLocal("sys", `неизвестная команда: /${cmd} — попробуй /help`);
    }
  }

  // overrideText — клик по кнопке варианта (см. parseActions/props.actions) шлёт готовый ответ
  // тем же путём, что и обычное сообщение, без похода через textarea/историю ввода.
  async function send(overrideText?: string) {
    const raw = (overrideText ?? text).trim();
    const files: Attachment[] = overrideText === undefined ? readyFiles.map(({ name, key, size, type }) => ({ name, key, size, type })) : [];
    if (!raw && !files.length) return;
    if (overrideText === undefined && uploadingFiles) return;
    if (overrideText === undefined) {
      if (raw) setHistory((current) => [...current, raw].slice(-100));
      setHistoryPos(-1);
      setText("");
      setDrafts([]);
    }

    if (raw.startsWith("/") && !files.length) {
      runCommand(raw);
      return;
    }

    // Файлы уходят и в props (карточки в чате), и ссылками в тексте — агенты читают текст.
    const body = files.length ? [raw, attachmentsBlock(files)].filter(Boolean).join("\n\n") : raw;
    const replying = overrideText === undefined ? replyTo : null;
    if (replying) setReplyTo(null);
    // Адресат: явное @Имя, иначе собеседник этого чата, иначе автор сообщения, на которое отвечаем.
    const mentionTarget = parseMention(raw) || chatTarget || (replying && replying.actor !== HUMAN ? replying.actor : "") || defaultResponder;
    const localId = `local-${Date.now()}`;
    const localAt = new Date().toISOString();
    setPending((current) => [...current, { id: localId, body, at: localAt, sent: false, attachments: files.length ? files : undefined }]);

    try {
      const messageProps: Record<string, unknown> = {};
      if (mentionTarget) messageProps.to = mentionTarget;
      if (replying) {
        messageProps.re = replying.id;
        messageProps.in_reply_to = replying.id;
      }
      if (currentProjectName) messageProps.current_project_name = currentProjectName;
      // Модель и «усилие» выбираются рядом с полем ввода; пустое значение = как было (по умолчанию).
      if (effectiveModel) messageProps.model = effectiveModel;
      if (effectiveEffort) messageProps.effort = effectiveEffort;
      if (files.length) messageProps.attachments = files;
      if (thread) messageProps.thread = thread;
      if (sharedFocus.length) messageProps.context = sharedFocus.map(({ kind, title, id, detail }) => ({ kind, title, ...(id ? { id } : {}), ...(detail ? { detail } : {}) }));
      const result = await fetchJson<{ inbox_item?: { id: string } }>("/api/mbox/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: effectiveProjectId || null,
          agent_name: HUMAN,
          item_type: "question",
          title: (raw || files.map((file) => file.name).join(", ")).slice(0, 120),
          body,
          priority: "high",
          requires_human: false,
          props: messageProps,
        }),
      });
      // Джарвис отвечает и на нетегнутые сообщения (см. scripts/mbox-archivist.mjs), поэтому
      // без адресата ждём его; с адресатом — того, кому написали (Claude, Codex).
      const waitingFor = mentionTarget || defaultResponder;
      if (result.inbox_item?.id) {
        setAwaitingAgent(waitingFor);
        setAwaitingJarvisId(result.inbox_item.id);
        setAwaitingJarvisSince(Date.now());
        setAwaitingJarvisVerb(randomThinkingVerb());
      }
      // Помечаем отправленным сразу. Ждать onSaved нельзя: он тянет одиннадцать ручек
      // через туннель к боевой базе, и «отправляется» висело бы секундами.
      setPending((current) => current.map((item) => item.id === localId ? { ...item, sent: true, inboxId: result.inbox_item?.id } : item));
      onSaved("agent_inbox");
    } catch {
      setPending((current) => current.map((item) => item.id === localId ? { ...item, failed: true } : item));
    }
  }

  async function attachFiles(list: File[]) {
    const day = new Date().toISOString().slice(0, 10);
    for (const file of list) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const safe = (file.name || "файл").replace(/[^\p{L}\p{N}._-]+/gu, "-");
      // Всё относится к проектам: вложения чата лежат в папке проекта (участнику другие папки хранилища закрыты).
      const key = effectiveProjectId ? `projects/${effectiveProjectId}/chat/${day}/${id}-${safe}` : `chat/${day}/${id}-${safe}`;
      const draft: DraftAttachment = { id, name: file.name || safe, key, size: file.size, type: file.type || "application/octet-stream", loaded: 0 };
      setDrafts((current) => [...current, draft]);
      uploadToStorage(key, file, (loaded) => setDrafts((current) => current.map((item) => (item.id === id ? { ...item, loaded } : item))))
        .then(() => setDrafts((current) => current.map((item) => (item.id === id ? { ...item, loaded: item.size, done: true } : item))))
        .catch((error: unknown) => setDrafts((current) => current.map((item) => (item.id === id ? { ...item, error: error instanceof Error ? error.message : String(error) } : item))));
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** Перенос строки вставляем сами, а не полагаемся на поведение браузера по умолчанию: так он одинаково
   * работает в браузере и в MBOX Desktop, где часть сочетаний перехватывает рабочее место. */
  function insertNewline(el: HTMLTextAreaElement) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
    setText(next);
    setCursor(start + 1);
    requestAnimationFrame(() => composerRef.current?.setSelectionRange(start + 1, start + 1));
  }

  function startReply(line: LogLine) {
    if (!line.inboxId) return;
    setReplyTo({ id: line.inboxId, actor: line.actor, text: line.text });
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** Клик по цитате — к исходному сообщению, с короткой подсветкой. */
  function jumpTo(id: string) {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`);
    if (!target) return;
    stickToBottomRef.current = false;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("is-flash");
    window.setTimeout(() => target.classList.remove("is-flash"), 1600);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); return; }
      // Раньше Enter тоже довершал подсказку — при "@Имя" первый Enter только доставлял
      // упоминание (курсор оставался в открытом токене), а реальная отправка требовала
      // второго Enter. Ощущалось как "сообщения с @ уходят не мгновенно". Tab — подсказка,
      // Enter — всегда отправка, без исключений.
      if (event.key === "Tab") { event.preventDefault(); acceptSuggestion(suggestions[highlight].value); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissedKey(tokenKey); return; }
    }
    if (event.key === "Escape" && replyTo) { event.preventDefault(); setReplyTo(null); return; }
    // Enter — отправить, Shift+Enter (и Alt+Enter) — новая строка, Ctrl/Cmd+Enter — отправить всегда.
    // На сенсорном экране Enter переносит строку: отправка кнопкой, иначе многострочное не написать.
    // Во время набора через IME Enter подтверждает слово, а не отправляет.
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); void send(); return; }
      if (event.shiftKey || event.altKey) {
        event.preventDefault();
        insertNewline(event.currentTarget);
        return;
      }
      if (!coarsePointer()) { event.preventDefault(); void send(); return; }
      return;
    }
    // История команд — только когда курсор ещё не гуляет по многострочному тексту, иначе
    // стрелки должны просто двигать курсор внутри composer'а, как в любом текстовом поле.
    const target = event.currentTarget;
    const singleLine = !target.value.includes("\n");
    if (event.key === "ArrowUp" && singleLine && history.length) {
      event.preventDefault();
      const next = historyPos < 0 ? history.length - 1 : Math.max(0, historyPos - 1);
      setHistoryPos(next);
      setText(history[next]);
      return;
    }
    if (event.key === "ArrowDown" && singleLine && historyPos >= 0) {
      event.preventDefault();
      const next = historyPos + 1;
      if (next >= history.length) { setHistoryPos(-1); setText(""); } else { setHistoryPos(next); setText(history[next]); }
    }
  }

  const threadList = (
    <>
      {cloudOnline ? (
        <>
          <button type="button" role="menuitem" className="console-thread-menu-new" onClick={() => startNewChat("local")}>
            <Monitor size={14} /> Новый чат · локальный
          </button>
          <button type="button" role="menuitem" className="console-thread-menu-new" onClick={() => startNewChat("cloud")}>
            <Cloud size={14} /> Новый чат · в облаке
          </button>
        </>
      ) : (
        <button type="button" role="menuitem" className="console-thread-menu-new" onClick={() => startNewChat("local")}>
          <MessageSquarePlus size={14} /> Новый чат
        </button>
      )}
      {shownThreads.map((item) => (
        <div key={item.id} className={item.id === thread ? "console-thread-menu-row is-active" : "console-thread-menu-row"}>
          <button type="button" role="menuitem" onClick={() => switchThread(item.id)}>
            <span className="console-thread-menu-title"><span className="console-thread-menu-name">{item.title}</span>{isCloudAgent(item.peer) && <Cloud className="agent-cloud-mark" size={13} strokeWidth={2} aria-label="в облаке" />}</span>
            <span className="console-thread-menu-meta">
              {formatSince(item.last_at)} · {item.messages} {plural(item.messages, "сообщение", "сообщения", "сообщений")}
              {Number(item.last_work?.context_tokens) > 0 && ` · контекст ${formatWorkTokens(Number(item.last_work?.context_tokens))}`}
            </span>
          </button>
          <button type="button" className="console-thread-archive" onClick={() => { switchThread(item.id); setRenaming(item.id); }} title="Переименовать" aria-label={`Переименовать: ${item.title}`}><Pencil size={12} /></button>
          <button type="button" className="console-thread-archive" onClick={() => archiveThread(item.id)} title="Убрать чат в архив" aria-label={`Убрать в архив: ${item.title}`}><Archive size={13} /></button>
        </div>
      ))}
      <button type="button" role="menuitem" className={!thread ? "console-thread-menu-legacy is-active" : "console-thread-menu-legacy"} onClick={() => switchThread("")}>
        <span className="console-thread-menu-title">Старая переписка</span>
        <span className="console-thread-menu-meta">сообщения до появления чатов</span>
      </button>
    </>
  );

  let lastDay = "";

  return (
    <div className={embedded ? "agent-chat is-embedded" : "agent-chat"}>
      {(open || embedded) && (
        <div className="agent-chat-shell console" style={{ ["--console-panel-width" as string]: `${panelWidth}px` }}>
          {/* Только на пристыкованной раскладке (см. брейкпоинт ≥1201px в chat.css) — на
              floating/fullscreen режимах уже, тянуть нечего. */}
          {!embedded && <div className="console-resize-handle" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Изменить ширину консоли" />}
          <div className="console-bar">
            <div className="console-bar-roster" title={rosterSummary}>
              {states.length ? states.map(({ agent, state }) => (
                <span className={`console-bar-agent ${state.key}`} key={agent.id} title={`${agentDisplayName(agent.name)}${isCloudAgent(agent.name) ? " в облаке" : ""} · ${state.label}`}>
                  <AgentAvatar name={agent.name} status={state.key} live={state.key === "working"} size={20} />
                  <AgentName name={agent.name} className="console-bar-agent-name" />
                  {state.key === "working" && <span className="console-bar-agent-phase">{state.label}</span>}
                </span>
              )) : <span className="console-bar-agent muted">агентов нет на связи</span>}
            </div>
            <button className="chat-close" type="button" onClick={() => setOpen(false)} aria-label="Свернуть"><X size={21} strokeWidth={3} /></button>
          </div>

          <div className={threadsAside ? "console-split has-aside" : "console-split"}>
          {threadsAside && (
            <nav className="console-threads-aside" aria-label="Чаты">
              <div className="console-thread-menu is-aside" role="menu">{threadList}</div>
            </nav>
          )}
          <div className="console-main">
          {placeThreads(<div className="console-threads">
            <button
              type="button"
              className={threadsAside ? "console-thread-icon is-on" : "console-thread-icon"}
              onClick={() => { setThreadsAside(!threadsAside); setThreadMenu(false); }}
              aria-pressed={threadsAside}
              title={threadsAside ? "Скрыть список чатов" : "Список чатов сбоку"}
              aria-label="Список чатов сбоку"
            >
              <PanelLeft size={15} />
            </button>
            {renaming === thread && thread ? (
              <input
                className="console-thread-rename"
                autoFocus
                defaultValue={currentThread?.title || ""}
                aria-label="Название чата"
                onBlur={(event) => renameThread(thread, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") renameThread(thread, event.currentTarget.value);
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button type="button" className="console-thread-current" onClick={() => (threadsAside ? thread && setRenaming(thread) : setThreadMenu((value) => !value))} onDoubleClick={() => thread && setRenaming(thread)} aria-expanded={threadsAside ? undefined : threadMenu} title={threadsAside ? "Переименовать чат" : "Все чаты · двойной щелчок — переименовать"}>
                <span className="console-thread-title">{thread ? currentThread?.title || "Новый чат" : "Старая переписка"}</span>
                {cloudChat && <Cloud className="agent-cloud-mark" size={12} strokeWidth={2.2} aria-label="в облаке" />}
                {!threadsAside && <ChevronDown size={13} />}
              </button>
            )}
            {contextLoad && (
              <div
                className={`console-context${contextShare >= 0.6 ? " is-heavy" : ""}`}
                title={`Контекст сессии ${contextLoad.agent} в этом чате: ${contextLoadText(contextLoad)}. Столько агент перечитывает на каждом шаге — чем больше, тем дороже каждый ответ.${contextShare >= 0.6 ? " Для новой темы лучше начать новый чат." : ""}`}
              >
                <span className="console-context-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round(contextShare * 100))}%` }} /></span>
                <span className="console-context-text">{formatWorkTokens(contextLoad.tokens)}</span>
              </div>
            )}
            <button
              type="button"
              className={newChatMenu ? "console-thread-icon is-on" : "console-thread-icon"}
              onClick={() => (cloudOnline ? setNewChatMenu((value) => !value) : startNewChat("local"))}
              title={cloudOnline ? "Новый чат: локальный или в облаке" : "Новый чат: агент начнёт с чистого контекста, старый останется в списке"}
              aria-label="Новый чат"
              aria-expanded={cloudOnline ? newChatMenu : undefined}
            >
              <MessageSquarePlus size={15} />
            </button>
            {newChatMenu && cloudOnline && (
              <div className="console-thread-menu console-new-chat-menu" role="menu">
                <button type="button" role="menuitem" className="console-thread-menu-new" onClick={() => startNewChat("local")}>
                  <Monitor size={14} /> Локальный · на этом компьютере
                </button>
                <button type="button" role="menuitem" className="console-thread-menu-new" onClick={() => startNewChat("cloud")}>
                  <Cloud size={14} /> В облаке · работает без компьютера
                </button>
              </div>
            )}
            {debug && (
              <button
                type="button"
                className={debug.open ? "console-thread-icon is-on" : "console-thread-icon"}
                onClick={debug.toggle}
                aria-pressed={debug.open}
                title={debug.open ? "Скрыть режим отладки" : "Режим отладки: вывод процесса агента"}
                aria-label="Режим отладки"
              >
                <Bug size={14} />
                {debug.live && <i className="console-debug-live" aria-hidden="true" />}
              </button>
            )}
            {threadMenu && !threadsAside && (
              <div className="console-thread-menu" role="menu">
                {threadList}
              </div>
            )}
          </div>)}

          {debug?.open && <div className="console-debug">{debug.panel}</div>}

          {/* Действия, требующие решения человека (requires_human) — раньше жили только на
              Обзоре, в консоли их не было видно вовсе, приходилось ждать, пока агент сам
              не подвиснет с вопросом в логе. Тот же компонент, что на Обзоре — не дублируем логику. */}
          {/* Вопросы, ждущие решения человека, — общие для всех, показываем в общем чате, а не в каждом личном. */}
          {!peer && (
            <div className="console-needs-answer">
              <NeedsAnswer inbox={inbox} onSaved={onSaved} />
            </div>
          )}

          <div className="console-log" ref={scrollRef} data-scroll-memory="off" tabIndex={0} role="log" aria-label="Сообщения чата">
            {lines.length === 0 && (
              <div className="console-empty">
                {peer ? <AgentAvatar name={peer} size={64} /> : <MessagesSquare size={48} strokeWidth={1.5} />}
                <strong className="agent-name">{peer ? `Чат с ${peer}` : "Общий чат"}{cloudChat && <Cloud className="agent-cloud-mark" size={14} strokeWidth={2.2} aria-label="в облаке" />}</strong>
                <p>{peer
                  ? `Сообщения уходят только ${peer}${cloudChat ? " в облаке — он работает на сервере MBOX и отвечает при выключенном компьютере" : " на этом компьютере"}, @ писать не нужно. Каждый чат — отдельная сессия: агент помнит только этот разговор.`
                  : "Отвечает Джарвис. Позвать другого агента — @Имя, команды — /help."}</p>
              </div>
            )}
            {lines.length > visibleLines.length && (
              <div className="console-log-sep">Показаны последние {visibleLines.length} сообщений</div>
            )}
            {visibleLines.map((line, index) => {
              const day = line.at.slice(0, 10);
              const showDay = day !== lastDay;
              lastDay = day;
              const time = new Date(line.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              // Цитата нужна, когда исходное сообщение не стоит прямо над ответом, — иначе она лишь повторяет строку выше.
              const quote = line.replyTo && visibleLines[index - 1]?.inboxId !== line.replyTo.id ? line.replyTo : null;
              return (
                <div key={line.id}>
                  {showDay && <div className="console-log-sep">{day}</div>}
                  <div className={`console-log-line ${line.kind}${line.pending === "failed" ? " failed" : ""}`} data-inbox-id={line.inboxId}>
                    <span className="console-log-head">
                      {line.kind === "in" && <AgentAvatar name={line.actor} size={18} />}
                      <span className="console-log-actor">
                        {line.kind === "cmd" ? "$" : line.kind === "sys" ? "mbox" : line.kind === "out" ? "Вы" : <AgentName name={line.actor} />}
                      </span>
                      <span className="console-log-time" title={new Date(line.at).toLocaleString("ru-RU")}>{time}</span>
                      {line.inboxId && (
                        <button type="button" className="console-reply-btn" onClick={() => startReply(line)} title="Ответить на это сообщение">
                          <Reply size={12} /> ответить
                        </button>
                      )}
                    </span>
                    {/* Цепочка идёт до самого ответа и всегда развёрнута — это часть переписки,
                        а не приложение к ней: сначала видно, что агент делал, потом что получилось. */}
                    {!!line.steps?.length && (
                      <div className="console-chain-block">
                        <ChainTitle steps={line.steps} work={line.work} />
                        <ChainTimeline steps={line.steps} />
                      </div>
                    )}
                    <div className={line.failed ? "console-bubble is-failed" : "console-bubble"}>
                    {quote && (
                      <button type="button" className="console-quote" onClick={() => jumpTo(quote.id)} title="Показать исходное сообщение">
                        <CornerDownRight size={11} />
                        <b>{quote.actor === HUMAN ? "ты" : quote.actor}</b>
                        <span>{snippet(quote.text)}</span>
                      </button>
                    )}
                    {line.failed && <span className="console-failed-title"><AlertTriangle size={13} /> Ответ не получен</span>}
                    <span className="console-log-text">
                      {line.failed ? renderMarkdownLite(humanizeAgentError(line.text).message) : line.renderedText || renderMarkdownLite(line.text)}
                      {line.pending === "sending" && <em className="console-log-status"> отправляется…</em>}
                      {line.pending === "failed" && <em className="console-log-status failed"> не отправлено</em>}
                    </span>
                    {line.failed && humanizeAgentError(line.text).detail && <span className="console-failed-detail">{humanizeAgentError(line.text).detail}</span>}
                    {!!line.attachments?.length && <AttachmentList files={line.attachments} />}
                    </div>
                    {/* Пилюли использованных инструментов под ответом убраны: те же шаги уже видны цепочкой над ним. */}
                    {!!line.highlights?.length && (
                      <div className="console-highlights">
                        {line.highlights.map((text, index) => (
                          <p className="console-highlight-line" key={index}>{text}</p>
                        ))}
                      </div>
                    )}
                    {!line.trace?.length && workSummary(line.work) && (
                      <p className="console-work-line">{workSummary(line.work)}</p>
                    )}
                    {line.rateLimit && (
                      <p className="console-rate-limit" role="status">
                        <AlertTriangle size={12} />
                        {rateLimitText(line.rateLimit)}
                      </p>
                    )}
                    {!!line.reasoning?.length && (
                      <details className="console-trace-details is-reasoning">
                        <summary><Brain size={11} /> Ход мысли{line.model ? ` · ${line.model}` : ""}{line.effort ? ` · ${EFFORT_LABEL[line.effort] || line.effort}` : ""}</summary>
                        <div className="console-reasoning">{line.reasoning.map((text, index) => <p key={index}>{text}</p>)}</div>
                      </details>
                    )}
                    {/* Цепочка шагов, как в Claude Code: что вызвано, с чем и что вернулось.
                        Плоский trace остаётся запасным — его присылает Джарвис, у которого шагов нет. */}
                    {!line.steps?.length && !!line.trace?.length && (
                      <details className="console-trace-details">
                        <summary>{workSummary(line.work) || `Подробности (${line.trace.length})`}</summary>
                        <pre className="console-trace">{line.trace.join("\n\n")}</pre>
                      </details>
                    )}
                    {!!line.actions?.length && (
                      <span className="console-actions">
                        {line.actions.map((action) => (
                          <button key={action.value} type="button" className="console-action-btn" onClick={() => void send(action.value)}>
                            {action.label}
                          </button>
                        ))}
                      </span>
                    )}
                    {!!line.postBuilder?.length && (
                      <PostBuilderCard parts={line.postBuilder} onSend={(text) => void send(text)} />
                    )}
                  </div>
                </div>
              );
            })}
            {/* Цепочка растёт на глазах: шаги приезжают по сокету, пока агент работает, и стоят
                там же, где потом встанет готовая — над ответом. */}
            {awaitingJarvisId && liveSteps.length > 0 && (
              <div className="console-chain-block is-live">
                <ChainTimeline steps={liveSteps} />
              </div>
            )}
            {awaitingJarvisId && (
              <div className="console-log-line sys typing">
                <span className="console-log-time" />
                <span className={awaitingDead ? "console-thinking-row is-dead" : "console-thinking-row"}>
                  {awaitingDead ? <AlertTriangle size={16} /> : <ThinkingSpinner />}
                  {/* Шуточные глаголы — это голос Джарвиса. Для остальных агентов нужен простой
                      признак жизни, а не «прячется в чернильное облако от смущения». */}
                  {awaitingDead ? (
                    <span className="console-log-text">{cloudChat ? `${peer} в облаке не на связи — сообщение ждёт в очереди, ответ придёт, когда агент на сервере снова подключится.` : `Наблюдатель ${peer} не работает (${debug?.process?.text}) — ответа не будет, пока его не запустить.`}</span>
                  ) : <span className="console-log-text"><AgentName name={awaitingAgent} />: {awaitingPhase || (awaitingAgent.toLowerCase() === JARVIS_NAME.toLowerCase() ? `${awaitingJarvisVerb}…` : "работает…")} {awaitingJarvisSeconds}с</span>}
                  {awaitingDead && debug?.process && (
                    <button type="button" className="console-start-btn" onClick={debug.process.start}>Запустить</button>
                  )}
                  {/* Отмена снимает сообщение с очереди (status done): наблюдатель его уже не возьмёт.
                      Джарвису она ещё и обрывает запрос к модели. CLI, который уже начал отвечать, не прерывается. */}
                  {(
                    <button type="button" className="console-cancel-btn" onClick={cancelJarvis} title="Отменить: сообщение уйдёт из очереди">
                      <X size={11} />
                    </button>
                  )}
                </span>
              </div>
            )}
          </div>

          <div className="console-composer">
            {suggestions.length > 0 && (
              <div className="console-suggest">
                {suggestions.map((suggestion, index) => {
                  const Icon = token ? TRIGGER_ICON[token.trigger] : AtSign;
                  return (
                    <button
                      key={suggestion.value}
                      type="button"
                      className={index === highlight ? "is-active" : ""}
                      onMouseDown={(event) => { event.preventDefault(); acceptSuggestion(suggestion.value); }}
                    >
                      <Icon size={12} className="console-suggest-icon" />
                      <b>{suggestion.value}</b>
                      {suggestion.hint && <em>{suggestion.hint}</em>}
                    </button>
                  );
                })}
              </div>
            )}
            {replyTo && (
              <div className="console-reply-bar">
                <CornerDownRight size={12} />
                <span>
                  Ответ <b>{replyTo.actor === HUMAN ? "себе" : replyTo.actor}</b>: {snippet(replyTo.text, 180)}
                </span>
                <button type="button" onClick={() => setReplyTo(null)} aria-label="Отменить ответ" title="Отменить ответ (Esc)"><X size={12} /></button>
              </div>
            )}
            {drafts.length > 0 && (
              <div className="console-drafts">
                {drafts.map((file) => (
                  <span key={file.id} className={["console-draft", file.error ? "is-error" : "", file.done ? "is-done" : ""].filter(Boolean).join(" ")} title={file.error || file.name}>
                    <i style={{ width: `${file.size ? Math.round((file.loaded / file.size) * 100) : 100}%` }} />
                    <Paperclip size={11} />
                    <span>{file.name}</span>
                    <em>{file.error ? "не загрузилось" : file.done ? formatBytes(file.size) : `${Math.round((file.loaded / Math.max(1, file.size)) * 100)}%`}</em>
                    <button type="button" onClick={() => setDrafts((current) => current.filter((item) => item.id !== file.id))} aria-label={`Убрать ${file.name}`}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            {!peer && !jarvisEnabled && (
              <p className="console-jarvis-off">Джарвис для вашего аккаунта выключен — владелец может включить его в настройках команды. Сообщения в этом чате сейчас никто не прочитает.</p>
            )}
            <form
              hidden={!peer && !jarvisEnabled}
              className={dragFiles ? "console-input-row is-drop" : "console-input-row"}
              onSubmit={(event) => { event.preventDefault(); void send(); }}
              onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragFiles(true); } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragFiles(false); }}
              onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragFiles(false); void attachFiles([...event.dataTransfer.files]); } }}
            >
              <button type="button" className="console-attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Приложить файл" title="Приложить файл — или вставьте из буфера, перетащите сюда">
                <Paperclip size={16} />
              </button>
              <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void attachFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
              <div className="console-input-body">
                {focus.length > 0 && (
                  <div className="console-focus" aria-label="Что агент увидит как открытое у вас">
                    {focus.map((item) => {
                      const off = mutedFocus.includes(item.key);
                      const Icon = FOCUS_ICON[item.kind] || AppWindow;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={off ? "console-focus-chip is-off" : "console-focus-chip"}
                          aria-pressed={!off}
                          onClick={() => setMutedFocus((current) => (off ? current.filter((key) => key !== item.key) : [...current, item.key]))}
                          title={`${off ? "Не отправляется" : "Агент увидит, что это открыто"}: ${item.detail || item.title} — нажмите, чтобы ${off ? "включить" : "отжать"}`}
                        >
                          <Icon size={11} />
                          <span>{item.title}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  value={text}
                  onChange={(event) => { setText(event.target.value); setCursor(event.target.selectionStart); }}
                  onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                  onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                  onKeyDown={onKeyDown}
                  onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void attachFiles(files); } }}
                  placeholder={peer ? `Сообщение для ${peer}${cloudChat ? " в облаке" : ""}` : "Напишите сообщение…"}
                  spellCheck
                  autoComplete="off"
                  rows={1}
                />
                <div className="console-input-meta">
                  <div className="console-input-hints" aria-hidden="true">
                    <span><b>@</b> агент</span><span><b>/</b> команда</span><span><b>$</b> проект</span><span><b>#</b> артефакт</span>
                    <span className="console-input-newline"><kbd>Shift</kbd><kbd>Enter</kbd> новая строка</span>
                  </div>
                  {/* Пикеры вынесены из строки подсказок: у неё overflow: hidden ради обрезки текста
                      на узком окне, и он срезал раскрытое меню целиком. */}
                  <div className="console-input-pickers">
                  {/* Чем отвечать. Список приходит с сервера (какие ключи есть), «как обычно» —
                      прежнее поведение: основная модель, при её отказе резервная. */}
                  {shownModels.length > 0 && (
                    <ComposerPicker
                      label="Чем отвечать"
                      value={effectiveModel}
                      onChange={setModel}
                      // Пустой выбор — не «ничего», а модель по умолчанию: показываем её саму,
                      // чтобы в поле ввода всегда было видно, кто будет отвечать.
                      placeholder={defaultModelLabel}
                      defaultValue={shownDefaultModel}
                      options={shownModels.map((item) => ({ value: item.id, label: item.label }))}
                    />
                  )}
                  {shownEfforts.length > 0 && (
                    <ComposerPicker
                      label="Как долго думать перед ответом"
                      value={effectiveEffort}
                      onChange={setEffort}
                      placeholder={shownEfforts.find((item) => item.id === shownDefaultEffort)?.label || "По умолчанию"}
                      defaultValue={shownDefaultEffort}
                      options={shownEfforts.map((item) => ({ value: item.id, label: item.label, hint: item.hint }))}
                    />
                  )}
                  </div>
                </div>
              </div>
              <button type="submit" className="console-send-btn" disabled={(!text.trim() && !readyFiles.length) || uploadingFiles} aria-label="Отправить" title={uploadingFiles ? "Дождитесь загрузки файлов" : "Отправить (Enter)"}>
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            </form>
          </div>
          </div>
          </div>
        </div>
      )}

      {!embedded && <button className="agent-chat-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-label={unread > 0 ? `Консоль агентов, ${unread} непрочитанных` : "Консоль агентов"} title="Консоль агентов">
        <Terminal size={11} />
        <span className="agent-chat-toggle-label">Консоль</span>
        {working.length > 0 && <i className="chat-dot state-working" />}
        {unread > 0 && <b>{unread}</b>}
      </button>}
    </div>
  );
}
