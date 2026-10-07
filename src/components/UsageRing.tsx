import type { AgentUsage, UsageWindow } from "../hooks/useAgentUsage";

/** «через 2 ч 10 мин», «через 3 дн.» — сколько до сброса окна. */
export function untilReset(resetsAt: number | undefined, now = Date.now()) {
  if (!resetsAt) return "";
  const minutes = Math.round((resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return "сброс уже прошёл";
  if (minutes < 60) return `сброс через ${minutes} мин`;
  if (minutes < 48 * 60) return `сброс через ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `сброс через ${Math.round(minutes / 1440)} дн.`;
}

const remaining = (window: UsageWindow) => Math.max(0, Math.min(100, Math.round(100 - window.used_percent)));

/** Подсказка: каждое окно отдельной строкой. */
export function usageSummary(windows: UsageWindow[]) {
  return windows.map((window) => `${window.label}: осталось ${remaining(window)}%${untilReset(window.resets_at) ? `, ${untilReset(window.resets_at)}` : ""}`).join("\n");
}

/**
 * Кружок лимита агента: дуга — сколько осталось в самом тесном окне (полный круг — всё доступно, пустой — упёрлись),
 * рядом процент. Цвет: достаточно / на исходе / почти нет. Подробности по каждому окну — в подсказке.
 */
export function UsageRing({ usage, size = 18, showValue = true }: { usage?: AgentUsage; size?: number; showValue?: boolean }) {
  const windows = usage?.windows ?? [];
  if (!windows.length) return null;
  const tightest = windows.reduce((worst, item) => (item.used_percent > worst.used_percent ? item : worst), windows[0]);
  const left = remaining(tightest);
  const tone = left <= 10 ? "is-danger" : left <= 30 ? "is-warn" : "is-ok";
  const radius = 7;
  const length = 2 * Math.PI * radius;
  const summary = usageSummary(windows);
  return (
    <span className={`usage-ring ${tone}`} title={summary} aria-label={`Лимиты. ${summary.replace(/\n/g, ". ")}`} role="img">
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <circle className="usage-ring-track" cx="9" cy="9" r={radius} />
        <circle className="usage-ring-arc" cx="9" cy="9" r={radius} strokeDasharray={`${(length * left) / 100} ${length}`} transform="rotate(-90 9 9)" />
      </svg>
      {showValue && <b>{left}%</b>}
    </span>
  );
}
