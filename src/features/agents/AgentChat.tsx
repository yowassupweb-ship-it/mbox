import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, MessageSquare, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { effectiveStatus, liveRunOf } from "../../lib/agents";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { AgentActivity, AgentInboxItem, AgentRun, Project } from "../../types";

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
export function AgentChat({ inbox, agents, runs, projects, projectId, onSaved }: {
  inbox: AgentInboxItem[];
  agents: AgentActivity[];
  runs: AgentRun[];
  projects: Project[];
  projectId?: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyPos, setHistoryPos] = useState(-1);
  const [localLines, setLocalLines] = useState<LogLine[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; body: string; sent?: boolean; failed?: boolean }>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const conversation = useMemo(
    () => [...inbox].filter((item) => CONVERSATION.has(item.item_type)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-80),
    [inbox],
  );

  const arrived = useMemo(() => new Set(conversation.map((item) => (item.body || item.title).trim())), [conversation]);
  const stillPending = pending.filter((item) => item.failed || !arrived.has(item.body.trim()));

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

    const body = target ? `@${target} ${raw}` : raw;
    const localId = `local-${Date.now()}`;
    setPending((current) => [...current, { id: localId, body, sent: false }]);

    try {
      await fetchJson("/api/mbox/agent/inbox", {
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
          props: target ? { to: target } : {},
        }),
      });
      // Помечаем отправленным сразу. Ждать onSaved нельзя: он тянет одиннадцать ручек
      // через туннель к боевой базе, и «отправляется» висело бы секундами.
      setPending((current) => current.map((item) => item.id === localId ? { ...item, sent: true } : item));
      onSaved();
    } catch {
      setPending((current) => current.map((item) => item.id === localId ? { ...item, failed: true } : item));
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); void send(); return; }
    if (event.key === "ArrowUp" && history.length) {
      event.preventDefault();
      const next = historyPos < 0 ? history.length - 1 : Math.max(0, historyPos - 1);
      setHistoryPos(next);
      setText(history[next]);
      return;
    }
    if (event.key === "ArrowDown" && historyPos >= 0) {
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
            <span className="console-dot r" />
            <span className="console-dot y" />
            <span className="console-dot g" />
            <span className="console-title">mbox — консоль агентов</span>
            <button className="chat-close" type="button" onClick={() => setOpen(false)} aria-label="Свернуть"><X size={15} /></button>
          </div>

          <div className="chat-roster">
            <button className={target === "" ? "is-active" : ""} type="button" onClick={() => setTarget("")}>всем</button>
            {states.map(({ agent, state }) => (
              <button
                key={agent.id}
                className={target === agent.name ? "is-active" : ""}
                type="button"
                onClick={() => setTarget(target === agent.name ? "" : agent.name)}
                title={state.detail}
              >
                <AgentAvatar name={agent.name} status={agent.status} live={state.key === "working"} size={16} />
                {agent.name}
              </button>
            ))}
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
                    <span className="console-log-time">{time}</span>
                    {line.kind === "in" && <AgentAvatar name={line.actor} size={16} />}
                    <span className="console-log-actor">
                      {line.kind === "cmd" ? "$" : line.kind === "sys" ? "mbox" : line.kind === "out" ? "ты" : line.actor}
                      <ChevronRight size={11} />
                    </span>
                    <span className="console-log-text">
                      {line.text}
                      {line.pending === "sending" && <em className="console-log-status"> отправляется…</em>}
                      {line.pending === "failed" && <em className="console-log-status failed"> не отправлено</em>}
                    </span>
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
          </div>

          <form className="console-input-row" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <span className="console-prompt">{target ? `@${target}` : "~"}$</span>
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={target ? `команда или сообщение для ${target}` : "команда (/help) или сообщение всем"}
              spellCheck={false}
              autoComplete="off"
            />
          </form>
        </div>
      )}

      <button className="agent-chat-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-label={unread > 0 ? `Чат с агентами, ${unread} непрочитанных` : "Чат с агентами"} title="Чат с агентами">
        <MessageSquare size={17} />
        <span>Агенты</span>
        {working.length > 0 && <i className="chat-dot state-working" />}
        {unread > 0 && <b>{unread}</b>}
      </button>
    </div>
  );
}
