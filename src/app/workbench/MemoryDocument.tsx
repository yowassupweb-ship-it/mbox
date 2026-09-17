import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link2, Pencil, Save, Trash2, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import type { Memory } from "../../types";
import { DocShell, DrawerToggle, MetaStrip, useDrawer } from "./docLayout";
import type { TabsApi } from "./tabs";
import { hasDraft, useDraft } from "./uiMemory";

type MemoryRecord = Memory & { project_name?: string | null; todo_id?: string | null };
type MemoryLink = { id: string; from_memory_id: string; from_title: string; to_memory_id: string; to_title: string; link_type: string };
type Similar = { id: string; title: string; project_name: string | null; score: number };

type Draft = { title: string; content: string; tags: string; projectId: string; access: string; entityType: string };

const EMPTY_DRAFT: Draft = { title: "", content: "", tags: "", projectId: "", access: "private", entityType: "memory" };

function draftOf(memory: MemoryRecord): Draft {
  return {
    title: memory.title,
    content: memory.content ?? "",
    tags: (memory.tags ?? []).join(", "),
    projectId: memory.project_id ?? "",
    access: memory.access_level || "private",
    entityType: memory.entity_type || "memory",
  };
}

function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={`${key}-${index}`}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>;
    return <Fragment key={`${key}-${index}`}>{part}</Fragment>;
  });
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Ячейки строки таблицы; \| внутри ячейки — буквальная черта, а не граница. */
function tableCells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Записи памяти в основном пишут агенты markdown'ом: заголовки, списки, блоки кода. Полноценный
 * парсер не нужен — только то, что реально встречается, чтобы текст не читался простынёй. */
