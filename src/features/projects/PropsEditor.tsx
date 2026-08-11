import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { saveEntity } from "../../lib/api";
import type { Project } from "../../types";
import { Button, EmptyState, SaveButton, type SaveState } from "../../ui";

type Row = { id: number; key: string; value: string };

let seed = 0;
const nextId = () => ++seed;

function toRows(props: Record<string, string>): Row[] {
  return Object.entries(props || {}).map(([key, value]) => ({ id: nextId(), key, value }));
}

/**
 * Свойства проекта в духе переменных окружения: строки ключ-значение, без шифрования.
 * Раньше это была одна textarea, где пары разбирались из текста — легко было потерять значение опечаткой.
 */
export function PropsEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(project.props));
  const [state, setState] = useState<SaveState>("idle");

  useEffect(() => {
    setRows(toRows(project.props));
    setState("idle");
  }, [project.id, project.props]);

  function update(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    setState("idle");
  }

  function remove(id: number) {
    setRows((current) => current.filter((row) => row.id !== id));
    setState("idle");
  }

  function add() {
    setRows((current) => [...current, { id: nextId(), key: "", value: "" }]);
  }

  const duplicates = new Set(
    rows.map((row) => row.key.trim()).filter((key, index, all) => key && all.indexOf(key) !== index),
  );

  async function save() {
    setState("saving");
    try {
      const props = Object.fromEntries(
        rows.map((row) => [row.key.trim(), row.value]).filter(([key]) => key),
      );
      await saveEntity("/api/mbox/projects", project.id, { props });
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="env-editor">
      <p className="muted env-hint">
        Структурные факты о проекте. Их читают агенты, поэтому ключ важнее формулировки: <code>deploy_host</code> полезнее, чем «где развёрнуто».
      </p>

      {rows.length ? (
        <div className="env-rows">
          {rows.map((row) => (
            <div className={duplicates.has(row.key.trim()) ? "env-row is-duplicate" : "env-row"} key={row.id}>
              <input
                className="env-key"
                value={row.key}
                onChange={(event) => update(row.id, { key: event.target.value })}
                placeholder="KEY"
                spellCheck={false}
              />
              <textarea
                className="env-value"
                value={row.value}
                onChange={(event) => update(row.id, { value: event.target.value })}
                placeholder="значение"
                rows={1}
              />
              <button className="env-remove" type="button" onClick={() => remove(row.id)} aria-label={`Удалить ${row.key || "строку"}`}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : <EmptyState text="Свойств пока нет" />}

      {duplicates.size > 0 && <p className="error-text">Повторяющиеся ключи перезапишут друг друга: {[...duplicates].join(", ")}</p>}

      <div className="env-actions">
        <Button variant="ghost" icon={Plus} onClick={add}>Добавить свойство</Button>
        <SaveButton state={state} onClick={save} />
      </div>
    </div>
  );
}
