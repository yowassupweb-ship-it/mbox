import type { AgentActivity, AgentRun } from "../types";

/**
 * Живость агента считается по свежести сердцебиения, а не по колонке status.
 *
 * Сессия agent_runs остаётся в статусе running навсегда, если агент упал или его просто закрыли:
 * finished_at никто не проставит. Из-за этого в шапке и в чате месяцами висела цель древнего запуска
 * («Фальшивый статус агента в хедере»), выдаваемая за то, чем агент занят прямо сейчас.
 * Поэтому запуск считается живым только пока по нему стучит heartbeat.
 */
export const RUN_STALE_MS = 10 * 60 * 1000;
export const PRESENCE_STALE_MS = 10 * 60 * 1000;

function freshness(value: string | null | undefined) {
  if (!value) return Number.POSITIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : Date.now() - at;
}

export function isRunLive(run: AgentRun) {
  if (run.finished_at) return false;
  if (!["running", "doing"].includes(run.status)) return false;
  return freshness(run.heartbeat_at || run.started_at) < RUN_STALE_MS;
}

/** Самый свежий живой запуск агента: если их несколько, честнее показать последний, а не первый попавшийся. */
export function liveRunOf(runs: AgentRun[], agentName: string) {
  return runs
    .filter((run) => run.agent_name === agentName && isRunLive(run))
    .sort((a, b) => freshness(a.heartbeat_at || a.started_at) - freshness(b.heartbeat_at || b.started_at))[0];
}

export function liveRuns(runs: AgentRun[]) {
  return runs.filter(isRunLive);
}

/** Присутствие тоже протухает: agent_presence обновляется пингом, но запись остаётся и после ухода агента. */
export function effectiveStatus(agent: AgentActivity) {
  const age = freshness(agent.last_seen);
  if (age >= PRESENCE_STALE_MS) return "offline";
  return agent.status;
}

export function isAgentWorking(agent: AgentActivity, runs: AgentRun[]) {
  return Boolean(liveRunOf(runs, agent.name));
}
