import { useState } from "react";
import { X } from "lucide-react";
import { useSettingsSection, visibleGroups, type SettingsSectionId } from "./sections";

/** Разделы настроек в обычной боковой панели MBOX — как проекты или задачи. Нажатие открывает вкладку «Настройки» на разделе. */
export function SettingsSidebar({ owner, onOpen }: { owner: boolean; onOpen: (id: SettingsSectionId) => void }) {
  const [section, setSection] = useSettingsSection();
  const [filter, setFilter] = useState("");
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = visibleGroups(owner)
    .map((group) => ({ ...group, items: group.items.filter((item) => words.every((word) => `${item.label} ${item.hint} ${item.keywords}`.toLowerCase().includes(word))) }))
    .filter((group) => group.items.length);

  return (
    <div className="wb-view st-sidebar">
      <header className="wb-view-head"><span>Настройки</span></header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Найти настройку" aria-label="Найти настройку" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <nav className="wb-view-body" aria-label="Разделы настроек">
        {groups.map((group) => (
          <section className="wb-menu-group" key={group.title}>
            <div className="wb-menu-group-head is-static">{group.title}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === section ? "wb-menu-item has-icon st-side-item is-active" : "wb-menu-item has-icon st-side-item"}
                  aria-current={item.id === section ? "page" : undefined}
                  onClick={() => { setSection(item.id); onOpen(item.id); }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="wb-menu-item-title">{item.label}</span>
                  <span className="wb-menu-item-meta">{item.hint}</span>
                </button>
              );
            })}
          </section>
        ))}
        {!groups.length && <p className="wb-view-empty">Ничего не нашлось</p>}
      </nav>
    </div>
  );
}
