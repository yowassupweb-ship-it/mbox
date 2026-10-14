import { Check, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../../../ui/askText";
import { applyQuickFacts, asText, COMPANY_FIELDS, fieldValue, HIDDEN_KEYS, labelOf, normalizeUrl, parseQuickFacts, shownKeys, type Field } from "./projectFields";

/**
 * Поле свойства, которое правится на месте: щёлкнул — поле ввода, ушёл из него — сохранено. Пустое поле показывает
 * подсказку, что туда писать, — так видно, чего проекту не хватает.
 */
export function PropField({ field, props, readOnly, onSave, onOpenLink, autoEdit, onDone }: {
  field: Field;
  props: Record<string, unknown> | undefined;
  readOnly?: boolean;
  onSave: (key: string, value: string, previousKey: string) => Promise<void>;
  onOpenLink?: (url: string) => void;
  /** Открыть сразу в режиме правки (поле добавили из строки пустых). */
  autoEdit?: boolean;
  /** Правку закончили — сохранили или отменили. */
  onDone?: () => void;
}) {
  const current = fieldValue(props, field);
  const [editing, setEditing] = useState(Boolean(autoEdit));
  const [draft, setDraft] = useState(current.value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (!editing) setDraft(current.value); }, [current.value, editing]);
  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing]);

  async function commit() {
    setEditing(false);
    if (draft === current.value) { onDone?.(); return; }
    setSaving(true);
    try { await onSave(field.key, draft, current.key); } finally { setSaving(false); onDone?.(); }
  }

  return (
    <div className={`pj-field${editing ? " is-editing" : ""}${current.value ? "" : " is-empty"}`}>
      <span className="pj-field-label">{field.label}</span>
      {editing ? (
        <textarea
          ref={ref}
          className="pj-field-input"
          value={draft}
          rows={1}
          placeholder={field.hint || field.label}
          spellCheck={field.multiline}
          onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${event.target.scrollHeight}px`; }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setDraft(current.value); setEditing(false); onDone?.(); }
            if (event.key === "Enter" && (!field.multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); void commit(); }
          }}
        />
      ) : (
        <div className="pj-field-value">
          <button type="button" className="pj-field-text" disabled={readOnly} onClick={() => setEditing(true)} title={readOnly ? undefined : "Изменить"}>
            {saving ? draft || "Сохраняю…" : current.value || <span className="pj-field-hint">{readOnly ? "—" : field.hint || "Добавить"}</span>}
          </button>
          {field.link && current.value && onOpenLink && (
            <button type="button" className="pj-icon" onClick={() => onOpenLink(normalizeUrl(current.value))} title="Открыть" aria-label={`Открыть: ${field.label}`}><ExternalLink size={13} /></button>
          )}
        </div>
      )}
    </div>
  );
}

/** «Другие свойства»: всё из props, что не стало отдельным полем, — с правкой, удалением и добавлением. */
export function ExtraProps({ props, groups, readOnly, onSave }: {
  props: Record<string, unknown> | undefined;
  groups: Array<{ fields: Field[] }>;
  readOnly?: boolean;
  onSave: (key: string, value: string, previousKey: string) => Promise<void>;
}) {
  const shown = shownKeys(props, groups);
  const rest = Object.entries(props || {}).filter(([key]) => !shown.has(key) && !HIDDEN_KEYS.has(key));
  const [adding, setAdding] = useState<{ key: string; value: string } | null>(null);

  return (
    <div className="pj-extra">
      {rest.map(([key, value]) => (
        <ExtraRow key={key} name={key} value={asText(value)} readOnly={readOnly || (typeof value === "object" && value !== null)} onSave={onSave} />
      ))}
      {adding ? (
        <form className="pj-extra-add" onSubmit={(event) => { event.preventDefault(); const key = adding.key.trim().replace(/\s+/g, "_"); if (key && adding.value.trim()) void onSave(key, adding.value, key).then(() => setAdding(null)); }}>
          <input value={adding.key} onChange={(event) => setAdding({ ...adding, key: event.target.value })} placeholder="Название" aria-label="Название свойства" autoFocus />
          <input value={adding.value} onChange={(event) => setAdding({ ...adding, value: event.target.value })} placeholder="Значение" aria-label="Значение свойства" />
          <button type="submit" className="pj-icon is-primary" aria-label="Добавить"><Check size={14} /></button>
          <button type="button" className="pj-icon" onClick={() => setAdding(null)} aria-label="Отмена"><X size={14} /></button>
        </form>
      ) : !readOnly && (
        <button type="button" className="pj-link" onClick={() => setAdding({ key: "", value: "" })}><Plus size={13} /> Свойство</button>
      )}
    </div>
  );
}

function ExtraRow({ name, value, readOnly, onSave }: { name: string; value: string; readOnly?: boolean; onSave: (key: string, value: string, previousKey: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const long = value.length > 160;
  return (
    <div className="pj-extra-row">
      <PropField field={{ key: name, label: labelOf(name), multiline: true }} props={{ [name]: long && !open ? `${value.slice(0, 160)}…` : value }} readOnly={readOnly || (long && !open)} onSave={onSave} />
      <div className="pj-extra-actions">
        {long && <button type="button" className="pj-link" onClick={() => setOpen(!open)}>{open ? "Свернуть" : "Полностью"}</button>}
        {!readOnly && (
          <button type="button" className="pj-icon is-danger" title="Удалить свойство" aria-label={`Удалить свойство ${labelOf(name)}`} onClick={() => void askConfirm({ title: `Удалить свойство «${labelOf(name)}»?`, confirmLabel: "Удалить", danger: true }).then((yes) => { if (yes) void onSave(name, "", name); })}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * «Добавить сведения» — одно поле для всего: вставили строки (сайт, телефон, ИНН, «Адрес: …», любой факт) —
 * они разложились по полям, а под полем видно, что куда попало. Enter — сохранить, Shift+Enter — новая строка.
 */
export function QuickFacts({ props, onSave, placeholder }: {
  props: Record<string, unknown>;
  onSave: (next: Record<string, unknown>) => Promise<void>;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  async function submit() {
    const facts = parseQuickFacts(text, props);
    if (!facts.length) return;
    setBusy(true);
    try {
      await onSave(applyQuickFacts(props, facts));
      setSaved([...new Set(facts.map((fact) => labelForKey(fact.key)))]);
      setText("");
      if (ref.current) ref.current.style.height = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pj-quick">
      <div className="pj-quick-box">
        <Plus size={16} aria-hidden="true" />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={busy}
          placeholder={placeholder}
          aria-label="Добавить сведения"
          onChange={(event) => { setText(event.target.value); setSaved([]); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`; }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
        />
        {text.trim() && <button type="button" className="pj-btn is-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Сохраняю…" : "Добавить"}</button>}
      </div>
      {saved.length > 0 && <p className="pj-quick-done"><Check size={13} aria-hidden="true" /> Сохранено: {saved.join(", ")}</p>}
    </div>
  );
}

