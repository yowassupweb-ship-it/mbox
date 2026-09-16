import { useEffect, useLayoutEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { saveEntity } from "../../lib/api";
import type { Project } from "../../types";
import { Button, EmptyState, SaveButton, type SaveState } from "../../ui";

type Row = { id: number; key: string; value: string };

/** Ключи, которыми управляет сам MBOX или отдельные разделы проекта (порядок в дереве, структура
 * репозитория для Джарвиса, Философия, Figma, набор разделов). В таблице их не показываем и при
 * сохранении не трогаем: раньше repo_structure-объект выводился как «[object Object]» и сохранение
 * записывало эту строку поверх настоящей структуры. */
const MANAGED_KEYS = new Set(["position", "repo_structure", "enabled_entities", "philosophy", "principles", "figma_url"]);

function isEditable(key: string, value: unknown) {
  return !MANAGED_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean");
}

let seed = 0;
const nextId = () => ++seed;

function toRows(props: Record<string, string>): Row[] {
  return Object.entries(props || {}).filter(([key, value]) => isEditable(key, value)).map(([key, value]) => ({ id: nextId(), key, value: String(value) }));
}

function fitTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Свойства проекта в духе переменных окружения: строки ключ-значение, без шифрования.
 * Раньше это была одна textarea, где пары разбирались из текста — легко было потерять значение опечаткой.
 */
export function PropsEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(project.props));
  const [state, setState] = useState<SaveState>("idle");

  /*
   * Сравниваем содержимое, а не ссылку.
   *
   * Данные перезагружаются раз в пять секунд по тику сервера, и project.props каждый раз приходит
   * новым объектом с тем же содержимым. Эффект, завязанный на саму ссылку, срабатывал на каждой
   * перезагрузке и сбрасывал строки на серверные — только что добавленная пустая строка исчезала
   * раньше, чем в неё успевали дописать ключ. Со стороны это выглядело как «свойства не добавляются».
   */
  const serverProps = JSON.stringify(project.props || {});

  useEffect(() => {
    setRows(toRows(project.props ?? {}));
    setState("idle");
    // project.props намеренно не в зависимостях: сброс делает только смена содержимого.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, serverProps]);

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
      const managed = Object.fromEntries(Object.entries(project.props || {}).filter(([key, value]) => !isEditable(key, value)));
      const props = {
        ...managed,
        ...Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]).filter(([key]) => key && !MANAGED_KEYS.has(key))),
      };
      await saveEntity("/api/mbox/projects", project.id, { props });
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="env-editor">

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
