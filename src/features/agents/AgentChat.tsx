import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AtSign, ChevronRight, DollarSign, Hash, Slash, Terminal, Wrench, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { NeedsAnswer } from "./NeedsAnswer";
import { effectiveStatus, liveRunOf } from "../../lib/agents";
import { fetchJson } from "../../lib/api";
import { formatSince, plural } from "../../lib/format";
import type { AgentActivity, AgentInboxItem, AgentRun, Artifact, Project } from "../../types";

const JARVIS_NAME = "Джарвис";

const SLASH_COMMANDS = [
  { value: "help", hint: "эта справка" },
  { value: "status", hint: "кто сейчас на связи" },
  { value: "agents", hint: "кто сейчас на связи" },
  { value: "blocked", hint: "задачи, которые ждут решения" },
  { value: "who", hint: "что известно про агента" },
  { value: "jarvis", hint: "из чего состоит Джарвис — агенты, инструменты, скиллы" },
  { value: "clear", hint: "очистить окно" },
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

/** Ведущее @Имя в начале сообщения — раньше был отдельный ростер кнопок для выбора адресата,
 * теперь то же самое просто печатается в тексте (см. подсказки по @) и парсится отсюда. */
function parseMention(raw: string): string {
  const match = raw.trim().match(/^@(\S+)/);
  return match ? match[1] : "";
}

const MARKDOWN_TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<!\w)_[^_\n]+_(?!\w))/g;

