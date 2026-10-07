import type { AgentUsage, DailyModelUsage, UsageWindow } from "../hooks/useAgentUsage";

/** «через 2 ч 10 мин», «через 3 дн.» — сколько до сброса окна. */
export function untilReset(resetsAt: number | undefined, now = Date.now()) {
  if (!resetsAt) return "";
  const minutes = Math.round((resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return "сброс уже прошёл";
  if (minutes < 60) return `сброс через ${minutes} мин`;
  if (minutes < 48 * 60) return `сброс через ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `сброс через ${Math.round(minutes / 1440)} дн.`;
}

/** Данные старше этого — наблюдатель давно не отчитывался, цифры могли уйти. */
const STALE_MS = 6 * 60 * 60 * 1000;

const used = (value: number | undefined) => Math.max(0, Math.min(100, Math.round(value ?? 0)));
const tone = (percent: number) => (percent >= 90 ? "is-danger" : percent >= 70 ? "is-warn" : "is-ok");

/** Короткая подпись окна в строке: 5ч, нед, 2д. Полное название — в подсказке. */
export function shortWindowLabel(window: UsageWindow) {
  if (window.id === "week") return "нед";
  const match = /^(\d+)([hdm])$/.exec(window.id);
  if (match) return `${match[1]}${match[2] === "h" ? "ч" : match[2] === "d" ? "д" : "м"}`;
  return window.label.slice(0, 4);
}

/** Сначала короткие окна: 5 часов, потом неделя. */
function windowMinutes(window: UsageWindow) {
  if (window.id === "week") return 7 * 1440;
  const match = /^(\d+)([hdm])$/.exec(window.id);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * (match[2] === "h" ? 60 : match[2] === "d" ? 1440 : 1);
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(".", ",")}K`;
  return String(value);
}

function staleNote(updatedAt: string | null | undefined, now = Date.now()) {
  const at = Date.parse(updatedAt || "");
  if (!Number.isFinite(at) || now - at < STALE_MS) return "";
  return `данные от ${new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** Подсказка: каждое окно отдельной строкой. */
export function usageSummary(windows: UsageWindow[]) {
  return windows
    .map((window) => {
      const reset = untilReset(window.resets_at);
      return `${window.label}: израсходовано ${used(window.used_percent)}%, осталось ${100 - used(window.used_percent)}%${reset ? ` · ${reset}` : ""}`;
    })
    .join("\n");
}

function dailySummary(models: DailyModelUsage[]) {
  if (!models.length) return "Сегодня вызовов не было";
  return models
    .map((model) => {
      const quota = model.limit_tokens ? ` · ${used(model.used_percent)}% суточной квоты ${formatTokens(model.limit_tokens)}` : "";
      return `${model.model}: ${formatTokens(model.tokens_today)} ток., ${model.calls_today} выз.${quota}`;
    })
    .join("\n");
}

function Meter({ label, percent }: { label: string; percent: number }) {
  return (
    <span className={`usage-meter ${tone(percent)}`}>
      <i>{label}</i>
      <span className="usage-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      <b>{percent}%</b>
    </span>
  );
}

/**
 * Расход агента в строке списка. Claude и Codex — подписка с двумя окнами (5 часов и неделя): по мини-шкале на окно,
 * шкала заполняется по мере расхода, процент — сколько израсходовано. Джарвис — бесплатные API с суточными квотами
 * по моделям: токены за сегодня, а где квота известна — шкала «сут». Подробности и время сброса — в подсказке.
 */
export function UsageMeters({ usage }: { usage?: AgentUsage }) {
  if (!usage) return null;
  if (usage.kind === "daily") {
    const tokens = usage.models.reduce((sum, model) => sum + model.tokens_today, 0);
    const quota = usage.models.filter((model) => model.used_percent !== undefined);
    const tightest = quota.reduce<DailyModelUsage | undefined>((worst, model) => (!worst || (model.used_percent ?? 0) > (worst.used_percent ?? 0) ? model : worst), undefined);
    const summary = `Джарвис, бесплатные API — расход за сегодня\n${dailySummary(usage.models)}`;
    return (
      <span className="usage-meters" title={summary} aria-label={summary.replace(/\n/g, ". ")} role="img">
        {tightest && <Meter label="сут" percent={used(tightest.used_percent)} />}
        <span className="usage-today"><i>сегодня</i><b>{formatTokens(tokens)}</b></span>
      </span>
    );
  }
  const windows = [...(usage.windows ?? [])].sort((a, b) => windowMinutes(a) - windowMinutes(b));
  if (!windows.length) return null;
  const stale = staleNote(usage.updated_at);
  const summary = `Лимиты подписки\n${usageSummary(windows)}${stale ? `\n${stale}` : ""}`;
  return (
    <span className={stale ? "usage-meters is-stale" : "usage-meters"} title={summary} aria-label={summary.replace(/\n/g, ". ")} role="img">
      {windows.map((window) => <Meter key={window.id} label={shortWindowLabel(window)} percent={used(window.used_percent)} />)}
    </span>
  );
}
