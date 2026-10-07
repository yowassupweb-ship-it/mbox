import { ArrowRight, CircleCheck, CircleSlash, Lightbulb, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { SourceView, Strategy, StrategyItem } from "./seoTypes";
import "../../styles/seo-flow.css";

const SOURCE_TEXT: Record<SourceView["status"], string> = { ok: "данные есть", stale: "устарел", error: "ошибка", not_configured: "не подключён", empty: "нет данных" };

const COLUMNS: Array<{ id: keyof Strategy["columns"]; title: string; lead: string; icon: ReactNode }> = [
  { id: "have", title: "Имеем", lead: "приходит и свежее", icon: <CircleCheck size={16} aria-hidden="true" /> },
  { id: "can", title: "Можем", lead: "умеет система на этих данных", icon: <Wrench size={16} aria-hidden="true" /> },
  { id: "could", title: "Могли бы", lead: "если подключить или включить", icon: <Lightbulb size={16} aria-hidden="true" /> },
  { id: "cannot", title: "Не можем", lead: "границы, которые не снять настройкой", icon: <CircleSlash size={16} aria-hidden="true" /> },
];

export function SeoStrategyView({ data, onOpen }: { data: Strategy; onOpen: (tab: string, view?: string) => void }) {
  const { connected, total, stale } = data.summary;
  return (
    <div className="seo-strategy-page">
      <section className={`seo-hero ${connected * 2 < total || stale ? "is-warn" : "is-ok"}`} aria-label="Итог по источникам">
        <p className="seo-hero-kicker">Реальность на сегодня</p>
        <h2 className="seo-hero-title">{connected} из {total} источников дают данные{stale ? `, ${stale} устарело` : ""}</h2>
        <p className="seo-hero-text">Стратегия ниже построена на том, что реально приходит. Что подключено — работает; чего нет — названо и сказано, что его откроет.</p>
        <ul className="seo-sources" aria-label="Источники данных">
          {data.sources.map((item) => (
            <li key={item.key} className={`is-${item.status}`} title={item.note || undefined}>
              <i aria-hidden="true" />
              <span>{item.label}</span>
              <small>{SOURCE_TEXT[item.status]}{item.age_days !== null && item.status !== "empty" && item.status !== "not_configured" ? ` · ${item.age_days === 0 ? "сегодня" : `${item.age_days} дн.`}` : ""}</small>
            </li>
          ))}
        </ul>
      </section>

      <div className="seo-quad">
        {COLUMNS.map((column) => (
          <section key={column.id} className={`seo-quad-col is-${column.id}`} aria-label={column.title}>
            <header>
              <span className="seo-quad-icon">{column.icon}</span>
              <h3>{column.title}</h3>
              <span className="seo-quad-count">{data.columns[column.id].length}</span>
            </header>
            <p className="seo-quad-lead">{column.lead}</p>
            <ul>
              {data.columns[column.id].map((item) => <QuadItem key={item.id} item={item} onOpen={onOpen} />)}
              {!data.columns[column.id].length && <li className="seo-quad-empty">Пусто: всё уже подключено</li>}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function QuadItem({ item, onOpen }: { item: StrategyItem; onOpen: (tab: string, view?: string) => void }) {
  return (
    <li className={item.tone === "warn" ? "seo-quad-item is-warn" : "seo-quad-item"}>
      <strong>{item.title}</strong>
      <p>{item.detail}</p>
      {item.evidence && <small className="seo-quad-evidence">{item.evidence}</small>}
      {item.needs && <small className="seo-quad-needs"><b>Нужно:</b> {item.needs}</small>}
      {item.action && <button type="button" onClick={() => onOpen(item.action!.tab, item.action!.view)}>{item.action.label}<ArrowRight size={12} aria-hidden="true" /></button>}
    </li>
  );
}
