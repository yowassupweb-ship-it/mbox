import { useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, CircleCheck, Copy, Info, type LucideIcon } from "lucide-react";
import { apiErrorCode } from "../../lib/api";
import { accountErrorText } from "../accounts/accountErrors";

/**
 * Кирпичи раздела «Настройки» (src/styles/settings.css). Один набор на все разделы: карточка с заголовком и действиями справа,
 * строка списка, переключатель, плашка-подсказка, поле «скопировать». Раньше каждый раздел нёс свою вёрстку своей эпохи.
 */

export function Card({ title, hint, actions, children, id }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <section className="st-card" id={id}>
      {(title || actions) && (
        <header className="st-card-head">
          <div className="st-card-title">
            {title && <h3>{title}</h3>}
            {hint && <p>{hint}</p>}
          </div>
          {actions && <div className="st-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Строка списка: значок, название и подпись, справа — состояние и действия; раскрывается, если передан details. */
export function Row({ icon: Icon, lead, title, meta, side, details, open, onToggle }: {
  icon?: LucideIcon; lead?: ReactNode; title: ReactNode; meta?: ReactNode; side?: ReactNode; details?: ReactNode; open?: boolean; onToggle?: () => void;
}) {
  const expandable = Boolean(details) && Boolean(onToggle);
  const head = (
    <>
      {lead ?? (Icon && <span className="st-row-icon" aria-hidden="true"><Icon size={16} /></span>)}
      <span className="st-row-main">
        <span className="st-row-title">{title}</span>
        {meta && <span className="st-row-meta">{meta}</span>}
      </span>
    </>
  );
  return (
    <li className={open ? "st-row is-open" : "st-row"}>
      <div className="st-row-head">
        {expandable ? (
          <button type="button" className="st-row-toggle" aria-expanded={open} onClick={onToggle}>
            {head}
            <ChevronDown size={15} className="st-row-chevron" aria-hidden="true" />
          </button>
        ) : <div className="st-row-static">{head}</div>}
        {side && <div className="st-row-side">{side}</div>}
      </div>
      {open && details && <div className="st-row-details">{details}</div>}
    </li>
  );
}

export function Rows({ children, empty }: { children: ReactNode; empty?: ReactNode }) {
  const list = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : [];
  if (!list.length && empty) return <p className="st-empty">{empty}</p>;
  return <ul className="st-rows">{children}</ul>;
}

/** Переключатель: подпись слева, тумблер справа. Вся строка нажимается. */
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={disabled ? "st-switch is-disabled" : "st-switch"}>
      <span className="st-switch-text"><span>{label}</span>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="st-switch-track" aria-hidden="true"><span /></span>
    </label>
  );
}

export function Notice({ tone = "info", title, children, actions }: { tone?: "info" | "ok" | "warn" | "danger"; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheck : tone === "info" ? Info : CircleAlert;
  return (
    <div className={`st-notice is-${tone}`} role={tone === "danger" || tone === "warn" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div className="st-notice-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
        {actions && <div className="st-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "ok" | "warn" | "danger" | "accent"; children: ReactNode }) {
  return <span className={`st-badge is-${tone}`}>{children}</span>;
}

export function CopyField({ value, label = "Скопировать", secret = false }: { value: string; label?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* выделить вручную */ }
  }
  return (
    <div className="st-copy">
      <code className={secret ? "is-secret" : undefined} onClick={(event) => { const range = document.createRange(); range.selectNodeContents(event.currentTarget); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }}>{value || "…"}</code>
      <button type="button" className="st-btn" onClick={() => void copy()} disabled={!value}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Скопировано" : label}</button>
    </div>
  );
}

/** Сводная плашка сверху раздела: несколько чисел или состояний. */
export function Stats({ items }: { items: Array<{ label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "danger"; meter?: number }> }) {
  return (
    <div className="st-stats">
      {items.map((item) => (
        <div className={item.tone ? `st-stat is-${item.tone}` : "st-stat"} key={item.label}>
          <span className="st-stat-label">{item.label}</span>
          <strong className="st-stat-value">{item.value}</strong>
          {item.meter !== undefined && <span className="st-meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, item.meter))}%` }} /></span>}
          {item.hint && <span className="st-stat-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/** Сегментный выбор (вкладки внутри раздела). */
export function Segments<T extends string>({ value, onChange, items, label }: { value: T; onChange: (next: T) => void; items: Array<{ id: T; label: ReactNode }>; label: string }) {
  return (
    <div className="st-segments" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={value === item.id} className={value === item.id ? "is-active" : undefined} onClick={() => onChange(item.id)}>{item.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "st-field is-wide" : "st-field"}>
      <span className="st-field-label">{label}</span>
      {children}
      {hint && <small className="st-field-hint">{hint}</small>}
    </label>
  );
}

/** Текст ошибки сервера, если он человеческий (сервер MBOX отдаёт русский текст в error), иначе запасной. */
export function errorText(cause: unknown, fallback: string) {
  const known = accountErrorText(cause, "");
  if (known) return known;
  const code = apiErrorCode(cause);
  return code && /[а-яё]/i.test(code) ? code : fallback;
}
