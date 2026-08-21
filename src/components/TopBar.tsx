import { AlertTriangle, Search } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "./AgentAvatar";

export type AgentRosterEntry = {
  id: string;
  name: string;
  status: string;
  live: boolean;
  statusLabel: string;
  detail?: string;
  since?: string;
};

export type AttentionTodo = { id: string; title: string; status: string; projectId: string; projectName: string };

type TopBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  realtimeState?: "connecting" | "connected" | "thinking" | "working" | "attention" | "offline";
  realtimeLabel?: string;
  notice?: string;
  notices?: Array<{ id: string; text: string; at: string }>;
  roster?: AgentRosterEntry[];
  attentionTodos?: AttentionTodo[];
  onOpenTodo?: (projectId: string) => void;
};

const attentionStatusLabel: Record<string, string> = { blocked: "заблокирована", review: "на проверке" };

export function TopBar({
  query,
  onQueryChange,
  realtimeState = "connecting",
  realtimeLabel = "Агент подключается",
  notice = "",
  notices = [],
  roster = [],
  attentionTodos = [],
  onOpenTodo,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const online = roster.filter((agent) => agent.status === "active");
  const stack = (online.length ? online : roster).slice(0, 3);

  return (
    <header className="topbar">
      <div className="search-shell">
        <Search size={18} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Поиск" />
      </div>
      <button className={`realtime-pill monostatus ${realtimeState}`} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <img className="topbar-logo" src="/assets/icons/icons/logo.png" width={20} height={20} alt="" />
        {stack.length > 0 && (
          <span className="pill-avatars" aria-hidden="true">
            {stack.map((agent) => (
              <AgentAvatar key={agent.id} name={agent.name} status={agent.status} live={agent.live} size={22} />
            ))}
          </span>
        )}
        <strong className={realtimeLabel === "MBOX" ? "is-brand" : ""}>{realtimeLabel}</strong>
        {notice && <span>{notice}</span>}
      </button>
      {open && (
        <div className="agent-status-popover" role="dialog" aria-label="Статус агентов">
          {attentionTodos.length > 0 && (
            <section className="popover-section">
              <strong><AlertTriangle size={14} /> Требует внимания</strong>
              <ul className="attention-list">
                {attentionTodos.map((todo) => (
                  <li key={todo.id}>
                    <button type="button" onClick={() => { onOpenTodo?.(todo.projectId); setOpen(false); }}>
                      <span className={`attention-dot status-${todo.status}`} />
                      <span className="attention-body">
                        <span className="attention-title">{todo.title}</span>
                        <span className="attention-meta">{todo.projectName} · {attentionStatusLabel[todo.status] || todo.status}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="popover-section">
            <strong>Команда</strong>
            {roster.length ? (
              <ul className="agent-roster">
                {roster.map((agent) => (
                  <li className={`agent-roster-item ${agent.status}`} key={agent.id}>
                    <AgentAvatar name={agent.name} status={agent.status} live={agent.live} size={34} />
                    <div className="agent-roster-body">
                      <span className="agent-roster-name">{agent.name}</span>
                      <span className="agent-roster-detail">{agent.detail || agent.statusLabel}</span>
                    </div>
                    <div className="agent-roster-meta">
                      <span className={`agent-roster-state ${agent.live ? "working" : agent.status}`}>{agent.live ? "в работе" : agent.statusLabel}</span>
                      {agent.since && <time>{agent.since}</time>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p>Агенты пока не подключены</p>}
          </section>
          <section className="popover-section">
            <strong>Действия</strong>
            {notices.length ? (
              <div className="agent-status-list">
                {notices.map((item) => (
                  <div className="agent-status-item" key={item.id}>
                    <span>{item.text}</span>
                    <time>{item.at}</time>
                  </div>
                ))}
              </div>
            ) : <p>Агенты ещё ничего не меняли</p>}
          </section>
        </div>
      )}
    </header>
  );
}
