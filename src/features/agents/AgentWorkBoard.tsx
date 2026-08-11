import { AgentAvatar, agentIdentity } from "../../components/AgentAvatar";
import { baseName, formatSince } from "../../lib/format";
import { agentStatusLabels, runStatusLabels } from "../../lib/labels";
import type { AgentActivity, AgentInboxItem, AgentRun, DecisionEntry } from "../../types";
import { EmptyState } from "../../ui";

function ActivityBars() {
  return (
    <span className="activity-bars" aria-hidden="true">
      <span /><span /><span /><span />
    </span>
  );
}

function AgentCard({ agent, runs, decisions }: { agent: AgentActivity; runs: AgentRun[]; decisions: DecisionEntry[] }) {
  const mine = runs.filter((run) => run.agent_name === agent.name);
  const liveRun = mine.find((run) => ["running", "doing"].includes(run.status));
  const lastRun = liveRun || mine[0];
  const lastDecision = decisions.find((decision) => decision.actor === agent.name);
  const files = (Array.isArray(lastRun?.touched_files) ? (lastRun!.touched_files as string[]) : []).slice(0, 5);
  const working = agent.live_runs > 0;
  const stateKey = working ? "working" : agent.status;
  const stateLabel = working ? "в работе" : agentStatusLabels[agent.status] || agent.status;

  return (
    <article className={`agent-card ${stateKey}`} style={{ ["--agent-accent" as string]: agentIdentity(agent.name).accent }}>
      <div className="agent-card-top">
        <AgentAvatar name={agent.name} status={agent.status} live={working} size={46} />
        <div className="agent-card-id">
          <strong>{agent.name}</strong>
          <span>{agent.kind}{agent.client ? ` · ${agent.client}` : ""}</span>
        </div>
        <span className={`agent-card-state ${stateKey}`}>{stateLabel}</span>
      </div>

      <div className="agent-card-now">
        {working && <ActivityBars />}
        <span className={working ? "agent-card-goal live" : "agent-card-goal"}>
          {lastRun ? (working ? lastRun.goal : `последнее: ${lastRun.goal}`) : "нет активности"}
        </span>
      </div>

      {files.length > 0 && (
        <div className="agent-card-files">
          {files.map((file) => <code key={file} title={file}>{baseName(file)}</code>)}
        </div>
      )}

      <div className="agent-card-metrics">
        <div className="metric"><b>{agent.runs}</b><span>сессий</span></div>
        <div className="metric"><b>{agent.events}</b><span>действий</span></div>
        <div className="metric"><b>{agent.active_sessions}</b><span>подключений</span></div>
      </div>

      <div className="agent-card-foot">
        {lastDecision ? <span className="agent-card-decision" title={lastDecision.title}>◆ {lastDecision.title}</span> : <span className="agent-card-decision muted">решений нет</span>}
        <time>{formatSince(agent.last_seen)}</time>
      </div>
    </article>
  );
}

function StreamRow({ actor, title, tag }: { actor: string; title: string; tag?: string }) {
  return (
    <div className="stream-row">
      <AgentAvatar name={actor} size={24} />
      <div className="stream-row-body">
        <span className="stream-row-actor">{actor}{tag ? <em> · {tag}</em> : null}</span>
        <span className="stream-row-title" title={title}>{title}</span>
      </div>
    </div>
  );
}

export function AgentWorkBoard({ agents, runs, inbox, decisions }: { agents: AgentActivity[]; runs: AgentRun[]; inbox: AgentInboxItem[]; decisions: DecisionEntry[] }) {
  const online = agents.filter((agent) => agent.status === "active").length;
  const working = agents.filter((agent) => agent.live_runs > 0).length;
  const activeRuns = runs.filter((run) => ["running", "doing"].includes(run.status));
  const visibleRuns = (activeRuns.length ? activeRuns : runs).slice(0, 5);
  const openInbox = inbox.filter((item) => item.status !== "done").slice(0, 5);

  return (
    <section className="agent-activity" aria-label="Работа агентов">
      <header className="agent-activity-head">
        <h3>Работа агентов</h3>
        <div className="agent-activity-summary">
          <span><b>{agents.length}</b> агентов</span>
          <span className="dot-sep" />
          <span className="tone-active"><b>{online}</b> на связи</span>
          {working > 0 && <span className="tone-working"><b>{working}</b> в работе</span>}
        </div>
      </header>

      {agents.length ? (
        <div className="agent-cards">
          {agents.slice(0, 8).map((agent) => (
            <AgentCard key={agent.id} agent={agent} runs={runs} decisions={decisions} />
          ))}
        </div>
      ) : <EmptyState text="Агенты пока не подключены" />}

      <div className="agent-streams">
        <div className="agent-stream">
          <h4>Сессии</h4>
          {visibleRuns.length ? visibleRuns.map((run) => (
            <StreamRow key={run.id} actor={run.agent_name} title={run.goal} tag={runStatusLabels[run.status] || run.status} />
          )) : <EmptyState text="Сессий пока нет" />}
        </div>
        <div className="agent-stream">
          <h4>Inbox</h4>
          {openInbox.length ? openInbox.map((item) => (
            <StreamRow key={item.id} actor={item.agent_name} title={item.title} tag={item.requires_human ? "нужен человек" : undefined} />
          )) : <EmptyState text="Входящие пусты" />}
        </div>
        <div className="agent-stream">
          <h4>Решения</h4>
          {decisions.length ? decisions.slice(0, 5).map((decision) => (
            <StreamRow key={decision.id} actor={decision.actor} title={decision.title} />
          )) : <EmptyState text="Решений пока нет" />}
        </div>
      </div>
    </section>
  );
}