export function renderDocument(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i += 1; }
      blocks.push(<pre key={i}>{code.join("\n")}</pre>);
      continue;
    }
    // Таблица: строка с | и под ней разделитель |---|:---:|. Раньше выводилась трубами как есть.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = tableCells(line);
      const align = tableCells(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(tableCells(lines[i])); i += 1; }
      i -= 1;
      blocks.push(
        <div key={i} className="wb-md-table">
          <table>
            <thead><tr>{header.map((cell, c) => <th key={c} style={{ textAlign: align[c] }}>{inline(cell, `th${i}-${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, c) => <td key={c} style={{ textAlign: align[c] }}>{inline(row[c] ?? "", `td${i}-${r}-${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { blocks.push(<h4 key={i} className={`level-${heading[1].length}`}>{inline(heading[2], `h${i}`)}</h4>); continue; }
    const listItem = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listItem) { blocks.push(<p key={i} className="is-list" style={{ ["--indent" as string]: Math.floor(listItem[1].length / 2) }}><span>{/\d/.test(listItem[2]) ? listItem[2] : "•"}</span><span>{inline(listItem[3], `l${i}`)}</span></p>); continue; }
    blocks.push(line.trim() ? <p key={i}>{inline(line, `p${i}`)}</p> : <div key={i} className="is-gap" />);
  }
  return blocks;
}

export function MemoryDocument({ memoryId, data, tabs, tabKey, visible, onTitle, onDirty }: {
  memoryId: string;
  data: MboxData;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onTitle: (key: string, title: string) => void;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const isNew = memoryId === "new";
  const [memory, setMemory] = useState<MemoryRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const draftKey = `memory:${memoryId}`;
  // Незаконченная правка переживает перезагрузку: вкладка открывается сразу в режиме правки с черновиком.
  const [editing, setEditing] = useState(() => isNew || hasDraft(draftKey));
  const [draft, setDraft, discardDraft] = useDraft<Draft>(draftKey, memory ? draftOf(memory) : EMPTY_DRAFT);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [links, setLinks] = useState<MemoryLink[]>([]);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [drawerOpen, setDrawerOpen] = useDrawer("mbox.doc.memory.related");

  const dirty = useMemo(() => {
    if (!editing) return false;
    const base = memory ? draftOf(memory) : EMPTY_DRAFT;
    return (Object.keys(base) as Array<keyof Draft>).some((field) => base[field] !== draft[field]);
  }, [editing, memory, draft]);

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      const response = await fetchJson<{ memory: MemoryRecord }>(`/api/mbox/memories/${memoryId}`);
      setMemory(response.memory);
      setMissing(false);
      onTitle(tabKey, response.memory.title);
    } catch {
      setMissing(true);
    }
  }, [isNew, memoryId, tabKey, onTitle]);

  // Перечитываем запись, когда данные обновились (агент мог её поправить), но не посреди правки.
  useEffect(() => { if (!editing) void load(); }, [load, data.memories]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isNew) return;
    let alive = true;
    fetchJson<{ links: MemoryLink[] }>("/api/mbox/memory-links")
      .then((response) => { if (alive) setLinks(response.links.filter((link) => link.from_memory_id === memoryId || link.to_memory_id === memoryId)); })
      .catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, [isNew, memoryId]);

  useEffect(() => {
    if (!memory?.title) return;
    let alive = true;
    const params = new URLSearchParams({ q: memory.title, limit: "9", detail: "full", min_score: "0.15" });
    fetchJson<{ memories: Similar[] }>(`/api/mbox/memories/search?${params}`)
      .then((response) => { if (alive) setSimilar(response.memories.filter((item) => item.id !== memory.id).slice(0, 8)); })
      .catch(() => { if (alive) setSimilar([]); });
    return () => { alive = false; };
  }, [memory?.id, memory?.title]);

  function startEdit() {
    setDraft(memory ? draftOf(memory) : EMPTY_DRAFT);
    setEditing(true);
    tabs.pin(tabKey);
  }

  function cancelEdit() {
    if (dirty && !window.confirm("Отменить несохранённые правки?")) return;
    discardDraft();
    if (isNew) return tabs.close(tabKey);
    setEditing(false);
  }

  async function save() {
    if (saveState === "saving") return;
    if (!draft.title.trim()) { window.alert("Нужно название"); return; }
    setSaveState("saving");
    const body = {
      title: draft.title.trim(),
      content: draft.content,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      project_id: draft.projectId || null,
      access_level: draft.access,
      entity_type: draft.entityType,
    };
    try {
      if (isNew) {
        const response = await fetchJson<{ memory: { id: string } }>("/api/mbox/memories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        discardDraft();
        onDirty(tabKey, false);
        data.reload();
        tabs.replace(tabKey, `memory:${response.memory.id}`);
        return;
      }
      await fetchJson(`/api/mbox/memories/${memoryId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      discardDraft();
      setSaveState("idle");
      setEditing(false);
      await load();
      data.reload();
    } catch {
      setSaveState("error");
    }
  }

  async function remove() {
    if (!memory || !window.confirm(`Удалить запись «${memory.title}»?`)) return;
    await fetchJson(`/api/mbox/memories/${memory.id}`, { method: "DELETE" });
    data.reload();
    tabs.close(tabKey);
  }

  useEffect(() => {
    if (!visible || !editing) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (missing) return <div className="wb-doc-missing">Запись #{memoryId} не найдена — возможно, её удалили или она в чужом проекте.</div>;
  if (!isNew && !memory) return <div className="wb-doc-missing">Загрузка записи #{memoryId}…</div>;

  const metadata = memory?.metadata ?? {};
  const sourceAgent = typeof metadata.source_agent === "string" ? metadata.source_agent : "";

  const relatedCount = links.length + similar.length;
  const project = data.projects.find((item) => item.id === (editing ? draft.projectId : memory?.project_id));

  return (
    <DocShell
      drawerOpen={drawerOpen && !editing}
      onCloseDrawer={() => setDrawerOpen(false)}
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Память{project ? ` › ${project.name}` : ""}{memory ? ` › #${memory.id}` : " › новая"}</span>
          <div className="wb-doc-actions">
            {editing ? (
              <>
                {saveState === "error" && <span className="wb-error">Не сохранилось</span>}
                <button type="button" onClick={cancelEdit}><X size={14} /> Отмена</button>
                <button type="button" className="is-primary" onClick={() => void save()} disabled={saveState === "saving"}><Save size={14} /> {saveState === "saving" ? "Сохраняю…" : "Сохранить"} <kbd>Ctrl+S</kbd></button>
              </>
            ) : (
              <>
                <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} label="Связанное" count={relatedCount} />
                <button type="button" onClick={startEdit}><Pencil size={14} /> Править</button>
                <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить запись"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        </>
      )}
      drawer={(
        <>
          {links.length > 0 && (
            <section>
              <h3>Связи · {links.length}</h3>
              <ul className="wb-side-list">
                {links.map((link) => {
                  const outgoing = link.from_memory_id === memoryId;
                  const otherId = outgoing ? link.to_memory_id : link.from_memory_id;
                  return (
                    <li key={link.id}>
                      <button type="button" onClick={() => tabs.open(`memory:${otherId}`)} title={`${outgoing ? "→" : "←"} ${link.link_type}`}>
                        <Link2 size={12} /><em>{link.link_type}</em>{outgoing ? link.to_title : link.from_title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section>
            <h3>Похожие записи{similar.length ? ` · ${similar.length}` : ""}</h3>
            {similar.length ? (
              <ul className="wb-side-list">
                {similar.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => tabs.open(`memory:${item.id}`)}>
                      <span className="wb-side-id">#{item.id}</span>{item.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="wb-empty">Похожих не нашлось.</p>}
          </section>
        </>
      )}
    >
      {editing ? (
        <div className="wb-reading wb-memory-editor">
          <input className="wb-memory-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Название" autoFocus={isNew} />
          <div className="wb-inline-props">
            <select value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })} title="Проект">
              <option value="">без проекта</option>
              {data.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select value={draft.entityType} onChange={(event) => setDraft({ ...draft, entityType: event.target.value })} title="Тип">
              <option value="memory">запись</option>
              <option value="fact">факт</option>
              <option value="log">лог</option>
            </select>
            <select value={draft.access} onChange={(event) => setDraft({ ...draft, access: event.target.value })} title="Доступ">
              <option value="private">только я</option>
              <option value="agents">видят агенты</option>
              <option value="public">видно всем</option>
            </select>
            <input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="теги через запятую" title="Теги" />
          </div>
          <textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="Текст записи. Поддерживаются # заголовки, - списки, `код` и **жирный**." spellCheck={false} />
        </div>
      ) : memory && (
        <article className="wb-reading">
          <h1 className="wb-doc-title" onDoubleClick={startEdit}>{memory.title || "Без названия"}</h1>
          <MetaStrip items={[
            project && <button type="button" className="wb-meta-link" onClick={() => tabs.open(`entity:${project.id}:memories`)}>{project.name}</button>,
            memory.todo_id && <button type="button" className="wb-meta-link" onClick={() => tabs.open(`todo:${memory.todo_id}`)}>todo #{memory.todo_id}</button>,
            memory.entity_type !== "memory" && memory.entity_type,
            sourceAgent || null,
            <span title={`Создана ${formatDateTime(memory.created_at)}`}>{formatDateTime(memory.updated_at)}</span>,
            formatBytes(memory.memory_bytes),
            memory.access_level !== "private" && memory.access_level,
            ...memory.tags.map((tag) => <span className="wb-meta-tag">{tag}</span>),
          ]} />
          <div className="wb-memory-body" onDoubleClick={startEdit}>{memory.content ? renderDocument(memory.content) : <p className="is-muted">Пусто. Двойной клик — начать писать.</p>}</div>
        </article>
      )}
    </DocShell>
  );
}
