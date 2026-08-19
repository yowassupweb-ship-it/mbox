import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AtSign, ChevronRight, DollarSign, Hash, Slash, Terminal, Wrench, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { effectiveStatus, liveRunOf } from "../../lib/agents";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { AgentActivity, AgentInboxItem, AgentRun, Artifact, Project } from "../../types";

const JARVIS_NAME = "Джарвис";

const SLASH_COMMANDS = [
  { value: "help", hint: "эта справка" },
  { value: "status", hint: "кто сейчас на связи" },
  { value: "agents", hint: "кто сейчас на связи" },
  { value: "blocked", hint: "задачи, которые ждут решения" },
  { value: "who", hint: "что известно про агента" },
  { value: "clear", hint: "очистить окно" },
];

const TRIGGER_ICON = { "@": AtSign, "/": Slash, "$": DollarSign, "#": Hash } as const;

type Suggestion = { value: string; hint?: string };

/** Ведущее @Имя в начале сообщения — раньше был отдельный ростер кнопок для выбора адресата,
 * теперь то же самое просто печатается в тексте (см. подсказки по @) и парсится отсюда. */
function parseMention(raw: string): string {
  const match = raw.trim().match(/^@(\S+)/);
  return match ? match[1] : "";
}

const MARKDOWN_TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<!\w)_[^_\n]+_(?!\w))/g;

/** Модель (например, Джарвис) иногда шлёт **bold**/`code`/*italic* и списки — раньше это лежало
 * в логе буквальными звёздочками. Без внешней библиотеки: разбор построчно + инлайн-токены. */
function renderMarkdownLite(text: string): ReactNode {
  return text.split("\n").map((line, lineIndex, lines) => {
    const isListItem = /^\s*[-*]\s/.test(line);
    const content = isListItem ? line.replace(/^\s*[-*]\s/, "") : line;
    const parts = content.split(MARKDOWN_TOKEN).filter((part) => part !== "");
    const rendered = parts.map((part, partIndex) => {
      const key = `${lineIndex}-${partIndex}`;
      if (part.startsWith("**") && part.endsWith("**")) return <b key={key}>{part.slice(2, -2)}</b>;
      if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
      if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
      if (part.startsWith("_") && part.endsWith("_")) return <em key={key}>{part.slice(1, -1)}</em>;
      return part;
    });
    return (
      <span key={lineIndex}>
        {isListItem ? "• " : ""}
        {rendered}
        {lineIndex < lines.length - 1 && <br />}
      </span>
    );
  });
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
  if (status === "active") return { key: "thinking", label: "на связи", detail: "ждёт задачу" };
  if (status === "idle") return { key: "idle", label: "ожидает", detail: formatSince(agent.last_seen) };
  return { key: "offline", label: "отключён", detail: formatSince(agent.last_seen) };
}

type LogLine = {
  id: string;
  kind: "in" | "out" | "sys" | "cmd";
  actor: string;
  text: string;
  at: string;
  pending?: "sending" | "sent" | "failed";
  toolsUsed?: string[];
};

/**
 * Чат — настоящая консоль, не мессенджер: моноширинный лог строк вместо пузырей, слэш-команды
 * работают локально (без похода в MCP-очередь), обычный текст уходит агентам как раньше.
 *
 * Про скорость честно: постоянного соединения у агента нет. Но MCP-сервер прицепляет
 * непрочитанные сообщения человека к ответу ЛЮБОГО вызова инструмента, поэтому агент видит
 * написанное на первом же своём действии — и теперь не теряет его, пока реально не ответит
 * (см. pendingMessages в scripts/mbox-mcp-server.mjs).
 */
export function AgentChat({ inbox, agents, runs, projects, artifacts, projectId, onSaved }: {
  inbox: AgentInboxItem[];
  agents: AgentActivity[];
  runs: AgentRun[];
  projects: Project[];
  artifacts: Artifact[];
  projectId?: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
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
      return;
    }
    const timeout = window.setTimeout(() => { setAwaitingJarvisId(null); setAwaitingJarvisSince(null); }, 25000);
    return () => window.clearTimeout(timeout);
  }, [awaitingJarvisId, conversation]);

  // Секунды в "думает…" — раньше плашка просто висела без обратной связи, сколько ещё ждать.
  useEffect(() => {
    if (!awaitingJarvisSince) return;
    const interval = window.setInterval(() => setElapsedTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [awaitingJarvisSince]);

  const awaitingJarvisSeconds = awaitingJarvisSince ? Math.max(0, Math.floor((Date.now() - awaitingJarvisSince) / 1000)) : 0;

  const states = useMemo(() => agents.map((agent) => ({ agent, state: agentState(agent, runs) })), [agents, runs]);
  const working = states.filter((entry) => entry.state.key === "working");

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

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, lines.length]);

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
      case "clear":
        setLocalLines([]);
        setPending([]);
        return;
      default:
        pushLocal("sys", `неизвестная команда: /${cmd} — попробуй /help`);
    }
  }

  async function send() {
    const raw = text.trim();
    if (!raw) return;
    setHistory((current) => [...current, raw]);
    setHistoryPos(-1);
    setText("");

    if (raw.startsWith("/")) {
      runCommand(raw);
      return;
    }

    const body = raw;
    const mentionTarget = parseMention(raw);
    const localId = `local-${Date.now()}`;
    setPending((current) => [...current, { id: localId, body, sent: false }]);

    try {
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
          props: mentionTarget ? { to: mentionTarget } : {},
        }),
      });
      // Джарвис отвечает и на нетегнутые сообщения (см. scripts/mbox-archivist.mjs), поэтому
      // индикатор "думает" уместен если адресат не указан или это явно он.
      if ((!mentionTarget || mentionTarget.toLowerCase() === JARVIS_NAME.toLowerCase()) && result.inbox_item?.id) {
        setAwaitingJarvisId(result.inbox_item.id);
        setAwaitingJarvisSince(Date.now());
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
        <div className="agent-chat-shell console">
          <div className="console-bar">
            <button className="chat-close" type="button" onClick={() => setOpen(false)} aria-label="Свернуть"><X size={15} /></button>
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
                <span className="console-log-actor">·</span>
                <span className="console-log-text">{JARVIS_NAME} думает… {awaitingJarvisSeconds}с</span>
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
              <span className="console-prompt">{liveMention && `@${liveMention}`}<ChevronRight size={13} /></span>
              <textarea
                ref={composerRef}
                value={text}
                onChange={(event) => { setText(event.target.value); setCursor(event.target.selectionStart); }}
                onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                placeholder="команда (/help), @агент, $проект, #артефакт — Shift+Enter для новой строки"
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
