import { AlertTriangle, ChevronDown, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";

/**
 * Сторож: что должно было произойти по расписанию и не произошло. Сервер сравнивает ожидаемое с фактом (server/seo-activity.mjs),
 * экран показывает результат над вкладками, чтобы поломку не пришлось искать. Обновляется раз в пять минут и после каждого сбора.
 */
type Alert = { id: string; level: "high" | "medium" | "info"; title: string; text: string; action: { label: string; tab: string; view?: string } | null };

const LEVEL_WORD: Record<Alert["level"], string> = { high: "Важно", medium: "Проверить", info: "К сведению" };
const SHOWN = 3;

export function SeoAlerts({ onOpen, refreshKey }: { onOpen: (tab: string, view?: string) => void; refreshKey: string }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ alerts: Alert[] }>("/api/mbox/seo/health");
      setAlerts(data.alerts || []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  if (failed && !alerts) return <p className="seo-alerts-note" role="status">Не удалось проверить, всё ли сработало по расписанию: нет связи с сервером. Повторю через несколько минут.</p>;
  if (!alerts) return null;
  if (!alerts.length) {
    return <p className="seo-alerts-ok" role="status"><ShieldCheck size={14} aria-hidden="true" /> Всё сработало по расписанию: сбор, позиции и спрос в порядке.</p>;
  }
  const shown = all ? alerts : alerts.slice(0, SHOWN);
  return (
    <section className="seo-alerts" aria-label="Что не сработало">
      <ul>
        {shown.map((item) => (
          <li key={item.id} data-level={item.level}>
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <strong><b>{LEVEL_WORD[item.level]}</b> {item.title}</strong>
              <p>{item.text}</p>
            </div>
            {item.action && <button type="button" onClick={() => onOpen(item.action!.tab, item.action!.view)}>{item.action.label}</button>}
          </li>
        ))}
      </ul>
      {alerts.length > SHOWN && (
        <button type="button" className="seo-alerts-more" onClick={() => setAll((value) => !value)} aria-expanded={all}>
          {all ? "Свернуть" : `Показать ещё ${alerts.length - SHOWN}`}<ChevronDown size={13} aria-hidden="true" className={all ? "is-open" : ""} />
        </button>
      )}
    </section>
  );
}
