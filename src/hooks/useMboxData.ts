import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "../lib/api";
import { sumBytes } from "../lib/format";
import type {
  AgentActivity,
  AgentInboxItem,
  AgentRun,
  Artifact,
  AuditEvent,
  Company,
  DecisionEntry,
  FolderRow,
  GraphEdge,
  Memory,
  Project,
  SecretSummary,
} from "../types";

export type MboxData = ReturnType<typeof useMboxData>;

type Key = "memories" | "artifacts" | "projects" | "companies" | "folders" | "secrets" | "history" | "agents" | "edges" | "inbox" | "runs" | "decisions";

const ALL_KEYS: Key[] = ["memories", "artifacts", "projects", "companies", "folders", "secrets", "history", "agents", "edges", "inbox", "runs", "decisions"];

/**
 * Что перечитать на событие realtime. Раньше любое изменение (агент ответил в чате, сменил фазу,
 * записал память) перезагружало все 12 ручек — ~2 МБ JSON и секунды запросов на каждое событие,
 * а агенты пишут постоянно. Неизвестная сущность — перечитываем всё.
 */
const ENTITY_KEYS: Record<string, Key[]> = {
  agent_inbox: ["inbox", "history"],
  agent_runs: ["runs", "agents", "history"],
  agent_presence: ["agents", "runs"],
  artifacts: ["artifacts", "history"],
  companies: ["companies", "projects"],
  data_sources: ["projects"],
  decision_log: ["decisions"],
  folders: ["folders"],
  graph_edges: ["edges", "projects"],
  memories: ["memories", "history"],
  projects: ["projects", "history"],
  secrets: ["secrets"],
  todos: ["projects", "history"],
};

// Между перечитываниями — не чаще, чем раз в столько; события за это время копятся в одну пачку.
const MIN_GAP_MS = 1500;
const URGENT_ENTITIES = new Set(["agent_inbox", "agent_presence"]);

function urlFor(key: Key, qs: string) {
  switch (key) {
    case "memories": return `/api/mbox/memories${qs}`;
    case "artifacts": return `/api/mbox/artifacts${qs}`;
    case "projects": return `/api/mbox/projects${qs}`;
    case "companies": return `/api/mbox/companies${qs}`;
    case "folders": return `/api/mbox/folders${qs}`;
    case "secrets": return `/api/mbox/secrets${qs}`;
    case "history": return `/api/mbox/history${qs}`;
    case "agents": return "/api/mbox/agents";
    case "edges": return "/api/mbox/graph/edges";
    case "inbox": return "/api/mbox/agent/inbox?limit=120";
    case "runs": return "/api/mbox/agent/runs";
    case "decisions": return `/api/mbox/decisions${qs}`;
  }
}

