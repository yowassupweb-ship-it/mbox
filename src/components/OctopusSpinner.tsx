import { useWorkingFrame, WORKING_FRAMES } from "./AgentAvatar";

// Кадры грузим заранее: иначе первый оборот спиннера мигал пустыми картинками, пока каждая подтягивалась.
if (typeof Image !== "undefined") for (const src of WORKING_FRAMES) new Image().src = src;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Ожидание данных — маскот MBOX шевелит щупальцами. Раньше пустой список до ответа сервера выглядел как «ничего нет». */
export function OctopusSpinner({ label = "Загрузка…", size = 40, compact = false }: { label?: string; size?: number; compact?: boolean }) {
  const frame = useWorkingFrame(!reducedMotion());
  return (
    <div className={compact ? "octopus-spinner is-compact" : "octopus-spinner"} role="status" aria-live="polite">
      <img src={frame} width={size} height={size} alt="" />
      {label && <span>{label}</span>}
    </div>
  );
}
