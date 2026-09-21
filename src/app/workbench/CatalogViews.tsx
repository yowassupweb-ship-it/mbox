import { useMemo, useState } from "react";
import { Play, RefreshCw, X } from "lucide-react";
import { openSkillPage } from "./agentTabs";
import { formatLastUsed, skillGroup, useSkillsCatalog, useToolsCatalog } from "./catalog";
import { usePersistentState, type TabsApi } from "./tabs";

function Filter({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="wb-filter">
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} onKeyDown={(event) => { if (event.key === "Escape") onChange(""); }} />
      {value && <button type="button" onClick={() => onChange("")} aria-label="Очистить"><X size={13} /></button>}
    </div>
  );
}

export function SkillsView({ tabs }: { tabs: TabsApi }) {
  const { data, loading, reload } = useSkillsCatalog();
  const [filter, setFilter] = usePersistentState("mbox.skills.filter", "");
  const [collapsed, setCollapsed] = usePersistentState<string[]>("mbox.skills.collapsed", []);
  const needle = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const map = new Map<string, typeof data.skills>();
    for (const skill of data.skills) {
      if (needle && !`${skill.name} ${skill.summary} ${skill.goal || ""} ${skill.category || ""} ${skill.owner} ${skill.id}`.toLowerCase().includes(needle)) continue;
      const group = skillGroup(skill);
      map.set(group, [...(map.get(group) ?? []), skill]);
    }
    return [...map.entries()];
  }, [data.skills, needle]);

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Навыки</span>
        <div className="wb-view-actions">
          <button type="button" onClick={reload} title="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <div className="wb-skills-intro">
        <span>Готовые способы выполнить работу с агентом</span>
        <small>Выберите результат — MBOX откроет нужный сценарий и сохранит итог рядом с проектом.</small>
      </div>
      <Filter value={filter} onChange={setFilter} placeholder="Что нужно сделать?" />
      <div className="wb-view-body">
        {loading && <p className="wb-empty">Загрузка…</p>}
        {groups.map(([group, skills]) => {
          const open = Boolean(needle) || !collapsed.includes(group);
          return (
            <section key={group} className="wb-menu-group">
              <button type="button" className="wb-menu-group-head" onClick={() => setCollapsed((current) => (current.includes(group) ? current.filter((item) => item !== group) : [...current, group]))}>
                <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>{group}<b>{skills.length}</b>
              </button>
              {open && skills.map((skill) => {
                const key = `skill:${skill.id}`;
                const launch = skill.pages?.[0];
                return (
                  <div key={skill.id} className="wb-menu-item-row">
                  <button
                    type="button"
                    className={tabs.active === key ? "wb-menu-item is-active" : "wb-menu-item"}
                    onClick={() => tabs.open(key)}
                    onDoubleClick={() => tabs.open(key, true)}
                    title={skill.summary}
                  >
                    <span className="wb-menu-item-title">{skill.name}</span>
                    <span className="wb-menu-item-meta">
                      {skill.calls > 0 ? `${skill.calls} выз. · ${formatLastUsed(skill.last_used_at)}` : skill.owner.split("·")[0].trim()}
                    </span>
                  </button>
                  {launch && (
                    <button type="button" className="wb-menu-item-launch" onClick={() => openSkillPage(launch, tabs)} title={`Запустить: ${launch.title}`} aria-label={`Запустить ${skill.name}`}>
                      <Play size={12} />
                    </button>
                  )}
                  </div>
                );
              })}
            </section>
          );
        })}
        {!loading && !groups.length && <p className="wb-empty">{needle ? "Ничего не найдено" : "Навыков пока нет"}</p>}
        {data.modes.length > 0 && !needle && (
          <section className="wb-menu-group">
            <div className="wb-menu-group-head is-static">Служебные режимы</div>
            {data.modes.map((mode) => (
              <div key={mode.id} className="wb-menu-item is-static">
                <span className="wb-menu-item-title">{mode.name}</span>
                <span className="wb-menu-item-meta">{mode.calls} выз. · {formatLastUsed(mode.last_used_at)}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** Картинки есть не у всех инструментов — вместо битой иконки первая буква названия. */
export function ToolIcon({ src, name, size }: { src: string; name: string; size: number }) {
  const [failed, setFailed] = useState(!src);
  if (failed) return <span className="wb-menu-item-icon" style={{ width: size, height: size }}>{name.slice(0, 1)}</span>;
  return <img src={src} width={size} height={size} alt="" onError={() => setFailed(true)} />;
}

export function ToolsView({ tabs }: { tabs: TabsApi }) {
  const { data, loading, reload } = useToolsCatalog();
  const [filter, setFilter] = usePersistentState("mbox.tools.filter", "");
  const needle = filter.trim().toLowerCase();
  const tools = data.tools.filter((tool) => !needle || `${tool.name} ${tool.kind} ${tool.summary} ${tool.capabilities.join(" ")}`.toLowerCase().includes(needle));

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Инструменты</span>
        <div className="wb-view-actions">
          <button type="button" onClick={reload} title="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <Filter value={filter} onChange={setFilter} placeholder="Найти инструмент" />
      <div className="wb-view-body">
        {loading && <p className="wb-empty">Загрузка…</p>}
        {tools.map((tool) => {
          const key = `tool:${tool.id}`;
          return (
            <button
              key={tool.id}
              type="button"
              className={tabs.active === key ? "wb-menu-item has-icon is-active" : "wb-menu-item has-icon"}
              onClick={() => tabs.open(key)}
              onDoubleClick={() => tabs.open(key, true)}
              title={tool.summary}
            >
              <ToolIcon src={tool.icon} name={tool.name} size={20} />
              <span className="wb-menu-item-title">{tool.name}</span>
              <span className="wb-menu-item-meta">{tool.kind} · {tool.status}</span>
            </button>
          );
        })}
        {!loading && !tools.length && <p className="wb-empty">{needle ? "Ничего не найдено" : "Инструментов пока нет"}</p>}
      </div>
    </div>
  );
}
