import { AgentAvatar, agentIdentity } from "../../components/AgentAvatar";
import { agentFamily, effectiveStatus, isAgentWorking, liveRunOf, liveRuns } from "../../lib/agents";
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

/** Схлопывает варианты одной семьи (Codex, "Codex smoke #132", "Codex debug #132", ...) в одну
 * карточку: самая свежая по last_seen как основа, счётчики суммируются по всем именам семьи. */
function groupAgentsByFamily(agents: AgentActivity[]): Array<{ agent: AgentActivity; displayName: string; memberNames: string[] }> {
  const groups = new Map<string, AgentActivity[]>();
  for (const agent of agents) {
    const family = agentFamily(agent.name);
    if (!family) continue;
    const list = groups.get(family.key) || [];
    list.push(agent);
    groups.set(family.key, list);
  }
  return [...groups.entries()].map(([key, members]) => {
    const label = agentFamily(members[0].name)!.label;
    const newest = [...members].sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""))[0];
    const merged: AgentActivity = {
      ...newest,
      name: label,
      active_sessions: members.reduce((sum, m) => sum + m.active_sessions, 0),
      events: members.reduce((sum, m) => sum + m.events, 0),
      runs: members.reduce((sum, m) => sum + m.runs, 0),
      live_runs: members.reduce((sum, m) => sum + m.live_runs, 0),
    };
    return { agent: merged, displayName: label, memberNames: members.map((m) => m.name) };
  });
}

function AgentCard({ agent, memberNames, runs, decisions, inbox }: { agent: AgentActivity; memberNames: string[]; runs: AgentRun[]; decisions: DecisionEntry[]; inbox: AgentInboxItem[] }) {
  const mine = runs.filter((run) => memberNames.includes(run.agent_name));
  const live = memberNames.map((name) => liveRunOf(runs, name)).find(Boolean);
  const lastRun = live || mine[0];
  const lastDecision = decisions.find((decision) => memberNames.includes(decision.actor));
  const files = (Array.isArray(lastRun?.touched_files) ? (lastRun!.touched_files as string[]) : []).slice(0, 5);
  const working = Boolean(live);
  const status = effectiveStatus(agent);
  const stateKey = working ? "working" : status;
  const stateLabel = working ? "в работе" : agentStatusLabels[status] || status;
  // Джарвис (и любой другой лёгкий агент без agent_runs) не заводит сессии — его единица работы
  // это ответ во входящих, а не run. Без этого карточка всегда показывала «нет активности»,
  // даже если агент только что ответил на что-то.
  const lastInbox = !lastRun ? inbox.find((item) => memberNames.includes(item.agent_name)) : undefined;

  return (
    <article className={`agent-card ${stateKey}`} style={{ ["--agent-accent" as string]: agentIdentity(agent.name).accent }}>
      <div className="agent-card-top">
        <AgentAvatar name={agent.name} status={status} live={working} size={46} />
        <div className="agent-card-id">
          <strong>{agent.name}</strong>
          <span>{agent.kind}{agent.client ? ` · ${agent.client}` : ""}</span>
        </div>
        <span className={`agent-card-state ${stateKey}`}>{stateLabel}</span>
      </div>

      <div className="agent-card-now">
        {working && <ActivityBars />}
        <span className={working ? "agent-card-goal live" : "agent-card-goal"}>
          {lastRun ? (working ? lastRun.goal : `последнее: ${lastRun.goal}`)
            : lastInbox ? `последнее: ${lastInbox.title}`
            : "нет активности"}
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
  const grouped = groupAgentsByFamily(agents);
  const online = grouped.filter(({ agent }) => effectiveStatus(agent) === "active").length;
  const working = grouped.filter(({ agent }) => isAgentWorking(agent, runs)).length;
  const activeRuns = liveRuns(runs);
  const visibleRuns = (activeRuns.length ? activeRuns : runs).slice(0, 5);
  const openInbox = inbox.filter((item) => item.status !== "done").slice(0, 5);

  return (
    <section className="agent-activity" aria-label="Работа агентов">
      <header className="agent-activity-head">
        <h3>Работа агентов</h3>
        <div className="agent-activity-summary">
          <span><b>{grouped.length}</b> агентов</span>
          <span className="dot-sep" />
          <span className="tone-active"><b>{online}</b> на связи</span>
          {working > 0 && <span className="tone-working"><b>{working}</b> в работе</span>}
        </div>
      </header>

      {grouped.length ? (
        <div className="agent-cards">
          {grouped.map(({ agent, memberNames }) => (
            <AgentCard key={agent.name} agent={agent} memberNames={memberNames} runs={runs} decisions={decisions} inbox={inbox} />
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