function labelForKey(key: string) {
  for (const group of COMPANY_FIELDS) for (const field of group.fields) if (field.key === key) return field.label;
  return labelOf(key);
}

/**
 * Группа полей без пустого места: заполненные поля — как обычно, пустые сжаты в одну строку «+ Телефон  + Почта …».
 * Нажали на пустое — оно раскрывается сразу в режиме правки; сохранили пустым — снова уходит в строку.
 */
export function FieldGroup({ fields, props, readOnly, onSave, onOpenLink }: {
  fields: Field[];
  props: Record<string, unknown> | undefined;
  readOnly?: boolean;
  onSave: (key: string, value: string, previousKey: string) => Promise<void>;
  onOpenLink?: (url: string) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const filled = fields.filter((field) => fieldValue(props, field).value || field.key === adding);
  const empty = fields.filter((field) => !fieldValue(props, field).value && field.key !== adding);
  return (
    <>
      {filled.map((field) => (
        <PropField key={field.key} field={field} props={props} readOnly={readOnly} onSave={onSave} onOpenLink={onOpenLink} autoEdit={field.key === adding} onDone={() => { if (field.key === adding) setAdding(null); }} />
      ))}
      {!readOnly && empty.length > 0 && (
        <div className={`pj-empty-fields${filled.length ? "" : " is-alone"}`}>
          {empty.map((field) => (
            <button key={field.key} type="button" className="pj-empty-chip" onClick={() => setAdding(field.key)} title={field.hint || `Добавить: ${field.label}`}>
              <Plus size={12} aria-hidden="true" />{field.label}
            </button>
          ))}
        </div>
      )}
      {readOnly && !filled.length && <p className="pj-muted">Не заполнено.</p>}
    </>
  );
}
