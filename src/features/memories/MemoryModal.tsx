import { useEffect, useState } from "react";
import { Pencil, Trash2, X } from "lucide-react";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import type { Memory } from "../../types";
import { Button, SaveButton, TextArea, TextInput, type SaveState } from "../../ui";

/**
 * Полноэкранная запись памяти — читать и править. Раньше записи можно было увидеть только куском
 * в узкой карточке (папка) или строкой таблицы (страница Память); ни там, ни там нельзя было
 * развернуть длинный текст на весь экран. Общий каркас с todo-модалкой (.entity-modal-* в
 * styles/pages.css), своя только середина.
 */
export function MemoryModal({ memory, onClose, onSaved }: { memory: Memory; onClose: () => void; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [content, setContent] = useState(memory.content);
  const [state, setState] = useState<SaveState>("idle");

  useEffect(() => {
    setTitle(memory.title);
    setContent(memory.content);
    setEditing(false);
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
    onClose();
  }

  return (
    <div className="entity-modal-scrim" role="dialog" aria-modal="true" aria-label={memory.title} onClick={onClose}>
      <div className="entity-modal" onClick={(event) => event.stopPropagation()}>
        <header className="entity-modal-head">
          <div className="entity-modal-title">
            <span className="muted">память #{memory.id} · {formatBytes(memory.memory_bytes)} · {formatDateTime(memory.updated_at)}</span>
            {editing
              ? <TextInput value={title} onChange={(event) => { setTitle(event.target.value); setState("idle"); }} />
              : <strong>{memory.title || "Без названия"}</strong>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>

        <div className="entity-modal-body">
          {editing ? (
            <TextArea label="Текст" value={content} onChange={(event) => { setContent(event.target.value); setState("idle"); }} rows={18} />
          ) : (
            <p className="entity-modal-text">{memory.content || "Пусто"}</p>
          )}
          {memory.tags.length > 0 && !editing && (
            <div className="muted">Теги: {memory.tags.join(", ")}</div>
          )}
        </div>

        <footer className="entity-modal-foot">
          <Button variant="danger" icon={Trash2} onClick={remove}>Удалить</Button>
          <div className="entity-modal-foot-right">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setTitle(memory.title); setContent(memory.content); }}>Отмена</Button>
                <SaveButton state={state} onClick={save} />
              </>
            ) : (
              <Button variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Править</Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
