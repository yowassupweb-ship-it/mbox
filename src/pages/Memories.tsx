import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BookOpen, Link2, Pencil, Plus, X } from "lucide-react";
import { fetchJson, saveEntity } from "../lib/api";
import { formatBytes, formatDate, plural } from "../lib/format";
import type { Memory } from "../types";
import { Button, EmptyState, ErrorText, Panel, SaveButton, Select, type SaveState, TableWrap, TextArea, TextInput } from "../ui";

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

export function MemoryBoard({ memories, onSaved }: { memories: Memory[]; onSaved: () => void }) {
  const count = memories.length;
  const [links, setLinks] = useState<MemoryLink[]>([]);
  const [editing, setEditing] = useState<Memory | null>(null);

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

  return (
    <Panel
      title="Память"
      icon={BookOpen}
      actions={
        <span className="muted">
          {count} {plural(count, "запись", "записи", "записей")}
          {links.length > 0 && <> · {links.length} {plural(links.length, "связь", "связи", "связей")} у {linkedCount} {plural(linkedCount, "записи", "записей", "записей")}</>}
        </span>
      }
    >
      <MemoryEditor editing={editing} onSaved={onSaved} onDone={() => setEditing(null)} />
      <MemoryTable memories={memories} linksByMemory={linksByMemory} onEdit={setEditing} editingId={editing?.id} />
    </Panel>
  );
}

const accessOptions = [
  { value: "private", label: "private — только я" },
  { value: "agents", label: "agents — видят агенты" },
  { value: "public", label: "public — видно всем" },
];

// Редактор без «угадывания по id»: правка приходит выбором строки (editing), новая запись — при null.
function MemoryEditor({ editing, onSaved, onDone }: { editing: Memory | null; onSaved: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [accessLevel, setAccessLevel] = useState("private");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(editing?.title ?? "");
    setContent(editing?.content ?? "");
    setTags(editing?.tags.join(", ") ?? "");
    setAccessLevel(editing?.access_level ?? "private");
    setState("idle");
    setError("");
  }, [editing]);

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
      <Select label="Доступ" value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)} options={accessOptions} />
      {error && <ErrorText>{error}</ErrorText>}
      <SaveButton state={state} idleLabel={editing ? "Сохранить правки" : "Добавить запись"} type="submit" />
    </form>
  );
}

/* Таблица на узкой ширине разбирается в карточки — подписи колонок подставляются из data-label. */
function MemoryTable({ memories, linksByMemory, onEdit, editingId }: { memories: Memory[]; linksByMemory: Map<string, LinkView[]>; onEdit: (memory: Memory) => void; editingId?: string }) {
  if (!memories.length) return <EmptyState text="Память в базе пока пустая" />;
  return (
    <TableWrap className="memory-table-wrap">
      <table className="memory-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Название</th>
            <th>Связи</th>
            <th>Теги</th>
            <th>Доступ</th>
            <th>Размер</th>
            <th>Обновлено</th>
            <th aria-label="Действия"></th>
          </tr>
        </thead>
        <tbody>
          {memories.map((memory) => {
            const memLinks = linksByMemory.get(memory.id) ?? [];
            return (
              <tr key={memory.id} className={editingId === memory.id ? "row-editing" : undefined}>
                <td data-label="ID">#{memory.id}</td>
                <td data-label="Название">{memory.title}</td>
                <td data-label="Связи">
                  {memLinks.length ? (
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
                  ) : <span className="muted">—</span>}
                </td>
                <td data-label="Теги">{memory.tags.join(", ") || "нет"}</td>
                <td data-label="Доступ">{memory.access_level}</td>
                <td data-label="Размер">{formatBytes(memory.memory_bytes)}</td>
                <td data-label="Обновлено">{formatDate(memory.updated_at)}</td>
                <td data-label="" className="row-actions">
                  <Button variant="icon" icon={Pencil} aria-label={`Изменить запись #${memory.id}`} onClick={() => onEdit(memory)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
