import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BookOpen, Flag, Link2, Maximize2, Pencil, Plus, Sparkles, X } from "lucide-react";
import { fetchJson, saveEntity } from "../lib/api";
import { formatBytes, formatDate, plural } from "../lib/format";
import { projectMemoryMatches } from "../lib/memory";
import { MemoryModal } from "../features/memories/MemoryModal";
import { useWheelToHorizontal } from "../lib/useWheelToHorizontal";
import { positionBetween, projectPosition } from "../lib/tree";
import type { DecisionEntry, Memory, Project } from "../types";
import { Button, EmptyState, ErrorText, Panel, SaveButton, Select, type SaveState, TextArea, TextInput } from "../ui";

type MemoryLink = {
  id: string;
  from_memory_id: string;
  from_title: string;
  to_memory_id: string;
  to_title: string;
  link_type: string;
  description: string;
};

type LinkView = { otherId: string; otherTitle: string; type: string; dir: "out" | "in" };

export function MemoryBoard({ memories, projects, decisions, onSaved }: { memories: Memory[]; projects: Project[]; decisions: DecisionEntry[]; onSaved: () => void }) {
  const railRef = useWheelToHorizontal<HTMLDivElement>();
  const [links, setLinks] = useState<MemoryLink[]>([]);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [open, setOpen] = useState<Memory | null>(null);
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    let alive = true;
    fetchJson<{ links: MemoryLink[] }>("/api/mbox/memory-links")
      .then((data) => { if (alive) setLinks(data.links || []); })
      .catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, [memories.length]);

  // Связи двунаправленные: у каждой записи собираем и исходящие, и входящие нити.
  const linksByMemory = useMemo(() => {
    const map = new Map<string, LinkView[]>();
    for (const link of links) {
      (map.get(link.from_memory_id) ?? map.set(link.from_memory_id, []).get(link.from_memory_id)!)
        .push({ otherId: link.to_memory_id, otherTitle: link.to_title, type: link.link_type, dir: "out" });
      (map.get(link.to_memory_id) ?? map.set(link.to_memory_id, []).get(link.to_memory_id)!)
        .push({ otherId: link.from_memory_id, otherTitle: link.from_title, type: link.link_type, dir: "in" });
    }
    return map;
  }, [links]);

  const linkedCount = linksByMemory.size;
  const activeProject = projects.find((item) => item.id === projectId);
  const [factsOnly, setFactsOnly] = useState(false);
  const factsCount = memories.filter((memory) => memory.entity_type === "fact").length;

  // Своя память — это память конкретного проекта: напрямую, через metadata или через его todo.
  // «Все» снимает фильтр и показывает весь пул, как раньше. «Факты» — отдельный срез поверх:
  // архивариус (scripts/mbox-archivist.mjs) размечает записи entity_type=fact/log, отделяя
  // durable-факты от технических логов прогонов — без разметки все они лежали одним потоком.
  const visibleMemories = useMemo(() => {
    let list = memories;
    if (activeProject) {
      const todoIds = new Set(activeProject.todos.map((todo) => todo.id));
      list = list.filter((memory) => projectMemoryMatches(memory, activeProject, todoIds));
    }
    if (factsOnly) list = list.filter((memory) => memory.entity_type === "fact");
    return list;
  }, [memories, activeProject, factsOnly]);

  const visibleDecisions = useMemo(
    () => activeProject ? decisions.filter((decision) => decision.project_id === activeProject.id) : [],
    [decisions, activeProject],
  );

  const count = visibleMemories.length;

  const orderedProjects = useMemo(
    () => [...projects].sort((a, b) => projectPosition(a, projects.indexOf(a)) - projectPosition(b, projects.indexOf(b))),
    [projects],
  );
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  async function reorderProject(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const rest = orderedProjects.filter((item) => item.id !== draggedId);
    const targetIndex = rest.findIndex((item) => item.id === targetId);
    if (targetIndex === -1) return;
    const before = rest[targetIndex - 1];
    const after = rest[targetIndex];
    const newPosition = positionBetween(
      before ? projectPosition(before, projects.indexOf(before)) : undefined,
      after ? projectPosition(after, projects.indexOf(after)) : undefined,
    );
    const dragged = orderedProjects.find((item) => item.id === draggedId);
    if (!dragged) return;
    await fetchJson(`/api/mbox/projects/${draggedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { ...dragged.props, position: newPosition } }),
    });
    onSaved();
  }

  return (
    <>
      {projects.length > 0 && (
        <div className="project-rail" ref={railRef} role="tablist" aria-label="Фильтр по проекту">
          <button
            role="tab"
            aria-selected={!projectId}
            className={!projectId ? "project-pill is-active" : "project-pill"}
            onClick={() => setProjectId("")}
          >
            <span className="project-pill-name">Все проекты</span>
            <span className="project-pill-count">{memories.length}</span>
          </button>
          {orderedProjects.map((project) => (
            <button
              key={project.id}
              role="tab"
              aria-selected={projectId === project.id}
              className={[
                projectId === project.id ? "project-pill is-active" : "project-pill",
                draggedProjectId === project.id ? "is-dragging" : "",
                dropTargetId === project.id && draggedProjectId && draggedProjectId !== project.id ? "is-drop-target" : "",
              ].filter(Boolean).join(" ")}
              style={{ ["--project-color" as string]: project.color || "#2c2c2e" }}
              onClick={() => setProjectId(project.id)}
              draggable
              onDragStart={(event) => { setDraggedProjectId(project.id); event.dataTransfer.setData("text/plain", project.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(event) => { if (draggedProjectId && draggedProjectId !== project.id) { event.preventDefault(); setDropTargetId(project.id); } }}
              onDragLeave={() => setDropTargetId((current) => (current === project.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                setDropTargetId(null);
                if (draggedId) reorderProject(draggedId, project.id);
              }}
              onDragEnd={() => { setDraggedProjectId(null); setDropTargetId(null); }}
            >
              <span className="project-pill-dot" />
              <span className="project-pill-name">{project.name}</span>
            </button>
          ))}
        </div>
      )}

      {activeProject && (
        <ProjectDecisions project={activeProject} decisions={visibleDecisions} />
      )}

      <Panel
        title="Память"
        icon={BookOpen}
        actions={
          <div className="memory-panel-actions">
            {factsCount > 0 && (
              <button type="button" className={factsOnly ? "facts-toggle is-active" : "facts-toggle"} onClick={() => setFactsOnly((value) => !value)} title="Показывать только durable-факты, размеченные архивариусом">
                <Sparkles size={13} /> Факты <b>{factsCount}</b>
              </button>
            )}
            <span className="muted">
              {count} {plural(count, "запись", "записи", "записей")}
              {links.length > 0 && <> · {links.length} {plural(links.length, "связь", "связи", "связей")} у {linkedCount} {plural(linkedCount, "записи", "записей", "записей")}</>}
            </span>
          </div>
        }
      >
        <MemoryEditor editing={editing} projects={projects} onSaved={onSaved} onDone={() => setEditing(null)} presetProjectId={projectId} />
        <MemoryCardGrid memories={visibleMemories} linksByMemory={linksByMemory} onEdit={setEditing} onOpen={setOpen} editingId={editing?.id} />
      </Panel>

      {/* По id, не по ссылке: после сохранения приходит новый объект memory с тем же id. */}
      {open && <MemoryModal memory={memories.find((memory) => memory.id === open.id) ?? open} onClose={() => setOpen(null)} onSaved={onSaved} />}
    </>
  );
}

function previewText(value: string, limit = 220) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function shortDate(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

/** Решения проекта — то же, что раньше висело в панели сбоку от Todo, теперь рядом с его памятью. */
function ProjectDecisions({ project, decisions }: { project: Project; decisions: DecisionEntry[] }) {
  return (
    <Panel title={`Решения · ${project.name}`} icon={Flag}>
      <div className="project-memory-group">
        {decisions.length ? decisions.map((decision) => (
          <article className="project-memory-item" key={decision.id}>
            <strong>{decision.title}</strong>
            <p>{previewText(decision.decision || decision.impact || decision.rationale)}</p>
            <small>{decision.actor} · {shortDate(decision.created_at)}</small>
          </article>
        )) : <p className="project-memory-empty">Решений по проекту пока нет</p>}
      </div>
    </Panel>
  );
}

const accessOptions = [
  { value: "private", label: "private — только я" },
  { value: "agents", label: "agents — видят агенты" },
  { value: "public", label: "public — видно всем" },
];

// Редактор без «угадывания по id»: правка приходит выбором строки (editing), новая запись — при null.
// presetProjectId: запись, созданная при активном фильтре по проекту, сразу привязывается к нему;
// поле «Проект» в форме позволяет сменить или снять привязку и для новой, и для существующей записи.
function MemoryEditor({ editing, projects, onSaved, onDone, presetProjectId }: { editing: Memory | null; projects: Project[]; onSaved: () => void; onDone: () => void; presetProjectId?: string }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [accessLevel, setAccessLevel] = useState("private");
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(editing?.title ?? "");
    setContent(editing?.content ?? "");
    setTags(editing?.tags.join(", ") ?? "");
    setAccessLevel(editing?.access_level ?? "private");
    setProjectId(editing ? (editing.project_id ?? "") : (presetProjectId ?? ""));
    setState("idle");
    setError("");
  }, [editing, presetProjectId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    setError("");
    try {
      await saveEntity("/api/mbox/memories", editing?.id ?? "", {
        title,
        content,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        access_level: accessLevel,
        project_id: projectId || null,
      });
      setState("idle");
      onSaved();
      onDone();
    } catch {
      setState("error");
      setError("Не удалось сохранить");
    }
  }

  return (
    <form className={editing ? "entity-editor editing" : "entity-editor"} onSubmit={submit}>
      <div className="entity-editor-head">
        <strong>{editing ? <>Правка <span className="val">#{editing.id}</span></> : <><Plus size={15} /> Новая запись</>}</strong>
        {editing && <Button variant="ghost" icon={X} onClick={onDone}>Отмена</Button>}
      </div>
      <TextInput label="Название" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="О чём запись" />
      <TextArea label="Содержимое" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Свободный текст" rows={4} />
      <TextInput label="Теги" hint="Через запятую" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="проект, решение, черновик" />
      <Select label="Проект" hint="Необязательно" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">— без проекта —</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select>
      <Select label="Доступ" value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)} options={accessOptions} />
      {error && <ErrorText>{error}</ErrorText>}
      <SaveButton state={state} idleLabel={editing ? "Сохранить правки" : "Добавить запись"} type="submit" />
    </form>
  );
}

/** Та же карточная сетка, что и на «Проектах»/«Обзоре» (todo-note-card) — раньше запись памяти
 * жила строкой плоской HTML-таблицы, на общем фоне страниц с карточками и пилюлями это читалось
 * как чужеродный кусок другого интерфейса. Название открывает MemoryModal, как раньше. */
function MemoryCardGrid({ memories, linksByMemory, onEdit, onOpen, editingId }: { memories: Memory[]; linksByMemory: Map<string, LinkView[]>; onEdit: (memory: Memory) => void; onOpen: (memory: Memory) => void; editingId?: string }) {
  if (!memories.length) return <EmptyState text="Память в базе пока пустая" />;
  return (
    <div className="memory-card-grid">
      {memories.map((memory) => {
        const memLinks = linksByMemory.get(memory.id) ?? [];
        return (
          <article className={editingId === memory.id ? "memory-note-card is-editing" : "memory-note-card"} key={memory.id}>
            <div className="todo-note-card-head">
              <button type="button" className="memory-title-open" onClick={() => onOpen(memory)} title={memory.title}>{memory.title}</button>
              <button className="todo-card-expand" type="button" onClick={() => onOpen(memory)} aria-label="Открыть на весь экран" title="Открыть на весь экран">
                <Maximize2 size={15} />
              </button>
            </div>

            {memory.content && <p className="todo-note-card-body">{memory.content}</p>}

            <div className="todo-note-card-meta">
              <span className="todo-chip muted">#{memory.id}</span>
              <span className="todo-chip">{memory.access_level}</span>
              <span className="todo-chip muted">{formatBytes(memory.memory_bytes)}</span>
              <span className="todo-chip muted">{formatDate(memory.updated_at)}</span>
              {memory.tags.map((tag) => <span className="todo-chip" key={tag}>{tag}</span>)}
            </div>

            {memLinks.length > 0 && (
              <div className="memory-links-cell">
                {memLinks.slice(0, 4).map((link, index) => (
                  <span className={`memory-link-chip ${link.dir}`} key={`${link.otherId}-${index}`} title={`${link.dir === "out" ? "→" : "←"} ${link.type}: ${link.otherTitle}`}>
                    <Link2 size={11} />
                    <em>{link.type}</em>
                    {link.otherTitle}
                  </span>
                ))}
                {memLinks.length > 4 && <span className="memory-link-more">+{memLinks.length - 4}</span>}
              </div>
            )}

            <div className="todo-card-actions">
              <Button variant="ghost" onClick={() => onOpen(memory)}>Открыть</Button>
              <Button variant="icon" icon={Pencil} aria-label={`Изменить запись #${memory.id}`} onClick={() => onEdit(memory)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
