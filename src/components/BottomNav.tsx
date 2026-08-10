import type { LucideIcon } from "lucide-react";
import type { SectionKey } from "../types";

type NavSection = {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
};

type BottomNavProps = {
  sections: NavSection[];
  activeSection: SectionKey;
  onSelect: (section: SectionKey) => void;
  hrefFor: (section: SectionKey) => string;
};

export function BottomNav({ sections, activeSection, onSelect, hrefFor }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Основные разделы">
      <div className="bottom-nav-inner">
        {sections.map(({ key, label, icon: Icon }) => (
          <a className={activeSection === key ? "nav-item active" : "nav-item"} href={hrefFor(key)} key={key} onClick={(event) => {
            event.preventDefault();
            onSelect(key);
          }}>
            <Icon size={18} />
            <span>{label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}
