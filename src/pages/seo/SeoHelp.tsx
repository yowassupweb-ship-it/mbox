import { ChevronDown, Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { SEO_HELP } from "./helpTexts";
import "../../styles/seo-help.css";

/**
 * Пояснение к вкладке: зачем она, какая польза и как с ней работать. Раскрыто, пока человек не свернул его;
 * выбор помнится отдельно для каждой вкладки (localStorage может быть недоступен — тогда просто всегда раскрыто).
 */
const KEY = (id: string) => `mbox.seo.help.${id}`;

function readClosed(id: string) {
  try { return localStorage.getItem(KEY(id)) === "closed"; } catch { return false; }
}

export function SeoHelp({ viewId }: { viewId: string }) {
  const entry = SEO_HELP[viewId];
  const [closed, setClosed] = useState(() => readClosed(viewId));
  useEffect(() => { setClosed(readClosed(viewId)); }, [viewId]);
  if (!entry) return null;

  const toggle = () => {
    const next = !closed;
    setClosed(next);
    try { localStorage.setItem(KEY(viewId), next ? "closed" : "open"); } catch { /* без памяти: просто переключаем на экране */ }
  };

  return (
    <aside className="seo-help" aria-label="Как пользоваться этой вкладкой">
      <button type="button" className="seo-help-head" onClick={toggle} aria-expanded={!closed} aria-controls={`seo-help-${viewId}`}>
        <Lightbulb size={15} aria-hidden="true" />
        <strong>{entry.title}</strong>
        <span>{closed ? "Как пользоваться" : "Свернуть"}</span>
        <ChevronDown size={15} aria-hidden="true" className={closed ? "" : "is-open"} />
      </button>
      {!closed && (
        <div className="seo-help-body" id={`seo-help-${viewId}`}>
          <dl>
            <div><dt>Зачем</dt><dd>{entry.why}</dd></div>
            <div><dt>Какая польза</dt><dd>{entry.benefit}</dd></div>
          </dl>
          <div className="seo-help-how">
            <h4>Как пользоваться</h4>
            <ol>{entry.how.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
          {entry.tip && <p className="seo-help-tip"><b>Важно:</b> {entry.tip}</p>}
        </div>
      )}
    </aside>
  );
}
