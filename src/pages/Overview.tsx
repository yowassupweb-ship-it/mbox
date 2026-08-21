import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, HelpCircle, Sliders } from "lucide-react";
import { AgentWorkBoard } from "../features/agents/AgentWorkBoard";
import { NeedsAnswer } from "../features/agents/NeedsAnswer";
import { ReviewQueue } from "../features/projects/ReviewQueue";
import type { MboxData } from "../hooks/useMboxData";
import { formatBytes, formatClock, plural, sumBytes } from "../lib/format";
import { countUnseen, onSeenChange } from "../lib/seen";
import type { AuditEvent, Project } from "../types";
import { EmptyState, Metric, MetricGrid, Panel } from "../ui";

const BOTTOM_ICONS = "/assets/icons/bottom-menu";

export function Overview({ data, onOpenProject }: { data: MboxData; onOpenProject: (projectId: string) => void }) {
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
      </MetricGrid>
      {reviewCount > 0 && (
        <Panel title={`На проверке · ${reviewCount}`} icon={ClipboardCheck} className="review-panel">
          <ReviewQueue projects={data.projects} onSaved={data.reload} />
        </Panel>
      )}
      <div className="content-grid overview-grid">
        <Panel title="Последние изменения" className="panel-bare">
          <ChangeLog events={data.auditEvents} />
        </Panel>
        <Panel title="Проекты">
          <ProjectPills projects={data.projects.slice(0, 5)} onOpenProject={onOpenProject} />
        </Panel>
      </div>
      <AgentWorkBoard agents={data.agents} runs={data.runs} inbox={data.inbox} decisions={data.decisions} />
    </>
  );
}

/** Тот же терминальный журнал, что и на «Истории» (.console/.console-line) — здесь просто
 * укороченная витрина последних 10 записей, а не полный аудит. */
function ChangeLog({ events }: { events: AuditEvent[] }) {
  const rows = events.slice(0, 10);
  return (
    <div className="console" role="log" aria-label="Последние изменения">
      <div className="console-bar">
        <span className="console-title">mbox — последние изменения</span>
        <span className="console-count">{rows.length} {plural(rows.length, "запись", "записи", "записей")}</span>
      </div>
      <div className="console-body">
        {rows.length ? rows.map((event) => (
          <div className={`console-line act-${(event.action || "").toLowerCase()}`} key={event.id}>
            <span className="c-time">{formatClock(event.created_at)}</span>
            <span className="c-actor">{event.actor || "system"}</span>
            <span className="c-act">{event.action}</span>
            <span className="c-entity">{event.entity_type}{event.entity_id ? `#${event.entity_id}` : ""}</span>
            <span className="c-msg">{event.summary || "—"}</span>
          </div>
        )) : <div className="console-line muted"><span className="c-msg">— изменений пока не было —</span></div>}
      </div>
    </div>
  );
}

/** Те же пилюли, что и в разделе «Проекты» (project-pill), только без драга и контекстного
 * меню — здесь это витрина последних проектов, а не рабочий рельс. Клик ведёт в сам раздел. */
function ProjectPills({ projects, onOpenProject }: { projects: Project[]; onOpenProject: (projectId: string) => void }) {
  const [seenTick, setSeenTick] = useState(0);
  useEffect(() => onSeenChange(() => setSeenTick((value) => value + 1)), []);
  const unseenByProject = useMemo(() => {
    void seenTick;
    const map = new Map<string, number>();
    for (const item of projects) {
      const marks = item.todos.map((todo) => ({ key: `todo:${todo.id}`, bytes: todo.memory_bytes }));
      map.set(item.id, countUnseen(marks));
    }
    return map;
  }, [projects, seenTick]);

  if (!projects.length) return <EmptyState text="Проектов в базе пока нет" />;
  return (
    <div className="project-rail overview-project-rail">
      {projects.map((project) => {
        const unseen = unseenByProject.get(project.id) || 0;
        const activeTodos = project.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length;
        return (
          <button
            key={project.id}
            type="button"
            className="project-pill"
            style={{ ["--project-color" as string]: project.color || "#2c2c2e" }}
            onClick={() => onOpenProject(project.id)}
          >
            {unseen > 0 && (
              <span className="project-pill-unread" title={`${unseen} непрочитанных`}>{unseen}</span>
            )}
            <span className="project-pill-name">{project.name}</span>
            <span className="project-pill-meta">
              <span className="project-pill-count">{activeTodos}</span>
              <span className="project-pill-props" title="Ключей в props">
                <Sliders size={10} />{Object.keys(project.props || {}).length}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
