import { useCallback, useEffect, useState } from "react";
import { AuthError, fetchOr } from "../lib/api";
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

export function useMboxData(query: string, onAuthExpired?: () => void) {
  const [memories, setMemories] = useState<Memory[]>([]);
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
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    let failed = 0;
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";

    // Одна упавшая ручка не должна гасить экран, но если легли все — это уже потеря связи, и об этом надо сказать.
    async function load<T>(input: string, fallback: T): Promise<T> {
      const value = await fetchOr<T | null>(input, null);
      if (value === null) {
        failed += 1;
        return fallback;
      }
      return value;
    }

    Promise.all([
      load<{ memories: Memory[] }>(`/api/mbox/memories${qs}`, { memories: [] }),
      load<{ artifacts: Artifact[] }>(`/api/mbox/artifacts${qs}`, { artifacts: [] }),
      load<{ projects: Project[] }>(`/api/mbox/projects${qs}`, { projects: [] }),
      load<{ companies: Company[] }>(`/api/mbox/companies${qs}`, { companies: [] }),
      load<{ folders: FolderRow[] }>(`/api/mbox/folders${qs}`, { folders: [] }),
      load<{ secrets: SecretSummary[] }>(`/api/mbox/secrets${qs}`, { secrets: [] }),
      load<{ events: AuditEvent[] }>(`/api/mbox/history${qs}`, { events: [] }),
      load<{ agents: AgentActivity[] }>("/api/mbox/agents", { agents: [] }),
      load<{ edges: GraphEdge[] }>("/api/mbox/graph/edges", { edges: [] }),
      load<{ inbox: AgentInboxItem[] }>("/api/mbox/agent/inbox", { inbox: [] }),
      load<{ runs: AgentRun[] }>("/api/mbox/agent/runs", { runs: [] }),
      load<{ decisions: DecisionEntry[] }>(`/api/mbox/decisions${qs}`, { decisions: [] }),
    ])
      .then(([memoryData, artifactData, projectData, companyData, folderData, secretData, historyData, agentData, edgeData, inboxData, runsData, decisionData]) => {
        if (!alive) return;
        setMemories(memoryData.memories);
        setArtifacts(artifactData.artifacts);
        setProjects(projectData.projects);
        setCompanies(companyData.companies);
        setFolders(folderData.folders);
        setSecrets(secretData.secrets);
        setAuditEvents(historyData.events);
        setAgents(agentData.agents);
        setGraphEdges(edgeData.edges);
        setInbox(inboxData.inbox);
        setRuns(runsData.runs);
        setDecisions(decisionData.decisions);
        setOffline(failed === 12);
        setLoading(false);
      })
      .catch((cause) => {
        if (!alive) return;
        if (cause instanceof AuthError) {
          onAuthExpired?.();
          return;
        }
        setOffline(true);
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [query, revision, onAuthExpired]);

  return { memories, artifacts, projects, companies, folders, secrets, auditEvents, agents, graphEdges, inbox, runs, decisions, loading, offline, reload };
}
