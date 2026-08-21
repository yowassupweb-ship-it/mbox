import type { CSSProperties } from "react";
import { BookOpen, ClipboardCheck, FolderKanban, HelpCircle } from "lucide-react";
import { AgentWorkBoard } from "../features/agents/AgentWorkBoard";
import { NeedsAnswer } from "../features/agents/NeedsAnswer";
import { ReviewQueue } from "../features/projects/ReviewQueue";
import type { MboxData } from "../hooks/useMboxData";
import { formatBytes, sumBytes } from "../lib/format";
import type { Artifact, Memory, Project } from "../types";
import { EmptyState, Metric, MetricGrid, Panel } from "../ui";

const BOTTOM_ICONS = "/assets/icons/bottom-menu";
const ENTITY_ICONS = "/assets/icons/icons";

export function Overview({ data }: { data: MboxData }) {
  const totalBytes = sumBytes([
    ...data.memories.map((item) => item.memory_bytes),
    ...data.artifacts.map((item) => item.memory_bytes),
    ...data.projects.map((item) => item.memory_bytes),
    ...data.secrets.map((item) => item.memory_bytes),
  ]);

  const reviewCount = data.projects.reduce((sum, project) => sum + project.todos.filter((todo) => todo.status === "review").length, 0);
  const needsCount = data.inbox.filter((item) => item.requires_human && item.status !== "done").length;

  return (
    <>
      {needsCount > 0 && (
        <Panel title={`Требуют твоего ответа · ${needsCount}`} icon={HelpCircle} className="needs-panel">
          <NeedsAnswer inbox={data.inbox} onSaved={data.reload} />
        </Panel>
      )}
      <MetricGrid>
        <Metric title="Память" value={data.memories.length} subtitle={formatBytes(totalBytes)} image={`${BOTTOM_ICONS}/память.png`} />
        <Metric title="Артефакты" value={data.artifacts.length} subtitle={formatBytes(sumBytes(data.artifacts.map((item) => item.memory_bytes)))} image={`${BOTTOM_ICONS}/артефакты.png`} />
        <Metric title="Проекты" value={data.projects.length} subtitle={formatBytes(sumBytes(data.projects.map((item) => item.memory_bytes)))} image={`${BOTTOM_ICONS}/проекты.png`} />
        <Metric title="Секреты" value={data.secrets.length} subtitle={formatBytes(sumBytes(data.secrets.map((item) => item.memory_bytes)))} image={`${ENTITY_ICONS}/дсотуп.png`} />
      </MetricGrid>
      {reviewCount > 0 && (
        <Panel title={`На проверке · ${reviewCount}`} icon={ClipboardCheck} className="review-panel">
          <ReviewQueue projects={data.projects} onSaved={data.reload} />
        </Panel>
      )}
      <div className="content-grid overview-grid">
        <Panel title="Последние сущности" icon={BookOpen}>
          <EntityFeed memories={data.memories} projects={data.projects} artifacts={data.artifacts} />
        </Panel>
        <Panel title="Проекты" icon={FolderKanban}>
          <ProjectList projects={data.projects.slice(0, 5)} />
        </Panel>
      </div>
      <AgentWorkBoard agents={data.agents} runs={data.runs} inbox={data.inbox} decisions={data.decisions} />
    </>
  );
}

function EntityFeed({ memories, projects, artifacts }: { memories: Memory[]; projects: Project[]; artifacts: Artifact[] }) {
  const projectNames = new Set(projects.map((project) => project.name.toLowerCase()));
  const seen = new Set<string>();
  const rows = [
    ...memories
      .filter((item) => !projectNames.has(item.title.replace(/^Проект\s+/i, "").toLowerCase()))
      .map((item) => ({ key: `memory-${item.id}`, title: item.title, text: item.content, bytes: item.memory_bytes, kind: "Память" })),
    ...projects.map((item) => ({ key: `project-${item.id}`, title: item.name, text: item.stack.join(", ") || "Стек не указан", bytes: item.memory_bytes, kind: "Проект" })),
    ...artifacts.map((item) => ({ key: `artifact-${item.id}`, title: item.name, text: `${item.category} · ${item.version}`, bytes: item.memory_bytes, kind: "Артефакт" })),
  ].filter((row) => {
    const signature = `${row.kind}:${row.title}:${row.text}`.toLowerCase();
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }).slice(0, 8);

  if (!rows.length) return <EmptyState text="База пока пустая" />;
  return (
    <div className="context-list">
      {rows.map((row) => (
        <article className="memory-row entity-feed-card" key={row.key}>
          <span className="entity-feed-kind">{row.kind}</span>
          <div className="entity-feed-body">
            <strong>{row.title}</strong>
            <p>{row.text}</p>
          </div>
          <span className="entity-feed-size">{formatBytes(row.bytes)}</span>
        </article>
      ))}
    </div>
  );
}

function ProjectList({ projects }: { projects: Project[] }) {
  if (!projects.length) return <EmptyState text="Проектов в базе пока нет" />;
  return (
    <div className="project-list">
      {projects.map((project) => (
        <article className="project-card" key={project.id} style={{ "--project-color": project.color || "#2c2c2e" } as CSSProperties}>
          <div>
            <strong>{project.name}</strong>
            <p>{project.stack.join(", ") || "Стек не указан"}</p>
          </div>
          <span>{formatBytes(project.memory_bytes)}</span>
        </article>
      ))}
    </div>
  );
}
