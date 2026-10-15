import { AlertTriangle, Archive, ArchiveRestore, Building2, ChevronRight, ExternalLink, FileText, GitBranch, Globe, MoreHorizontal, NotebookPen, Palette, Pencil, Plus, Presentation, Table2, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { projectEntityKinds, type ProjectEntityKind } from "../../../features/tree/entityKinds";
import type { MboxData } from "../../../hooks/useMboxData";
import { fetchJson } from "../../../lib/api";
import { formatSince } from "../../../lib/format";
import { todoStatusLabel } from "../../../lib/labels";
import { projectMemoryMatches } from "../../../lib/memory";
import { autoDetectEnabled, MANDATORY_ENTITIES, OPTIONAL_ENTITIES } from "../../../pages/Projects";
import type { Project } from "../../../types";
import { askConfirm, askText, showNotice } from "../../../ui/askText";
import { browserTabKey } from "../BrowserDocument";
import { createDocAndOpen } from "../docsStore";
import { createDesignSystemAndOpen, DESIGN_TAB, pickHtmlFile } from "../designSystemsStore";
import { createNoteAndOpen } from "../Notes";
import { createPresentationAndOpen, SLIDES_TAB } from "../presentationsStore";
import { createTableAndOpen } from "../TablesView";
import type { TabsApi } from "../tabs";
import { TreeGlyph } from "../TreeGlyph";
import { WbMenu } from "../WbMenu";
import { ExtraProps, FieldGroup } from "./PropFields";
import { fieldValue, initials, normalizeUrl, OPEN_STATUSES, patchProject, PROJECT_FIELDS, PROJECT_STATUS, projectStats, setProjectProp, twinCompany } from "./projectFields";
import { materialsOf, useAllMaterials, type Material } from "./useProjectMaterials";
import { removeNow } from "../../../lib/optimistic";

const STATUS_ORDER: Record<string, number> = { doing: 0, blocked: 1, review: 2, next: 3, open: 4 };
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * Страница проекта (вкладка project:<id>): всё, что нужно в работе, на одном экране — статус и компания, ссылки,
 * открытые задачи, материалы (документы, таблицы, презентации, заметки, память, решения), свойства и разделы.
 * Раньше у проекта не было своей страницы: только россыпь вкладок-разделов в дереве и ни одной кнопки «удалить».
 */
export function ProjectPage({ project, data, tabs, isOwner }: { project: Project; data: MboxData; tabs: TabsApi; isOwner: boolean }) {
  const materials = materialsOf(useAllMaterials(), useMemo(() => new Set([project.id]), [project.id]));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [newTodo, setNewTodo] = useState("");
  const stats = projectStats(project);
  const company = data.companies.find((item) => item.id === project.company_id) ?? null;
  const twin = twinCompany(project, data.companies);
  const todoIds = useMemo(() => new Set(project.todos.map((todo) => todo.id)), [project.todos]);
  const memories = data.memories.filter((memory) => projectMemoryMatches(memory, project, todoIds));
  const decisions = data.decisions.filter((decision) => decision.project_id === project.id);
  const files = data.artifacts.filter((file) => file.project_id === project.id);
  const enabled = Array.isArray(project.props?.enabled_entities) ? (project.props.enabled_entities as unknown as string[]) : autoDetectEnabled(project);
  const sections = [...MANDATORY_ENTITIES.filter((kind) => kind !== "properties"), ...OPTIONAL_ENTITIES.filter((kind) => enabled.includes(kind))];
  const addable = OPTIONAL_ENTITIES.filter((kind) => !enabled.includes(kind));
  const reload = () => data.reload();

  const openTodos = project.todos
    .filter((todo) => OPEN_STATUSES.has(todo.status))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));

  const openLink = (url: string) => tabs.open(browserTabKey(url), true);
  const saveProp = async (key: string, value: string, previousKey: string) => { await setProjectProp(project, key, value, previousKey); reload(); };

  async function rename() {
    const name = (await askText({ title: "Название проекта", value: project.name, confirmLabel: "Сохранить" }))?.trim().slice(0, 120);
    if (!name || name === project.name) return;
    try { await patchProject(project, { name }); reload(); } catch { showNotice("Не переименован", "Проект с таким названием уже есть."); }
  }

  async function setStatus(status: string) { await patchProject(project, { status }); reload(); }
  async function setCompany(companyId: string) { await patchProject(project, { company_id: companyId || null }); reload(); }
  async function setColor(color: string) { await patchProject(project, { color }); reload(); }

  async function setSections(next: string[]) {
    await patchProject(project, { props: { ...project.props, enabled_entities: next } });
    reload();
  }

  async function remove() {
    const parts = [`${project.todos.length} задач`, data.folders.filter((folder) => folder.project_id === project.id).length ? "папки проекта" : ""].filter(Boolean).join(" и ");
    const ok = await askConfirm({
      title: `Удалить проект «${project.name}»?`,
      message: `Вместе с ним удалятся ${parts}. Документы, таблицы, заметки, память и решения останутся — без проекта. Вернуть проект нельзя. Если он просто закончился, лучше перевести его в архив.`,
      confirmLabel: "Удалить проект",
      danger: true,
    });
    if (!ok) return;
    tabs.close(`project:${project.id}`);
    await removeNow(data, "projects", project.id);
  }

  async function addTodo() {
    const title = newTodo.trim();
    if (!title) return;
    setNewTodo("");
    await fetchJson("/api/mbox/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: project.id, title, status: "open", priority: "normal", access_level: "private" }) });
    reload();
  }

  const prod = fieldValue(project.props, { key: "domain_prod", label: "", aliases: ["domain"] }).value;
  const test = fieldValue(project.props, { key: "domain_test", label: "" }).value;
  const figma = fieldValue(project.props, { key: "figma_url", label: "", aliases: ["design_figma"] }).value;
  const links = [
    prod && { icon: <Globe size={13} />, label: hostLabel(prod), url: normalizeUrl(prod) },
    test && { icon: <Globe size={13} />, label: `Тест · ${hostLabel(test)}`, url: normalizeUrl(test) },
    project.git_url && { icon: <GitBranch size={13} />, label: repoLabel(project.git_url), url: normalizeUrl(project.git_url) },
    figma && { icon: <TreeGlyph kind="figma" size={13} />, label: "Макет Figma", url: normalizeUrl(figma) },
  ].filter(Boolean) as Array<{ icon: ReactNode; label: string; url: string }>;

  return (
    <div className="pj-page">
      {twin && (
        <TwinBanner project={project} companyName={twin.name} companyId={twin.id} data={data} isOwner={isOwner} onDone={() => { tabs.close(`project:${project.id}`); tabs.open(`company:${twin.id}`, true); reload(); }} />
      )}
      <header className="pj-head">
        <label className="pj-avatar" style={{ ["--pj-color" as string]: project.color || "#8e8e93" }} title="Цвет проекта">
          {initials(project.name)}
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(project.color) ? project.color : "#8e8e93"} onChange={(event) => void setColor(event.target.value)} aria-label="Цвет проекта" />
        </label>
        <div className="pj-head-main">
          <div className="pj-crumbs">
            {company ? (
              <button type="button" className="pj-crumb" onClick={() => tabs.open(`company:${company.id}`, true)}><Building2 size={12} /> {company.name}</button>
            ) : <span className="pj-crumb is-muted">Без компании</span>}
            <ChevronRight size={12} aria-hidden="true" />
            <span>Проект</span>
          </div>
          <h1><button type="button" onClick={() => void rename()} title="Переименовать">{project.name}</button></h1>
          <div className="pj-head-controls">
            <div className="pj-seg" role="radiogroup" aria-label="Статус проекта">
              {PROJECT_STATUS.map((status) => (
                <button key={status.id} type="button" role="radio" aria-checked={project.status === status.id} className={project.status === status.id ? "is-on" : undefined} onClick={() => void setStatus(status.id)}>{status.label}</button>
              ))}
            </div>
            {isOwner && (
              <label className="pj-select">
                <Building2 size={13} aria-hidden="true" />
                <select value={project.company_id || ""} onChange={(event) => void setCompany(event.target.value)} aria-label="Компания">
                  <option value="">Без компании</option>
                  {data.companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
        <button type="button" className="pj-icon pj-head-more" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right - 220, y: rect.bottom + 4 }); }} aria-label="Действия с проектом" title="Действия"><MoreHorizontal size={16} /></button>
      </header>

      {links.length > 0 && (
        <div className="pj-links">
          {links.map((link) => <button key={link.url} type="button" className="pj-chip" onClick={() => openLink(link.url)} title={link.url}>{link.icon}{link.label}<ExternalLink size={11} className="pj-chip-out" /></button>)}
        </div>
      )}

      <div className="pj-grid">
        <section className="pj-card pj-span-2">
          <header className="pj-card-head">
            <h2>Задачи</h2>
            <div className="pj-stats">
              <span><b>{stats.open}</b> открыто</span>
              {stats.doing > 0 && <span className="is-doing"><b>{stats.doing}</b> в работе</span>}
              {stats.review > 0 && <span className="is-review"><b>{stats.review}</b> на проверке</span>}
              {stats.blocked > 0 && <span className="is-blocked"><b>{stats.blocked}</b> заблокировано</span>}
              <span className="is-muted"><b>{stats.done}</b> готово</span>
            </div>
            <button type="button" className="pj-link" onClick={() => tabs.open(`todos:${project.id}`, true)}>Все задачи <ChevronRight size={13} /></button>
          </header>
          <form className="pj-add" onSubmit={(event) => { event.preventDefault(); void addTodo(); }}>
            <Plus size={14} aria-hidden="true" />
            <input value={newTodo} onChange={(event) => setNewTodo(event.target.value)} placeholder="Новая задача — Enter" aria-label="Новая задача" />
          </form>
          {openTodos.length ? (
            <ul className="pj-todos">
              {openTodos.slice(0, 8).map((todo) => (
                <li key={todo.id}>
                  <button type="button" onClick={() => tabs.open(`todo:${todo.id}`, true)}>
                    <span className={`wb-status-dot status-${todo.status}`} aria-hidden="true" />
                    <span className="pj-todo-title">{todo.title}</span>
                    {(todo.priority === "urgent" || todo.priority === "high") && <span className={`wb-priority priority-${todo.priority}`}>!</span>}
                    <span className="pj-todo-status">{todoStatusLabel(todo.status)}</span>
                    <span className="pj-todo-id">#{todo.id}</span>
                  </button>
                </li>
              ))}
              {openTodos.length > 8 && <li className="pj-more"><button type="button" onClick={() => tabs.open(`todos:${project.id}`, true)}>Ещё {openTodos.length - 8}</button></li>}
            </ul>
          ) : <p className="pj-muted">Открытых задач нет.</p>}
        </section>

        <section className="pj-card">
          <header className="pj-card-head"><h2>Материалы</h2></header>
          <MaterialGroup icon={<FileText size={14} />} title="Документы" items={materials.docs} open={(id) => tabs.open(`doc:${id}`, true)} onCreate={() => void createDocAndOpen(tabs, project.id)} />
          <MaterialGroup icon={<Table2 size={14} />} title="Таблицы" items={materials.tables} open={(id) => tabs.open(`table:${id}`, true)} onCreate={() => void createTableAndOpen(tabs, project.id)} />
          <MaterialGroup icon={<Presentation size={14} />} title="Презентации" items={materials.slides} open={(id) => tabs.open(`${SLIDES_TAB}${id}`, true)} onCreate={() => void createPresentationAndOpen(tabs, project.id)} />
          <MaterialGroup icon={<NotebookPen size={14} />} title="Заметки" items={materials.notes} open={(id) => tabs.open(`note:${id}`, true)} onCreate={() => void createNoteAndOpen(tabs, project.id)} />
          <MaterialGroup
            icon={<Palette size={14} />}
            title="Дизайн-системы"
            items={materials.designs}
            open={(id) => tabs.open(`${DESIGN_TAB}${id}`, true)}
            onCreate={() => void createDesignSystemAndOpen(tabs, project.id, { title: `Дизайн-система · ${project.name}` })}
            onImport={async () => { const file = await pickHtmlFile(); if (file) await createDesignSystemAndOpen(tabs, project.id, file); }}
          />
          <div className="pj-mat-row">
            <button type="button" className="pj-mat-title" onClick={() => tabs.open(`entity:${project.id}:memories`, true)}><TreeGlyph kind="memories" size={14} /> Память <span className="pj-count">{memories.length}</span></button>
          </div>
          {decisions.length > 0 && (
            <div className="pj-mat-row is-list">
              <span className="pj-mat-title is-static"><TreeGlyph kind="philosophy" size={14} /> Решения <span className="pj-count">{decisions.length}</span></span>
              <ul>{decisions.slice(0, 3).map((decision) => <li key={decision.id} title={decision.decision}>{decision.title}<small>{formatSince(decision.created_at)}</small></li>)}</ul>
            </div>
          )}
          {files.length > 0 && (
            <div className="pj-mat-row is-list">
              <span className="pj-mat-title is-static"><TreeGlyph kind="files" size={14} /> Файлы <span className="pj-count">{files.length}</span></span>
              <ul>{files.slice(0, 4).map((file) => <li key={file.id}><button type="button" onClick={() => tabs.open(`file:${file.id}`, true)}>{file.name || `Файл #${file.id}`}</button></li>)}</ul>
            </div>
          )}
        </section>

        {PROJECT_FIELDS.map((group) => (
          <section className="pj-card" key={group.title}>
            <header className="pj-card-head"><h2>{group.title}</h2></header>
            {group.title === "Ссылки" ? (
              // Репозиторий — отдельная колонка проекта, а не props: в группе он наравне с остальными ссылками.
              <FieldGroup
                fields={[...group.fields, { key: "git_url", label: "Репозиторий", hint: "github.com/…", link: true }]}
                props={{ ...project.props, git_url: project.git_url }}
                onSave={async (key, value, previousKey) => { if (key === "git_url") { await patchProject(project, { git_url: value.trim() }); reload(); } else await saveProp(key, value, previousKey); }}
                onOpenLink={openLink}
              />
            ) : (
              <FieldGroup fields={group.fields} props={project.props} onSave={saveProp} onOpenLink={openLink} />
            )}
          </section>
        ))}

        <section className="pj-card">
          <header className="pj-card-head"><h2>Разделы</h2></header>
          <div className="pj-sections">
            {sections.map((kind) => (
              <div key={kind} className="pj-section">
                <button type="button" onClick={() => tabs.open(`entity:${project.id}:${kind}`, true)}><TreeGlyph kind={kind} size={15} />{projectEntityKinds[kind].label}</button>
                {OPTIONAL_ENTITIES.includes(kind) && (
                  <button type="button" className="pj-icon" title="Убрать раздел (данные останутся)" aria-label={`Убрать раздел ${projectEntityKinds[kind].label}`} onClick={() => void setSections(enabled.filter((item) => item !== kind))}><X size={12} /></button>
                )}
              </div>
            ))}
          </div>
          {addable.length > 0 && (
            <div className="pj-addable">
              {addable.map((kind) => (
                <button key={kind} type="button" className="pj-chip is-ghost" onClick={() => void setSections([...enabled, kind])}><Plus size={12} />{projectEntityKinds[kind as ProjectEntityKind].label}</button>
              ))}
            </div>
          )}
        </section>

        <section className="pj-card pj-span-2">
          <header className="pj-card-head"><h2>Другие свойства</h2></header>
          <ExtraProps props={project.props} groups={PROJECT_FIELDS} onSave={saveProp} />
        </section>
      </div>

      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu wb-tree-ctx">
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void rename(); }}><Pencil size={15} aria-hidden="true" />Переименовать</button>
            {project.status !== "archived"
              ? <button type="button" role="menuitem" onClick={() => { setMenu(null); void setStatus("archived"); }}><Archive size={15} aria-hidden="true" />Перенести в архив</button>
              : <button type="button" role="menuitem" onClick={() => { setMenu(null); void setStatus("active"); }}><ArchiveRestore size={15} aria-hidden="true" />Вернуть из архива</button>}
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); void remove(); }}><Trash2 size={15} aria-hidden="true" />Удалить проект</button>
          </div>
        </WbMenu>
      )}
    </div>
  );
}

