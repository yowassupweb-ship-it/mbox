import { useMemo, useState } from "react";
import { BarChart3, Bug, Cloud, Figma, Globe, LineChart, Play, RefreshCw, Rss, Theater, TrendingUp, X, type LucideIcon } from "lucide-react";
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
          <button type="button" onClick={reload} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
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

/** Плитки инструментов в духе значков приложений macOS: свой символ и цвет у каждого, а не одна картинка на всех. */
const TOOL_GLYPHS: Record<string, { icon: LucideIcon; color: string }> = {
  "tour-feed": { icon: Rss, color: "#f59e0b" },
  "wordstat-api": { icon: TrendingUp, color: "#ef4444" },
  "topvisor-api": { icon: BarChart3, color: "#3b82f6" },
  "metrica-api": { icon: LineChart, color: "#ec4899" },
  "webmaster-api": { icon: Globe, color: "#8b5cf6" },
  "playwright-mcp": { icon: Theater, color: "#16a34a" },
  "chrome-devtools-mcp": { icon: Bug, color: "#0ea5e9" },
  "browserbase-stagehand": { icon: Cloud, color: "#f97316" },
  figma: { icon: Figma, color: "#a259ff" },
};

function tileColor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 55% 48%)`;
}

/** Значки инструментов из набора MBOX (public/assets/icons/tools) — важнее картинки из каталога сервера. */
const TOOL_IMAGES: Record<string, string> = {
  "vk-tour-bot": "/assets/icons/tools/vk-tour-bot.png",
  "tour-feed": "/assets/icons/tools/tour-feed.png",
  "wordstat-api": "/assets/icons/tools/wordstat-api.png",
  "topvisor-api": "/assets/icons/tools/topvisor-api.png",
  "metrica-api": "/assets/icons/tools/metrica-api.png",
  "webmaster-api": "/assets/icons/tools/webmaster-api.png",
  "playwright-mcp": "/assets/icons/tools/playwright-mcp.png",
  "chrome-devtools-mcp": "/assets/icons/tools/chrome-devtools-mcp.png",
  "browserbase-stagehand": "/assets/icons/tools/browserbase-stagehand.png",
  figma: "/assets/icons/tools/figma.png",
  obscura: "/assets/icons/tools/obscura.png",
};

/** Своя картинка из набора, затем из каталога (кроме общей заглушки), иначе символ на цветной плитке или первая буква. */
export function ToolIcon({ id = "", src, name, size }: { id?: string; src: string; name: string; size: number }) {
  const own = TOOL_IMAGES[id];
  const image = own || src;
  const generic = !image || (!own && /\/project\/sources\.png$/.test(image));
  const [failed, setFailed] = useState(generic);
  const glyph = TOOL_GLYPHS[id];
  if (!failed && (own || !glyph)) return <img className="wb-tool-tile is-image" src={image} width={size} height={size} alt="" onError={() => setFailed(true)} />;
  const Icon = glyph?.icon;
  return (
    <span className="wb-tool-tile" style={{ width: size, height: size, ["--tile" as string]: glyph?.color || tileColor(name) }} aria-hidden="true">
      {Icon ? <Icon size={Math.round(size * 0.56)} strokeWidth={2} /> : <b style={{ fontSize: Math.round(size * 0.46) }}>{name.slice(0, 1)}</b>}
    </span>
  );
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
          <button type="button" onClick={reload} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
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
                      <ToolIcon id={tool.id} src={tool.planned ? "" : tool.icon} name={tool.name} size={36} />
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
