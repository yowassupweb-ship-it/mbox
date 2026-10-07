/** Объёмная иконка раздела планировщика (из shar-2, public/assets/icons/planner) — для пустых состояний. */
export type SectionIconName = 'todo' | 'calendar';

export function SectionIcon({ name, size = 20 }: { name: SectionIconName; size?: number }) {
  return (
    <img
      className="nx-sicon"
      src={`/assets/icons/planner/${name}.png`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
