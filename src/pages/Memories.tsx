import { useState } from "react";
import { BookOpen } from "lucide-react";
import { saveEntity } from "../lib/api";
import { formatBytes, formatDate, plural } from "../lib/format";
import type { Memory } from "../types";
import { EmptyState, ManualForm, Panel, Select, TableWrap, TextArea, TextInput } from "../ui";

export function MemoryBoard({ memories, onSaved }: { memories: Memory[]; onSaved: () => void }) {
  const count = memories.length;
  return (
    <Panel
      title="Память"
      icon={BookOpen}
      actions={<span className="muted">{count} {plural(count, "запись", "записи", "записей")}</span>}
    >
      <MemoryForm onSaved={onSaved} />
      <MemoryTable memories={memories} />
    </Panel>
  );
}

const accessOptions = [
  { value: "private", label: "private — только я" },
  { value: "agents", label: "agents — видят агенты" },
  { value: "public", label: "public — видно всем" },
];

function MemoryForm({ onSaved }: { onSaved: () => void }) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [accessLevel, setAccessLevel] = useState("private");

  return (
    <ManualForm title="Добавить или править память" onSubmit={async () => {
      await saveEntity("/api/mbox/memories", id, { title, content, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), access_level: accessLevel });
      setId("");
      setTitle("");
      setContent("");
      setTags("");
      onSaved();
    }}>
      <TextInput label="ID" hint="Заполнить, чтобы править существующую запись. Пусто — создастся новая." value={id} onChange={(event) => setId(event.target.value)} placeholder="например 42" />
      <TextInput label="Название" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="О чём запись" />
      <TextArea label="Содержимое" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Свободный текст" rows={5} />
      <TextInput label="Теги" hint="Через запятую" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="проект, решение, черновик" />
      <Select label="Доступ" value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)} options={accessOptions} />
    </ManualForm>
  );
}

/* Таблица на узкой ширине разбирается в карточки — подписи колонок подставляются из data-label. */
function MemoryTable({ memories }: { memories: Memory[] }) {
  if (!memories.length) return <EmptyState text="Память в базе пока пустая" />;
  return (
    <TableWrap className="memory-table-wrap">
      <table className="memory-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Название</th>
            <th>Тип</th>
            <th>Теги</th>
            <th>Доступ</th>
            <th>Размер</th>
            <th>Обновлено</th>
          </tr>
        </thead>
        <tbody>
          {memories.map((memory) => (
            <tr key={memory.id}>
              <td data-label="ID">#{memory.id}</td>
              <td data-label="Название">{memory.title}</td>
              <td data-label="Тип">{memory.entity_type}</td>
              <td data-label="Теги">{memory.tags.join(", ") || "нет"}</td>
              <td data-label="Доступ">{memory.access_level}</td>
              <td data-label="Размер">{formatBytes(memory.memory_bytes)}</td>
              <td data-label="Обновлено">{formatDate(memory.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
