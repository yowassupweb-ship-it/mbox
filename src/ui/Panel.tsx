import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Panel({ title, icon: Icon, actions, className = "", children }: { title: string; icon?: LucideIcon; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      <div className="panel-title">
        {Icon && <Icon size={18} />}
        <h2>{title}</h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Metric({ title, value, subtitle, icon: Icon }: { title: string; value: number | string; subtitle: string; icon: LucideIcon }) {
  return (
    <article className="metric-card">
      <div className="metric-icon"><Icon size={20} /></div>
      <span>{title}</span>
      <div className="metric-card-row">
        <strong>{value}</strong>
        <small>{subtitle}</small>
      </div>
    </article>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <section className="metrics-grid">{children}</section>;
}

export function EmptyState({ text }: { text: string }) {
  return <p className="muted empty-state">{text}</p>;
}

export function Toolbar({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`toolbar${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Badge({ tone = "neutral", title, children }: { tone?: "neutral" | "ok" | "live" | "warn" | "danger"; title?: string; children: ReactNode }) {
  return <span className={`meta-chip tone-${tone}`} title={title}>{children}</span>;
}

/** Таблица всегда скроллится внутри себя — страница по горизонтали ехать не должна. */
export function TableWrap({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`table-wrap${className ? ` ${className}` : ""}`}>{children}</div>;
}