function renderInlineMarkdown(content: string, keyPrefix: string): ReactNode[] {
  const parts = content.split(MARKDOWN_TOKEN).filter((part) => part !== "");
  return parts.map((part, partIndex) => {
    const key = `${keyPrefix}-${partIndex}`;
    if (part.startsWith("**") && part.endsWith("**")) return <b key={key}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
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
const CONVERSATION = new Set(["question", "answer", "agent_message", "agent_response", "chat"]);

/**
 * Что агент делает прямо сейчас. Считается из живых сессий и присутствия, а не выдумывается.
 * Живой = по сессии стучит heartbeat; брошенный running не выдаётся за работу (см. lib/agents).
 */
function agentState(agent: AgentActivity, runs: AgentRun[]) {
  const live = liveRunOf(runs, agent.name);
  if (live) return { key: "working", label: "работает", detail: live.goal };
  const status = effectiveStatus(agent);
  // phase — живой сигнал, который агент сам присылает через POST /agent/ping (не выдумываем
  // "думает" статично: если фазы нет, значит агент сейчас реально ничего не делает).
  if (status === "active" && agent.phase) return { key: "working", label: agent.phase, detail: agent.client };
  if (status === "active") return { key: "thinking", label: "на связи", detail: agent.client || "ждёт задачу" };
  if (status === "idle") return { key: "idle", label: "ожидает", detail: formatSince(agent.last_seen) };
  return { key: "offline", label: "отключён", detail: formatSince(agent.last_seen) };
}

const THINKING_FRAMES = [1, 2, 3, 4, 5].map((n) => `/assets/icons/ai-thinking-spinner/${n}.png`);

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

type MessageAction = { label: string; value: string };

type LogLine = {
  id: string;
  kind: "in" | "out" | "sys" | "cmd";
  actor: string;
  text: string;
  at: string;
  pending?: "sending" | "sent" | "failed";
  toolsUsed?: string[];
  trace?: string[];
  highlights?: string[];
  actions?: MessageAction[];
  postBuilder?: PostPart[];
};

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

export function AgentChat({ inbox, agents, runs, projects, artifacts, projectId, currentProjectName, onSaved }: {
  inbox: AgentInboxItem[];
  agents: AgentActivity[];
  runs: AgentRun[];
  projects: Project[];
  artifacts: Artifact[];
  projectId?: string;
  currentProjectName?: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("mbox.console.width"));
    return stored > 0 ? stored : Math.round(window.innerWidth / 3);
  });
  const resizingRef = useRef(false);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyPos, setHistoryPos] = useState(-1);
  const [localLines, setLocalLines] = useState<LogLine[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; body: string; sent?: boolean; failed?: boolean }>>([]);
  const [awaitingJarvisId, setAwaitingJarvisId] = useState<string | null>(null);
  const [awaitingJarvisSince, setAwaitingJarvisSince] = useState<number | null>(null);
  const [awaitingJarvisPhase, setAwaitingJarvisPhase] = useState<string | null>(null);
  const [awaitingJarvisVerb, setAwaitingJarvisVerb] = useState("думает");
  // Значение не читается — сам факт смены форсирует re-render, чтобы Date.now() в
  // awaitingJarvisSeconds ниже пересчитывался каждую секунду.
  const [, setElapsedTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const liveMention = parseMention(text);

  // field-sizing: content не работает в Safari/Firefox — растим textarea вручную по scrollHeight,
  // это единственный способ, который реально работает везде.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

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

  const conversation = useMemo(
    () => [...inbox].filter((item) => CONVERSATION.has(item.item_type)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-80),
    [inbox],
  );

  const arrived = useMemo(() => new Set(conversation.map((item) => (item.body || item.title).trim())), [conversation]);
  const stillPending = pending.filter((item) => item.failed || !arrived.has(item.body.trim()));

  // "Ответ приходит резко" — раньше не было вообще никакого признака, что Джарвис работает над
  // ответом (в отличие от "печатает" у сессионных агентов ниже, у него нет agent_runs). Плашка
  // "думает" висит с момента отправки до прихода ответа с props.re на этот же item, либо гаснет
  // по таймауту, если инлайн-путь не сработал и подхватил резервный cron (тогда ответ просто придёт
  // самостоятельным сообщением позже).
  useEffect(() => {
    if (!awaitingJarvisId) return;
    if (conversation.some((item) => item.agent_name === JARVIS_NAME && String(item.props?.re ?? "") === awaitingJarvisId)) {
      setAwaitingJarvisId(null);
      setAwaitingJarvisSince(null);
      setAwaitingJarvisPhase(null);
      return;
    }
    const timeout = window.setTimeout(() => { setAwaitingJarvisId(null); setAwaitingJarvisSince(null); setAwaitingJarvisPhase(null); }, 25000);
    return () => window.clearTimeout(timeout);
  }, [awaitingJarvisId, conversation]);

  // Раньше "думает…" висело одним и тем же текстом весь ответ — жалоба: непонятно, застрял агент
  // или реально работает. Опрашиваем ту же фазу, что сервер пишет в jarvisPhase (см. server/vite).
  useEffect(() => {
    if (!awaitingJarvisId) { setAwaitingJarvisPhase(null); return; }
    let cancelled = false;
    const poll = () => {
      fetchJson<{ phase: string | null }>(`/api/mbox/agent/inbox/${awaitingJarvisId}/phase`)
        .then((data) => { if (!cancelled) setAwaitingJarvisPhase(data.phase); })
        .catch(() => {});
    };
    poll();
    const interval = window.setInterval(poll, 1500);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [awaitingJarvisId]);

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

  const states = useMemo(() => agents.map((agent) => ({ agent, state: agentState(agent, runs) })), [agents, runs]);
  const working = states.filter((entry) => entry.state.key === "working");
  // "N агентов на связи: имена" — раньше жило в шапке страницы и дублировало этот же ростер под
  // другим текстом. Состав разговора — дело консоли, не глобальной шапки.
  const online = states.filter((entry) => entry.state.key === "working" || entry.state.key === "thinking");
  const rosterSummary = online.length
    ? `${online.length} ${plural(online.length, "агент", "агента", "агентов")} на связи: ${online.map((entry) => entry.agent.name).join(", ")}`
    : "агентов нет на связи";

  const [readAt, setReadAt] = useState(() => {
    const stored = window.localStorage.getItem(READ_KEY);
    if (stored) return stored;
    const now = new Date().toISOString();
    window.localStorage.setItem(READ_KEY, now);
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
    window.localStorage.setItem(READ_KEY, last);
    setReadAt(last);
  }, [open, unread, unreadItems]);

  // Консоль на широком экране — не плавающий пузырь, а пристыкованная справа панель, которая
  // РЕАЛЬНО сдвигает контент (не перекрывает его): .workspace читает --console-width как
  // margin-right (см. chat.css, брейкпоинт ≥1201px — на более узких экранах поведение старое,
  // не трогаем уже выверенную мобильную раскладку). На уже открытых узких экранах переменная
  // просто не используется соответствующим медиа-запросом.
  useEffect(() => {
    document.documentElement.style.setProperty("--console-width", open ? `${panelWidth}px` : "0px");
    return () => { document.documentElement.style.setProperty("--console-width", "0px"); };
  }, [open, panelWidth]);

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
      setPanelWidth((current) => { window.localStorage.setItem("mbox.console.width", String(current)); return current; });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    if (!pending.length) return;
    setPending((current) => current.filter((item) => item.failed || !arrived.has(item.body.trim())));
  }, [arrived, pending.length]);

  // Единый лог: реальная переписка + оптимистичные отправки + локальные команды, всё по времени.
  const lines = useMemo<LogLine[]>(() => {
    const fromConversation: LogLine[] = conversation.map((item) => ({
      id: `msg-${item.id}`,
      kind: item.agent_name === HUMAN ? "out" : "in",
      actor: item.agent_name,
      text: item.body || item.title,
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
      // Заметные действия (создано/удалено/объединено) — видны сразу, в отличие от trace выше.
      highlights: Array.isArray(item.props?.highlights)
        ? (item.props.highlights as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      actions: parseActions(item.props?.actions),
      postBuilder: parsePostBuilder(item.props?.post_builder),
    }));
    const fromPending: LogLine[] = stillPending.map((item) => ({
      id: item.id,
      kind: "out",
      actor: "Ты",
      text: item.body,
      at: new Date().toISOString(),
      pending: item.failed ? "failed" : item.sent ? "sent" : "sending",
    }));
    return [...fromConversation, ...fromPending, ...localLines].sort((a, b) => a.at.localeCompare(b.at));
  }, [conversation, stillPending, localLines]);

  // "Всегда проматывать вниз при новом сообщении" — раньше зависело только от lines.length,
  // а индикатор "Джарвис думает…" не входит в lines (отдельный conditional-рендер), поэтому его
  // появление/пропажа меняло высоту контента без прокрутки следом.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, lines.length, awaitingJarvisId, working.length]);

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
        if (!found) { pushLocal("sys", arg ? `агент «${arg}» не найден` : "укажи имя: /who Codex"); return; }
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
      default:
        pushLocal("sys", `неизвестная команда: /${cmd} — попробуй /help`);
    }
  }

  // overrideText — клик по кнопке варианта (см. parseActions/props.actions) шлёт готовый ответ
  // тем же путём, что и обычное сообщение, без похода через textarea/историю ввода.
  async function send(overrideText?: string) {
    const raw = (overrideText ?? text).trim();
    if (!raw) return;
    if (overrideText === undefined) {
      setHistory((current) => [...current, raw]);
      setHistoryPos(-1);
      setText("");
    }

    if (raw.startsWith("/")) {
      runCommand(raw);
      return;
    }

    const body = raw;
    const mentionTarget = parseMention(raw);
    const localId = `local-${Date.now()}`;
    setPending((current) => [...current, { id: localId, body, sent: false }]);

    try {
      const messageProps: Record<string, unknown> = {};
      if (mentionTarget) messageProps.to = mentionTarget;
      if (currentProjectName) messageProps.current_project_name = currentProjectName;
      const result = await fetchJson<{ inbox_item?: { id: string } }>("/api/mbox/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId || null,
          agent_name: HUMAN,
          item_type: "question",
          title: body.slice(0, 120),
          body,
          priority: "high",
          requires_human: false,
          props: messageProps,
        }),
      });
      // Джарвис отвечает и на нетегнутые сообщения (см. scripts/mbox-archivist.mjs), поэтому
      // индикатор "думает" уместен если адресат не указан или это явно он.
      if ((!mentionTarget || mentionTarget.toLowerCase() === JARVIS_NAME.toLowerCase()) && result.inbox_item?.id) {
        setAwaitingJarvisId(result.inbox_item.id);
        setAwaitingJarvisSince(Date.now());
        setAwaitingJarvisVerb(randomThinkingVerb());
      }
      // Помечаем отправленным сразу. Ждать onSaved нельзя: он тянет одиннадцать ручек
      // через туннель к боевой базе, и «отправляется» висело бы секундами.
      setPending((current) => current.map((item) => item.id === localId ? { ...item, sent: true } : item));
      onSaved();
    } catch {
      setPending((current) => current.map((item) => item.id === localId ? { ...item, failed: true } : item));
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); acceptSuggestion(suggestions[highlight].value); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissedKey(tokenKey); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); return; }
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

  let lastDay = "";

  return (
    <div className="agent-chat">
      {open && (
        <div className="agent-chat-shell console" style={{ ["--console-panel-width" as string]: `${panelWidth}px` }}>
          {/* Только на пристыкованной раскладке (см. брейкпоинт ≥1201px в chat.css) — на
              floating/fullscreen режимах уже, тянуть нечего. */}
          <div className="console-resize-handle" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Изменить ширину консоли" />
          <div className="console-bar">
            <div className="console-bar-roster" title={rosterSummary}>
              {online.length ? online.map(({ agent, state }) => (
                <span className="console-bar-agent" key={agent.id} title={`${agent.name} · ${state.label}${state.detail ? " — " + state.detail : ""}`}>
                  <AgentAvatar name={agent.name} status={state.key} live={state.key === "working"} size={20} />
                  <span className="console-bar-agent-name">{agent.name}</span>
                  {state.key === "working" && <span className="console-bar-agent-phase">{state.label}</span>}
                </span>
              )) : <span className="console-bar-agent muted">агентов нет на связи</span>}
            </div>
            <button className="chat-close" type="button" onClick={() => setOpen(false)} aria-label="Свернуть"><X size={15} /></button>
          </div>

          {/* Действия, требующие решения человека (requires_human) — раньше жили только на
              Обзоре, в консоли их не было видно вовсе, приходилось ждать, пока агент сам
              не подвиснет с вопросом в логе. Тот же компонент, что на Обзоре — не дублируем логику. */}
          <div className="console-needs-answer">
            <NeedsAnswer inbox={inbox} onSaved={onSaved} />
          </div>

          <div className="console-log" ref={scrollRef}>
            {lines.length === 0 && (
              <div className="console-log-line sys"><span className="console-log-text">mbox консоль готова. /help — список команд.</span></div>
            )}
            {lines.map((line) => {
              const day = line.at.slice(0, 10);
              const showDay = day !== lastDay;
              lastDay = day;
              const time = new Date(line.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
              return (
                <div key={line.id}>
                  {showDay && <div className="console-log-sep">{day}</div>}
                  <div className={`console-log-line ${line.kind}${line.pending === "failed" ? " failed" : ""}`}>
                    <span className="console-log-head">
                      <span className="console-log-time">{time}</span>
                      {line.kind === "in" && <AgentAvatar name={line.actor} size={16} />}
                      <span className="console-log-actor">
                        {line.kind === "cmd" ? "$" : line.kind === "sys" ? "mbox" : line.kind === "out" ? "ты" : line.actor}
                        <ChevronRight size={11} />
                      </span>
                    </span>
                    <span className="console-log-text">
                      {renderMarkdownLite(line.text)}
                      {line.pending === "sending" && <em className="console-log-status"> отправляется…</em>}
                      {line.pending === "failed" && <em className="console-log-status failed"> не отправлено</em>}
                    </span>
                    {!!line.toolsUsed?.length && (
                      <span className="console-tools-used">
                        {line.toolsUsed.map((tool) => (
                          <span key={tool} className="console-tool-chip"><Wrench size={10} />{tool}</span>
                        ))}
                      </span>
                    )}
                    {!!line.highlights?.length && (
                      <div className="console-highlights">
                        {line.highlights.map((text, index) => (
                          <p className="console-highlight-line" key={index}>{text}</p>
                        ))}
                      </div>
                    )}
                    {!!line.trace?.length && (
                      <details className="console-trace-details">
                        <summary>Подробности ({line.trace.length})</summary>
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
            {working.length > 0 && (
              <div className="console-log-line sys typing">
                <span className="console-log-time" />
                <span className="console-log-actor">·</span>
                <span className="console-log-text">{working[0].agent.name} печатает: {working[0].state.detail || "работает"}</span>
              </div>
            )}
            {awaitingJarvisId && (
              <div className="console-log-line sys typing">
                <span className="console-log-time" />
                <span className="console-thinking-row">
                  <ThinkingSpinner />
                  <span className="console-log-text">{JARVIS_NAME}: {awaitingJarvisPhase || awaitingJarvisVerb}… {awaitingJarvisSeconds}с</span>
                  <button type="button" className="console-cancel-btn" onClick={cancelJarvis} title="Прервать запрос">
                    <X size={11} />
                  </button>
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
            <form className="console-input-row" onSubmit={(event) => { event.preventDefault(); void send(); }}>
              <span className="console-prompt">{liveMention && `@${liveMention}`}<img src="/assets/icons/icons/галочка.png" width={13} height={13} alt="" /></span>
              <textarea
                ref={composerRef}
                value={text}
                onChange={(event) => { setText(event.target.value); setCursor(event.target.selectionStart); }}
                onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                placeholder="/команда, @агент; $проект; #артефакт"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                rows={1}
              />
            </form>
          </div>
        </div>
      )}

      <button className="agent-chat-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-label={unread > 0 ? `Консоль агентов, ${unread} непрочитанных` : "Консоль агентов"} title="Консоль агентов">
        <Terminal size={11} />
        <span className="agent-chat-toggle-label">Консоль</span>
        {working.length > 0 && <i className="chat-dot state-working" />}
        {unread > 0 && <b>{unread}</b>}
      </button>
    </div>
  );
}
