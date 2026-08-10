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
};

export function BottomNav({ sections, activeSection, onSelect }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Основные разделы">
      <div className="bottom-nav-inner">
        {sections.map(({ key, label, icon: Icon }) => (
          <button className={activeSection === key ? "nav-item active" : "nav-item"} key={key} onClick={() => onSelect(key)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
