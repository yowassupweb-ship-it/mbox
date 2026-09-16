import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { formatDate } from "../../lib/format";
import { projectMemoryMatches } from "../../lib/memory";
import type { Memory, Project } from "../../types";
import { usePersistentState, type TabsApi } from "./tabs";

/** Автологи агентов («Итог запуска: …», тег auto) дублируют настоящие записи — по умолчанию прячем. */
function isAutoLog(memory: Memory) {
  return memory.tags.includes("auto") || /^Итог (запуска|задачи):/.test(memory.title);
}

function snippet(content: string) {
  const text = content.replace(/^#+\s*/gm, "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Память проекта списком: заголовок и одна строка текста, клик открывает запись во вкладке. */
export function ProjectMemories({ project, memories, tabs }: { project: Project; memories: Memory[]; tabs: TabsApi }) {
  const [query, setQuery] = usePersistentState(`mbox.projectMemories.query.${project.id}`, "");
  const [showAuto, setShowAuto] = usePersistentState("mbox.projectMemories.showAuto", false);

  const all = useMemo(() => {
    const todoIds = new Set(project.todos.map((todo) => todo.id));
    return memories.filter((memory) => projectMemoryMatches(memory, project, todoIds));
  }, [memories, project]);

  const needle = query.trim().toLowerCase();
  const autoCount = all.filter(isAutoLog).length;
  const visible = all.filter((memory) => (showAuto || !isAutoLog(memory)) && (!needle || `${memory.title} ${memory.content} ${memory.tags.join(" ")}`.toLowerCase().includes(needle)));

  return (
    <div className="wb-board">
      <div className="wb-doc-bar">
        <span className="wb-doc-crumbs"><span className="wb-project-dot" style={{ ["--project-color" as string]: project.color || "#5b6b66" }} /> {project.name} › Память · {visible.length}{visible.length !== all.length ? ` из ${all.length}` : ""}</span>
        <div className="wb-doc-actions">
          {autoCount > 0 && <button type="button" className={showAuto ? "is-on" : undefined} onClick={() => setShowAuto(!showAuto)}>{showAuto ? "Скрыть автологи" : `Автологи · ${autoCount}`}</button>}
          <button type="button" onClick={() => tabs.open("memory:new", true)}>Новая запись</button>
        </div>
      </div>
      <div className="wb-filter wb-list-filter">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Фильтр по памяти проекта" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <ul className="wb-rows">
        {visible.map((memory) => (
          <li key={memory.id}>
            <button type="button" className={tabs.active === `memory:${memory.id}` ? "is-active" : undefined} onClick={() => tabs.open(`memory:${memory.id}`)} onDoubleClick={() => tabs.open(`memory:${memory.id}`, true)}>
              <span className="wb-rows-title">{memory.title || "Без названия"}</span>
              <span className="wb-rows-meta">{memory.entity_type === "fact" ? "факт · " : ""}{formatDate(memory.updated_at)}</span>
              {memory.content && <span className="wb-rows-snippet">{snippet(memory.content)}</span>}
            </button>
          </li>
        ))}
        {!visible.length && <li className="wb-empty">{needle ? "Ничего не нашлось." : "Записей нет."}</li>}
      </ul>
    </div>
  );
}
