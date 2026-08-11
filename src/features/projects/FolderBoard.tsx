import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { FolderRow, Memory, Project } from "../../types";
import { Button, EmptyState, SaveButton, TextArea, TextInput, type SaveState } from "../../ui";

/**
 * Содержимое папки проекта.
 *
 * Папка была заглушкой: её можно было создать, открыть и увидеть «складывать сюда будем следующим
 * шагом». Теперь в неё кладутся записи — заголовок и свободный текст, — которые уходят в memories
 * с folder_id и project_id. То есть это та же память MBOX, просто разложенная по полкам, а не
 * отдельная сущность: агенты видят её обычным поиском по памяти.
 */
export function FolderBoard({ folder, project, memories, onSaved }: {
  folder: FolderRow;
  project: Project;
  memories: Memory[];
  onSaved: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const items = memories.filter((memory) => memory.folder_id === folder.id);

  return (
    <div className="folder-board">
      {items.length ? (
        <div className="folder-notes">
          {items.map((memory) => <FolderNote key={memory.id} memory={memory} onSaved={onSaved} />)}
        </div>
      ) : <EmptyState text={`В папке «${folder.name}» пока пусто. Первая запись — ниже.`} />}

      {adding ? (
        <NewNote folder={folder} project={project} onDone={() => setAdding(false)} onSaved={onSaved} />
      ) : (
        <Button variant="ghost" icon={Plus} onClick={() => setAdding(true)}>Добавить запись</Button>
      )}
    </div>
  );
}

function NewNote({ folder, project, onDone, onSaved }: { folder: FolderRow; project: Project; onDone: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [state, setState] = useState<SaveState>("idle");

  async function save() {
    if (!title.trim() && !content.trim()) return;
    setState("saving");
    try {
      await saveEntity("/api/mbox/memories", "", {
        folder_id: folder.id,
        project_id: project.id,
        // Заголовок необязателен: если человек просто написал текст, берём его начало.
        title: title.trim() || content.trim().slice(0, 80),
        content,
        access_level: folder.access_level || "private",
        tags: [folder.name],
      });
      setState("saved");
      onSaved();
      onDone();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="folder-note-form">
      <TextInput label="Заголовок" hint="Можно не заполнять — возьмём начало текста" value={title} onChange={(event) => { setTitle(event.target.value); setState("idle"); }} />
      <TextArea label="Текст" value={content} rows={6} onChange={(event) => { setContent(event.target.value); setState("idle"); }} placeholder="Что положить в эту папку" />
      <div className="folder-note-actions">
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        <SaveButton state={state} idleLabel="Положить в папку" disabled={!title.trim() && !content.trim()} onClick={save} />
      </div>
    </div>
  );
}

function FolderNote({ memory, onSaved }: { memory: Memory; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [content, setContent] = useState(memory.content);
  const [state, setState] = useState<SaveState>("idle");

  // По содержимому, а не по ссылке: перезагрузка раз в пять секунд иначе затирала бы правку.
  useEffect(() => {
    setTitle(memory.title);
    setContent(memory.content);
    setState("idle");
  }, [memory.id, memory.title, memory.content]);

  async function save() {
    setState("saving");
    try {
      await saveEntity("/api/mbox/memories", memory.id, { title, content });
      setState("saved");
      setEditing(false);
      onSaved();
    } catch {
      setState("error");
    }
  }

  async function remove() {
    if (!window.confirm(`Удалить запись «${memory.title}»?`)) return;
    await fetchJson(`/api/mbox/memories/${memory.id}`, { method: "DELETE" });
    onSaved();
  }

  if (editing) {
    return (
      <article className="folder-note is-editing">
        <TextInput label="Заголовок" value={title} onChange={(event) => { setTitle(event.target.value); setState("idle"); }} />
        <TextArea label="Текст" value={content} rows={8} onChange={(event) => { setContent(event.target.value); setState("idle"); }} />
        <div className="folder-note-actions">
          <Button variant="ghost" icon={X} onClick={() => { setEditing(false); setTitle(memory.title); setContent(memory.content); }}>Отмена</Button>
          <SaveButton state={state} idleLabel="Сохранить" onClick={save} />
        </div>
      </article>
    );
  }

  return (
    <article className="folder-note">
      <header>
        <strong>{memory.title}</strong>
        <button type="button" onClick={() => setEditing(true)} aria-label="Править запись"><Pencil size={15} /></button>
        <button type="button" onClick={() => void remove()} aria-label="Удалить запись"><Trash2 size={15} /></button>
      </header>
      {memory.content && <p>{memory.content}</p>}
      <footer>{formatSince(memory.updated_at)}</footer>
    </article>
  );
}
