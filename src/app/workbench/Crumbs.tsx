import { Fragment, useState, type ReactNode } from "react";

/**
 * «Хлебные крошки» в шапке документа — каждый пункт кликабельный и ведёт на уровень выше:
 * раздел открывает боковую панель, проект — показывает его в дереве, список — открывает список.
 * Последний пункт — текущий документ; если у него есть номер, клик копирует его.
 */
export type Crumb = { label: ReactNode; onClick?: () => void; title?: string; copy?: string };

export function Crumbs({ items, suffix }: { items: Crumb[]; suffix?: ReactNode }) {
  const [copied, setCopied] = useState("");
  return (
    <span className="wb-doc-crumbs">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const copy = item.copy;
        const action = item.onClick ?? (copy ? () => {
          void navigator.clipboard?.writeText(copy).then(() => { setCopied(copy); window.setTimeout(() => setCopied(""), 1400); });
        } : undefined);
        return (
          <Fragment key={index}>
            {index > 0 && <span className="wb-crumb-sep" aria-hidden="true">›</span>}
            {action ? (
              <button
                type="button"
                className={last ? "wb-crumb is-current" : "wb-crumb"}
                onClick={action}
                title={copy ? (copied === copy ? "Скопировано" : `Скопировать ${copy}`) : item.title}
              >
                {copied && copied === copy ? "Скопировано" : item.label}
              </button>
            ) : (
              <span className={last ? "wb-crumb is-current is-static" : "wb-crumb is-static"}>{item.label}</span>
            )}
          </Fragment>
        );
      })}
      {suffix}
    </span>
  );
}

/** Показать раздел в боковой панели (и проект в дереве) — слушает Workbench и ExplorerView. */
export const REVEAL_EVENT = "mbox:reveal";
export type RevealDetail = { activity: string; projectId?: string };

export function reveal(activity: string, projectId?: string) {
  window.dispatchEvent(new CustomEvent<RevealDetail>(REVEAL_EVENT, { detail: { activity, projectId } }));
}
