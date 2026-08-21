import type { SectionKey } from "../types";

type NavSection = {
  key: SectionKey;
  label: string;
  image: string;
};

type BottomNavProps = {
  sections: NavSection[];
  activeSection: SectionKey;
  onSelect: (section: SectionKey) => void;
  hrefFor: (section: SectionKey) => string;
  badges?: Partial<Record<SectionKey, number>>;
};

export function BottomNav({ sections, activeSection, onSelect, hrefFor, badges }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Основные разделы">
      <div className="bottom-nav-inner">
        {sections.map(({ key, label, image }) => (
          <a className={activeSection === key ? "nav-item active" : "nav-item"} href={hrefFor(key)} key={key} onClick={(event) => {
            event.preventDefault();
            onSelect(key);
          }}>
            <img src={image} width={18} height={18} alt="" />
            <span>{label}</span>
            {Boolean(badges?.[key]) && <b className="nav-badge" aria-label={`${badges![key]} непрочитанных`}>{badges![key]}</b>}
          </a>
        ))}
      </div>
    </nav>
  );
}
