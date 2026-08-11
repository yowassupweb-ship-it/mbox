import { useEffect, useMemo, useState } from "react";
import {
  Avatar,
  ChatContainer,
  ConversationHeader,
  MainContainer,
  Message,
  MessageList,
  MessageSeparator,
  TypingIndicator,
} from "@chatscope/chat-ui-kit-react";
import { ArrowUp, MessageSquare, X } from "lucide-react";
import { agentIdentity } from "../../components/AgentAvatar";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { AgentActivity, AgentInboxItem, AgentRun } from "../../types";

const HUMAN = "Человек";
const CONVERSATION = new Set(["question", "answer", "agent_message", "chat"]);

/** Что агент делает прямо сейчас. Считается из живых сессий и присутствия, а не выдумывается. */
function agentState(agent: AgentActivity, runs: AgentRun[]) {
  const live = runs.find((run) => run.agent_name === agent.name && ["running", "doing"].includes(run.status));
  if (live) return { key: "working", label: "работает", detail: live.goal };
  if (agent.live_runs > 0) return { key: "working", label: "работает", detail: "" };
  if (agent.status === "active") return { key: "thinking", label: "на связи", detail: "ждёт задачу" };
  if (agent.status === "idle") return { key: "idle", label: "ожидает", detail: formatSince(agent.last_seen) };
  return { key: "offline", label: "отключён", detail: formatSince(agent.last_seen) };
}

/**
 * Чат с агентами на готовом ките @chatscope, перекрашенном под токены MBOX.
 *
 * Про скорость честно: постоянного соединения у агента нет. Но MCP-сервер теперь прицепляет
 * непрочитанные сообщения человека к ответу ЛЮБОГО вызова инструмента, поэтому агент видит
 * написанное на первом же своём действии, а не когда сам вспомнит заглянуть в ящик.
 */
export function AgentChat({ inbox, agents, runs, projectId, onSaved }: {
  inbox: AgentInboxItem[];
  agents: AgentActivity[];
  runs: AgentRun[];
  projectId?: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Array<{ id: string; body: string; sent?: boolean; failed?: boolean }>>([]);

  const conversation = useMemo(
    () => [...inbox].filter((item) => CONVERSATION.has(item.item_type)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-80),
    [inbox],
  );

  // Оптимистичное сообщение живёт, пока такое же не появится в ящике. Раньше оно исчезало
  // сразу после ответа сервера и возвращалось только после полной перезагрузки данных — отсюда мигание.
  const arrived = useMemo(() => new Set(conversation.map((item) => (item.body || item.title).trim())), [conversation]);
  const stillPending = pending.filter((item) => item.failed || !arrived.has(item.body.trim()));

  const states = useMemo(() => agents.map((agent) => ({ agent, state: agentState(agent, runs) })), [agents, runs]);
  const working = states.filter((entry) => entry.state.key === "working");
  const unread = inbox.filter((item) => item.status !== "done" && item.agent_name !== HUMAN).length;

  async function send() {
    const raw = text.trim();
    if (!raw) return;
    setText("");
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

  useEffect(() => {
    if (!pending.length) return;
    setPending((current) => current.filter((item) => item.failed || !arrived.has(item.body.trim())));
  }, [arrived, pending.length]);

  let lastDay = "";

  return (
    <div className="agent-chat">
      {open && (
        <div className="agent-chat-shell">
          <div className="chat-roster">
            <button className={target === "" ? "is-active" : ""} type="button" onClick={() => setTarget("")}>Всем</button>
            {states.map(({ agent, state }) => (
              <button
                key={agent.id}
                className={`${target === agent.name ? "is-active" : ""}`}
                type="button"
                onClick={() => setTarget(target === agent.name ? "" : agent.name)}
                title={state.detail}
              >
                <i className={`chat-dot state-${state.key}`} />
                {agent.name}
                <em>{state.label}</em>
              </button>
            ))}
            <button className="chat-close" type="button" onClick={() => setOpen(false)} aria-label="Свернуть"><X size={16} /></button>
          </div>

          <MainContainer responsive>
            <ChatContainer>
              <ConversationHeader>
                <ConversationHeader.Content
                  userName={target ? `Команда для ${target}` : "Конференция агентов"}
                  info={working.length ? `${working.map((entry) => entry.agent.name).join(", ")} в работе` : `${agents.length} агентов, никто не занят`}
                />
              </ConversationHeader>

              <MessageList
                autoScrollToBottom
                autoScrollToBottomOnMount
                scrollBehavior="auto"
                typingIndicator={working.length
                  ? <TypingIndicator content={`${working[0].agent.name}: ${working[0].state.detail || "работает"}`} />
                  : undefined}
              >
                {conversation.flatMap((item) => {
                  const mine = item.agent_name === HUMAN;
                  const day = item.created_at.slice(0, 10);
                  const rows = [];
                  if (day !== lastDay) {
                    rows.push(<MessageSeparator key={`sep-${item.id}`} content={day} />);
                    lastDay = day;
                  }
                  rows.push(
                    <Message
                      key={item.id}
                      model={{
                        message: item.body || item.title,
                        sentTime: formatSince(item.created_at),
                        sender: mine ? "Ты" : item.agent_name,
                        direction: mine ? "outgoing" : "incoming",
                        position: "single",
                      }}
                    >
                      {!mine && (
                        <Avatar name={item.agent_name}>
                          <span className="chat-avatar" style={{ background: agentIdentity(item.agent_name).accent }}>
                            {item.agent_name.slice(0, 2).toUpperCase()}
                          </span>
                        </Avatar>
                      )}
                      <Message.Header sender={mine ? "Ты" : item.agent_name} sentTime={formatSince(item.created_at)} />
                    </Message>,
                  );
                  return rows;
                })}

                {stillPending.map((item) => (
                  <Message
                    key={item.id}
                    className={item.failed ? "chat-failed" : item.sent ? "" : "chat-pending"}
                    model={{
                      message: item.body,
                      sentTime: item.failed ? "не отправлено" : item.sent ? "отправлено" : "отправляется",
                      sender: "Ты",
                      direction: "outgoing",
                      position: "single",
                    }}
                  >
                    <Message.Header sender="Ты" sentTime={item.failed ? "не отправлено" : item.sent ? "отправлено" : "отправляется"} />
                  </Message>
                ))}
              </MessageList>


            </ChatContainer>
          </MainContainer>

          <form
            className="chat-composer"
            onSubmit={(event) => { event.preventDefault(); void send(); }}
          >
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={target ? `Команда для ${target}` : "Написать всем агентам"}
              rows={1}
            />
            <button type="submit" disabled={!text.trim()} aria-label="Отправить">
              <ArrowUp size={18} strokeWidth={2.5} />
            </button>
          </form>
        </div>
      )}

      <button className="agent-chat-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        <MessageSquare size={17} />
        <span>Агенты</span>
        {working.length > 0 && <i className="chat-dot state-working" />}
        {unread > 0 && <b>{unread}</b>}
      </button>
    </div>
  );
}