function MaterialGroup({ icon, title, items, open, onCreate, onImport }: { icon: ReactNode; title: string; items: Material[]; open: (id: string) => void; onCreate: () => void; onImport?: () => void }) {
  return (
    <div className={`pj-mat-row${items.length ? " is-list" : ""}`}>
      <span className="pj-mat-title is-static">{icon} {title} {items.length > 0 && <span className="pj-count">{items.length}</span>}</span>
      {onImport && <button type="button" className="pj-icon" onClick={onImport} title={`Загрузить HTML-файл: ${title.toLowerCase()}`} aria-label={`Загрузить HTML-файл: ${title.toLowerCase()}`}><Upload size={13} /></button>}
      <button type="button" className="pj-icon" onClick={onCreate} title={`Создать: ${title.toLowerCase()}`} aria-label={`Создать: ${title.toLowerCase()}`}><Plus size={13} /></button>
      {items.length > 0 && (
        <ul>{items.slice(0, 4).map((item) => <li key={item.id}><button type="button" onClick={() => open(item.id)}>{item.title || "Без названия"}</button><small>{formatSince(item.updated_at)}</small></li>)}</ul>
      )}
    </div>
  );
}

/** Проект-двойник компании: предлагаем слить его с компанией, чтобы «Вокруг света» не жила двумя сущностями. */
function TwinBanner({ project, companyName, companyId, data, isOwner, onDone }: { project: Project; companyName: string; companyId: string; data: MboxData; isOwner: boolean; onDone: () => void }) {
  const siblings = data.projects.filter((item) => item.id !== project.id && item.company_id === companyId && item.status !== "archived");
  const [target, setTarget] = useState(siblings[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  if (!isOwner) return null;
  async function merge() {
    if (project.todos.length && !target) { showNotice("Куда перенести задачи?", "У компании нет других проектов — сначала создайте проект для этих задач."); return; }
    setBusy(true);
    try {
      await fetchJson(`/api/mbox/companies/${companyId}/absorb`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: project.id, move_todos_to: target || undefined }) });
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <div className="pj-banner" role="note">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <b>Этот проект дублирует компанию «{companyName}».</b>
        <span>Свойства перейдут в карточку компании{project.todos.length ? ", задачи — в выбранный проект" : ""}, а сам проект уйдёт в архив.</span>
      </div>
      {project.todos.length > 0 && siblings.length > 0 && (
        <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Куда перенести задачи">
          {siblings.map((item) => <option key={item.id} value={item.id}>Задачи → {item.name}</option>)}
        </select>
      )}
      <button type="button" className="pj-btn is-primary" disabled={busy} onClick={() => void merge()}>{busy ? "Объединяю…" : "Объединить с компанией"}</button>
    </div>
  );
}

function hostLabel(value: string) {
  try { return new URL(normalizeUrl(value)).host.replace(/^www\./, ""); } catch { return value; }
}

function repoLabel(value: string) {
  return value.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "").replace(/^github\.com\//, "");
}
