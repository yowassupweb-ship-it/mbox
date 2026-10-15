/**
 * Ожидание данных — системный спиннер в духе Apple: двенадцать палочек к центру по кругу, яркость бежит по часовой.
 * (Раньше здесь шевелил щупальцами пиксельный осьминог; имя компонента оставлено, чтобы не трогать все места вызова.)
 * Пустой список до ответа сервера не должен выглядеть как «ничего нет» — поэтому спиннер с подписью.
 */
export function OctopusSpinner({ label = "Загрузка…", size = 28, compact = false }: { label?: string; size?: number; compact?: boolean }) {
  return (
    <div className={compact ? "octopus-spinner is-compact" : "octopus-spinner"} role="status" aria-live="polite">
      <Spinner size={compact ? Math.min(size, 18) : size} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <span className="activity-spinner" style={{ width: size, height: size }} aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => <i key={index} style={{ transform: `rotate(${index * 30}deg)`, animationDelay: `${(index - 12) / 12}s` }} />)}
    </span>
  );
}
