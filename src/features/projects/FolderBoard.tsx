import { useState, type MouseEvent } from "react";
import { Heart, Pencil, Plus, Trash2 } from "lucide-react";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatDate, formatSince } from "../../lib/format";
import { MemoryModal } from "../memories/MemoryModal";
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
  const [open, setOpen] = useState<Memory | null>(null);
  const items = memories.filter((memory) => memory.folder_id === folder.id);

  // Открытая запись живёт по id, а не по ссылке на объект: после сохранения приходит новый memory
  // с тем же id — без этого модалка после save() потеряла бы связь со свежими данными и закрылась.
  const openMemory = open ? items.find((memory) => memory.id === open.id) ?? open : null;

  return (
    <div className="folder-board">
      <div className="folder-board-add">
        {adding ? (
          <NewNote folder={folder} project={project} onDone={() => setAdding(false)} onSaved={onSaved} />
        ) : (
          <Button variant="ghost" icon={Plus} onClick={() => setAdding(true)}>Добавить запись</Button>
        )}
      </div>

      {items.length ? (
        <div className="folder-notes">
          {items.map((memory) => <FolderNote key={memory.id} memory={memory} onOpen={() => setOpen(memory)} onSaved={onSaved} />)}
        </div>
      ) : <EmptyState text={`В папке «${folder.name}» пока пусто. Первая запись — выше.`} />}

      {openMemory && <MemoryModal memory={openMemory} onClose={() => setOpen(null)} onSaved={onSaved} />}
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

/**
 * Превью в узкой карточке колоночной вёрстки. Раньше карточка сама была инлайн-редактором —
 * править можно было только в тесноте той же ширины, что и readonly-вид, и открыть запись
 * во весь экран было нельзя вообще. Теперь карточка — это только вход: клик открывает
 * MemoryModal, где и читать длинный текст, и править удобно.
 */
function FolderNote({ memory, onOpen, onSaved }: { memory: Memory; onOpen: () => void; onSaved: () => void }) {
  async function remove(event: MouseEvent) {
    event.stopPropagation();
    if (!window.confirm(`Удалить запись «${memory.title}»?`)) return;
    await fetchJson(`/api/mbox/memories/${memory.id}`, { method: "DELETE" });
    onSaved();
  }

  // Посты (entity_type='post') несут сырые факты вовлечённости в metadata, а не в отдельных
  // колонках — карточка не показывала их вовсе, лайки были "невидимыми" для владельца.
  const isPost = memory.entity_type === "post";
  const reactionsTotal = isPost ? Number(memory.metadata?.reactions_total) || 0 : 0;
  const postedAt = isPost && typeof memory.metadata?.posted_at === "string" ? memory.metadata.posted_at : null;

  return (
    <article className="folder-note" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <header>
        <strong>{memory.title}</strong>
        <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }} aria-label="Открыть запись"><Pencil size={15} /></button>
        <button type="button" onClick={remove} aria-label="Удалить запись"><Trash2 size={15} /></button>
      </header>
      {memory.content && <p>{memory.content}</p>}
      <footer>
        {isPost
          ? <>
              <span className="folder-note-likes"><Heart size={13} />{reactionsTotal}</span>
              {postedAt ? formatDate(postedAt) : formatSince(memory.updated_at)}
            </>
          : formatSince(memory.updated_at)}
      </footer>
    </article>
  );
}
