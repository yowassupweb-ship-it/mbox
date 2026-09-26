import { useMemo, useState } from "react";
import { Play, RefreshCw, X } from "lucide-react";
import { openSkillPage } from "./agentTabs";
import { formatLastUsed, skillGroup, useSkillsCatalog, useToolsCatalog } from "./catalog";
import { usePersistentState, type TabsApi } from "./tabs";
import { OctopusSpinner } from "../../components/OctopusSpinner";

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
      <Filter value={filter} onChange={setFilter} placeholder="Что нужно сделать?" />
      <div className="wb-view-body">
        {loading && <OctopusSpinner />}
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
                    {/* Кто исполняет — на странице навыка; в списке только то, что меняется: как часто пользуются. */}
                    {skill.calls > 0 && (
                      <span className="wb-menu-item-meta">
                        {skill.calls} {plural(skill.calls, "вызов", "вызова", "вызовов")}{skill.last_used_at ? ` · ${formatLastUsed(skill.last_used_at)}` : ""}
                      </span>
                    )}
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
                <span className="wb-menu-item-meta">{mode.calls} {plural(mode.calls, "вызов", "вызова", "вызовов")}{mode.last_used_at ? ` · ${formatLastUsed(mode.last_used_at)}` : ""}</span>
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

/** Готов, нужна настройка или заготовка — по полю status/planned каталога. */
function toolTone(tool: { status: string; planned?: boolean }) {
  if (tool.planned) return "is-planned";
  if (/нужн|авторизац|не установ|ошибк/i.test(tool.status)) return "is-warn";
  return "is-ok";
}

export function ToolsView({ tabs }: { tabs: TabsApi }) {
  const { data, loading, reload } = useToolsCatalog();
  const [filter, setFilter] = usePersistentState("mbox.tools.filter", "");
  const [collapsed, setCollapsed] = usePersistentState<string[]>("mbox.tools.collapsed", []);
  const needle = filter.trim().toLowerCase();
  const tools = data.tools.filter((tool) => !needle || `${tool.name} ${tool.kind} ${tool.summary} ${tool.group || ""} ${tool.capabilities.join(" ")}`.toLowerCase().includes(needle));
  const groups = [...tools.reduce((map, tool) => map.set(tool.group || "Другое", [...(map.get(tool.group || "Другое") ?? []), tool]), new Map<string, typeof tools>())];

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
        {loading && <OctopusSpinner />}
        {groups.map(([group, items]) => {
          const open = Boolean(needle) || !collapsed.includes(group);
          const planned = items.every((tool) => tool.planned);
          return (
            <section key={group} className="wb-menu-group">
              <button type="button" className="wb-menu-group-head" onClick={() => setCollapsed((current) => (current.includes(group) ? current.filter((item) => item !== group) : [...current, group]))}>
                <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>{group}{planned && <i className="wb-tool-soon">скоро</i>}<b>{items.length}</b>
              </button>
              {open && items.map((tool) => {
                const key = `tool:${tool.id}`;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className={["wb-menu-item has-icon wb-tool-item", tabs.active === key ? "is-active" : "", tool.planned ? "is-planned" : ""].filter(Boolean).join(" ")}
                    onClick={() => tabs.open(key)}
                    onDoubleClick={() => tabs.open(key, true)}
                    title={`${tool.summary}\n\n${tool.status}`}
                  >
                    <span className={`wb-tool-glyph ${toolTone(tool)}`}>
                      <ToolIcon src={tool.planned ? "" : tool.icon} name={tool.name} size={20} />
                      <i aria-hidden="true" />
                    </span>
                    <span className="wb-menu-item-title">{tool.name}</span>
                    <span className="wb-menu-item-meta">{tool.kind}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {!loading && !tools.length && <p className="wb-empty">{needle ? "Ничего не найдено" : "Инструментов пока нет"}</p>}
      </div>
    </div>
  );
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