export function useMboxData(query: string, onAuthExpired?: () => void) {
  const [memories, setMemories] = useState<Memory[]>([]);
  // Отдельно от memories.length/memory_bytes-суммы — те всегда упираются в LIMIT 300 ответа,
  // а тут настоящие числа по всем подходящим записям (см. count(*) OVER() в ручке).
  const [memoriesTotal, setMemoriesTotal] = useState(0);
  const [memoriesTotalBytes, setMemoriesTotalBytes] = useState(0);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [agents, setAgents] = useState<AgentActivity[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [inbox, setInbox] = useState<AgentInboxItem[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const onAuthExpiredRef = useRef(onAuthExpired);
  onAuthExpiredRef.current = onAuthExpired;
  const pump = useRef({
    pending: new Set<Key>(),
    running: false,
    lastStart: 0,
    timer: 0,
    // Сырой текст последнего ответа: не изменился — не парсим и не трогаем состояние, а значит
    // и всё рабочее место не перерисовывается от пустого события.
    raw: new Map<Key, string>(),
    qs: "",
    alive: true,
  });

  const apply = useCallback((key: Key, value: unknown) => {
    switch (key) {
      case "memories": {
        const data = value as { memories: Memory[]; total?: number; total_bytes?: number };
        setMemories(data.memories);
        setMemoriesTotal(data.total ?? data.memories.length);
        setMemoriesTotalBytes(data.total_bytes ?? sumBytes(data.memories.map((m) => m.memory_bytes)));
        break;
      }
      case "artifacts": setArtifacts((value as { artifacts: Artifact[] }).artifacts); break;
      case "projects": setProjects((value as { projects: Project[] }).projects); break;
      case "companies": setCompanies((value as { companies: Company[] }).companies); break;
      case "folders": setFolders((value as { folders: FolderRow[] }).folders); break;
      case "secrets": setSecrets((value as { secrets: SecretSummary[] }).secrets); break;
      case "history": setAuditEvents((value as { events: AuditEvent[] }).events); break;
      case "agents": setAgents((value as { agents: AgentActivity[] }).agents); break;
      case "edges": setGraphEdges((value as { edges: GraphEdge[] }).edges); break;
      case "inbox": setInbox((value as { inbox: AgentInboxItem[] }).inbox); break;
      case "runs": setRuns((value as { runs: AgentRun[] }).runs); break;
      case "decisions": setDecisions((value as { decisions: DecisionEntry[] }).decisions); break;
    }
  }, []);

  const run = useCallback(async () => {
    const state = pump.current;
    if (state.running || !state.pending.size || !state.alive) return;
    // Скрытое окно (свёрнуто, другая вкладка) ничего не качает — изменения дождутся, пока его покажут.
    if (document.hidden) return;
    const wait = MIN_GAP_MS - (Date.now() - state.lastStart);
    if (wait > 0) {
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => void run(), wait);
      return;
    }
    const keys = [...state.pending];
    state.pending.clear();
    state.running = true;
    state.lastStart = Date.now();
    const qs = state.qs;
    let failed = 0;
    try {
      await Promise.all(keys.map(async (key) => {
        let text: string;
        try {
          const response = await fetch(urlFor(key, qs));
          if (response.status === 401) throw new AuthError();
          if (!response.ok) { failed += 1; return; }
          text = await response.text();
        } catch (cause) {
          if (cause instanceof AuthError) throw cause;
          failed += 1;
          return;
        }
        if (!state.alive || qs !== state.qs) return;
        if (state.raw.get(key) === text) return;
        try {
          apply(key, JSON.parse(text));
          state.raw.set(key, text);
        } catch {
          failed += 1;
        }
      }));
      if (state.alive) {
        // Одна упавшая ручка не должна гасить экран, но если легли все запрошенные — это потеря связи.
        setOffline(failed > 0 && failed === keys.length);
        setLoading(false);
      }
    } catch (cause) {
      if (cause instanceof AuthError) onAuthExpiredRef.current?.();
      else if (state.alive) { setOffline(true); setLoading(false); }
    } finally {
      state.running = false;
      if (state.pending.size) void run();
    }
  }, [apply]);

  /** Перечитать данные: без аргумента — всё, с сущностью из realtime — только то, что она затрагивает. */
  // Аргумент нестрогий: reload вешают и прямо на onClick — событие мыши значит «всё».
  const reload = useCallback((entity?: unknown) => {
    const keys = typeof entity === "string" ? ENTITY_KEYS[entity] ?? ALL_KEYS : ALL_KEYS;
    keys.forEach((key) => pump.current.pending.add(key));
    // Явное «перечитать» (после сохранения, кнопка) — сразу; паузой сглаживаем только поток событий.
    if (typeof entity !== "string" || URGENT_ENTITIES.has(entity)) pump.current.lastStart = 0;
    void run();
  }, [run]);

  useEffect(() => {
    const state = pump.current;
    state.alive = true;
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    // StrictMode в dev монтирует эффект дважды: вторая постановка всех 12 ручек, пока первая волна ещё
    // в пути, давала второй такой же пакет (~10 МБ). Через туннель к базе и лимит в 6 соединений HTTP/1.1
    // у vite это держало в очереди остальные запросы окна — заметки открывались по полминуты.
    if (state.running && state.qs === qs) return;
    state.qs = qs;
    state.raw.clear();
    ALL_KEYS.forEach((key) => state.pending.add(key));
    // Смена запроса — сразу, без паузы между перечитываниями.
    state.lastStart = 0;
    void run();
  }, [query, run]);

  useEffect(() => {
    const state = pump.current;
    const onVisible = () => { if (!document.hidden) void run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      state.alive = false;
      window.clearTimeout(state.timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run]);

  return { memories, memoriesTotal, memoriesTotalBytes, artifacts, projects, companies, folders, secrets, auditEvents, agents, graphEdges, inbox, runs, decisions, loading, offline, reload };
}
