import { Building2, ChevronRight, ExternalLink, FileText, FolderPlus, ImagePlus, MoreHorizontal, NotebookPen, Palette, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { formatSince } from "../../../lib/format";
import { storageFileUrl, uploadToStorage } from "../../../lib/storageUpload";
import { FileTypeIcon } from "../FileTypeIcon";
import { TreeGlyph } from "../TreeGlyph";
import type { MboxData } from "../../../hooks/useMboxData";
import { fetchJson } from "../../../lib/api";
import type { Company, Project } from "../../../types";
import { askConfirm, askText, showNotice } from "../../../ui/askText";
import { browserTabKey } from "../BrowserDocument";
import type { TabsApi } from "../tabs";
import { WbMenu } from "../WbMenu";
import { ExtraProps, FieldGroup, QuickFacts } from "./PropFields";
import { companyLogo, COMPANY_FIELDS, fieldValue, initials, isCompanyHome, normalizeUrl, patchCompany, PROJECT_STATUS, projectStats, setCompanyProp } from "./projectFields";
import { projectMemoryMatches } from "../../../lib/memory";
import { materialsOf, useAllMaterials } from "./useProjectMaterials";
import { removeNow } from "../../../lib/optimistic";

/**
 * Карточка компании (вкладка company:<id>): её проекты карточками со статусом и задачами, сведения о компании
 * (сайт, контакты, реквизиты, правила для агентов) и все прочие факты, которые агенты копят в props.
 */
export function CompanyPage({ company, data, tabs, isOwner }: { company: Company; data: MboxData; tabs: TabsApi; isOwner: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInput = useRef<HTMLInputElement | null>(null);
  const colorInput = useRef<HTMLInputElement | null>(null);
  // Записи компании — проект-хранилище: его память, решения, папки и файлы показываются здесь, а не отдельным проектом.
  const home = data.projects.find((project) => project.company_id === company.id && isCompanyHome(project)) ?? null;
  const projects = data.projects.filter((project) => project.company_id === company.id && !isCompanyHome(project));
  const live = projects.filter((project) => project.status !== "archived");
  const archived = projects.filter((project) => project.status === "archived");
  const loose = data.projects.filter((project) => !project.company_id && project.status !== "archived");
  const ids = useMemo(() => new Set([...projects, ...(home ? [home] : [])].map((project) => project.id)), [projects, home]);
  const allMaterials = useAllMaterials();
  const materials = materialsOf(allMaterials, ids);
  const homeMaterials = materialsOf(allMaterials, useMemo(() => new Set(home ? [home.id] : []), [home]));
  const logo = companyLogo(company);
  const totals = live.reduce((sum, project) => { const stats = projectStats(project); return { open: sum.open + stats.open, review: sum.review + stats.review, blocked: sum.blocked + stats.blocked }; }, { open: 0, review: 0, blocked: 0 });
  const reload = () => data.reload();
  const site = fieldValue(company.props, { key: "domain", label: "" }).value;
  const saveProp = async (key: string, value: string, previousKey: string) => { await setCompanyProp(company, key, value, previousKey); reload(); };

  async function rename() {
    const name = (await askText({ title: "Название компании", value: company.name, confirmLabel: "Сохранить" }))?.trim().slice(0, 200);
    if (!name || name === company.name) return;
    try { await patchCompany(company, { name }); reload(); } catch { showNotice("Не переименована", "Компания с таким названием уже есть."); }
  }

  async function createProject() {
    const name = (await askText({ title: `Новый проект в «${company.name}»`, placeholder: "Название проекта", confirmLabel: "Создать" }))?.trim().slice(0, 120);
    if (!name) return;
    try {
      const { project } = await fetchJson<{ project: { id: string } }>("/api/mbox/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, status: "active", access_level: "private", company_id: company.id, color: company.color }) });
      reload();
      tabs.open(`project:${project.id}`, true);
    } catch { showNotice("Проект не создан", "Проект с таким названием уже есть."); }
  }

  async function attach(projectId: string) {
    if (!projectId) return;
    await fetchJson(`/api/mbox/projects/${projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ company_id: company.id }) });
    reload();
  }

  async function setLogo(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setLogoBusy(true);
    try {
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      const key = `companies/${company.id}/logo-${Date.now()}.${ext}`;
      await uploadToStorage(key, file);
      await patchCompany(company, { props: { ...company.props, logo: storageFileUrl(key) } });
      reload();
    } catch (error) {
      showNotice("Логотип не загрузился", error instanceof Error ? error.message : "Проверьте настройки хранилища S3.");
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeLogo() {
    const props = { ...company.props };
    delete props.logo;
    await patchCompany(company, { props });
    reload();
  }

  async function remove() {
    const ok = await askConfirm({
      title: `Удалить компанию «${company.name}»?`,
      message: projects.length ? `Проекты компании (${projects.length}) останутся — без компании. Сведения о компании удалятся.` : "Сведения о компании удалятся.",
      confirmLabel: "Удалить компанию",
      danger: true,
    });
    if (!ok) return;
    tabs.close(`company:${company.id}`);
    projects.forEach((project) => data.patchLocal("projects", project.id, { company_id: null }));
    await removeNow(data, "companies", company.id);
  }

  return (
    <div className="pj-page">
      <header className="pj-head">
        <button
          type="button"
          className={`pj-avatar is-company${logo ? " has-logo" : ""}${logoBusy ? " is-busy" : ""}`}
          style={{ ["--pj-color" as string]: company.color && company.color !== "#2c2c2e" ? company.color : "#8e8e93" }}
          disabled={!isOwner || logoBusy}
          onClick={() => logoInput.current?.click()}
          title={isOwner ? (logo ? "Сменить логотип" : "Загрузить логотип") : undefined}
          aria-label={isOwner ? "Логотип компании" : company.name}
        >
          {logo ? <img src={logo} alt="" /> : initials(company.name)}
          {isOwner && <span className="pj-avatar-edit" aria-hidden="true"><ImagePlus size={16} /></span>}
        </button>
        <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden onChange={(event) => { void setLogo(event.target.files?.[0]); event.target.value = ""; }} />
        <input ref={colorInput} type="color" hidden value={/^#[0-9a-f]{6}$/i.test(company.color) ? company.color : "#8e8e93"} onChange={(event) => void patchCompany(company, { color: event.target.value }).then(reload)} />
        <div className="pj-head-main">
          <div className="pj-crumbs"><Building2 size={12} aria-hidden="true" /> <span>Компания</span></div>
          <h1><button type="button" disabled={!isOwner} onClick={() => void rename()} title={isOwner ? "Переименовать" : undefined}>{company.name}</button></h1>
          <div className="pj-stats">
            <span><b>{live.length}</b> {plural(live.length, "проект", "проекта", "проектов")}</span>
            <span><b>{totals.open}</b> открытых задач</span>
            {totals.review > 0 && <span className="is-review"><b>{totals.review}</b> на проверке</span>}
            {totals.blocked > 0 && <span className="is-blocked"><b>{totals.blocked}</b> заблокировано</span>}
            {site && <button type="button" className="pj-chip" onClick={() => tabs.open(browserTabKey(normalizeUrl(site)), true)}>{site.replace(/^https?:\/\//, "")}<ExternalLink size={11} className="pj-chip-out" /></button>}
          </div>
        </div>
        {isOwner && <button type="button" className="pj-icon pj-head-more" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right - 220, y: rect.bottom + 4 }); }} aria-label="Действия с компанией" title="Действия"><MoreHorizontal size={16} /></button>}
      </header>

      {isOwner && (
        <QuickFacts
          props={company.props}
          placeholder="Добавить сведения: сайт, телефон, почта, ИНН, «Адрес: …» или любой факт — Enter"
          onSave={async (props) => { await patchCompany(company, { props }); reload(); }}
        />
      )}

      <section className="pj-card pj-projects">
        <header className="pj-card-head">
          <h2>Проекты</h2>
          {isOwner && loose.length > 0 && (
            <label className="pj-select">
              <FolderPlus size={13} aria-hidden="true" />
              <select value="" onChange={(event) => void attach(event.target.value)} aria-label="Добавить существующий проект">
                <option value="">Добавить существующий…</option>
                {loose.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="pj-btn is-primary" onClick={() => void createProject()}><Plus size={14} /> Проект</button>
        </header>
        {live.length ? (
          <div className="pj-cards">{live.map((project) => <ProjectCard key={project.id} project={project} onOpen={() => tabs.open(`project:${project.id}`, true)} />)}</div>
        ) : <p className="pj-muted">У компании пока нет проектов.</p>}
        {archived.length > 0 && (
          <>
            <button type="button" className="pj-link" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Скрыть архив" : `Архив · ${archived.length}`}</button>
            {showArchived && <div className="pj-cards is-archived">{archived.map((project) => <ProjectCard key={project.id} project={project} onOpen={() => tabs.open(`project:${project.id}`, true)} />)}</div>}
          </>
        )}
      </section>

      {home && (
        <section className="pj-card pj-projects">
          <header className="pj-card-head">
            <h2>Записи компании</h2>
            <span className="pj-muted">Память, решения, файлы и папки, которые относятся ко всей компании</span>
          </header>
          <CompanyRecords home={home} data={data} tabs={tabs} notes={homeMaterials.notes} docs={homeMaterials.docs} />
        </section>
      )}

      <div className="pj-grid">
        {COMPANY_FIELDS.map((group) => (
          <section className="pj-card" key={group.title}>
            <header className="pj-card-head"><h2>{group.title}</h2></header>
            <FieldGroup fields={group.fields} props={company.props} readOnly={!isOwner} onSave={saveProp} onOpenLink={(url) => tabs.open(browserTabKey(url), true)} />
          </section>
        ))}
        <section className="pj-card">
          <header className="pj-card-head"><h2>Материалы проектов</h2></header>
          <ul className="pj-summary">
            <li><span>Документы</span><b>{materials.docs.length}</b></li>
            <li><span>Таблицы</span><b>{materials.tables.length}</b></li>
            <li><span>Презентации</span><b>{materials.slides.length}</b></li>
            <li><span>Заметки</span><b>{materials.notes.length}</b></li>
          </ul>
        </section>
        <section className="pj-card pj-span-2">
          <header className="pj-card-head"><h2>Всё, что известно о компании</h2></header>
          <ExtraProps props={company.props} groups={COMPANY_FIELDS} readOnly={!isOwner} onSave={saveProp} />
        </section>
      </div>

      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu wb-tree-ctx">
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void rename(); }}><Pencil size={15} aria-hidden="true" />Переименовать</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void createProject(); }}><FolderPlus size={15} aria-hidden="true" />Новый проект</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); logoInput.current?.click(); }}><ImagePlus size={15} aria-hidden="true" />{logo ? "Сменить логотип" : "Загрузить логотип"}</button>
            {logo && <button type="button" role="menuitem" onClick={() => { setMenu(null); void removeLogo(); }}><X size={15} aria-hidden="true" />Убрать логотип</button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(null); colorInput.current?.click(); }}><Palette size={15} aria-hidden="true" />Цвет компании</button>
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); void remove(); }}><Trash2 size={15} aria-hidden="true" />Удалить компанию</button>
          </div>
        </WbMenu>
      )}
    </div>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const stats = projectStats(project);
  const goal = fieldValue(project.props, { key: "current_goal", label: "", aliases: ["purpose", "description", "focus"] }).value;
  const status = PROJECT_STATUS.find((item) => item.id === project.status)?.label ?? project.status;
  return (
    <button type="button" className="pj-pcard" style={{ ["--pj-color" as string]: project.color || "#8e8e93" }} onClick={onOpen}>
      <span className="pj-pcard-top"><span className="pj-dot" aria-hidden="true" /><b>{project.name}</b><span className={`pj-status is-${project.status}`}>{status}</span></span>
      {goal && <span className="pj-pcard-goal">{goal}</span>}
      <span className="pj-pcard-stats">
        <span>{stats.open} открыто</span>
        {stats.doing > 0 && <span className="is-doing">{stats.doing} в работе</span>}
        {stats.review + stats.blocked > 0 && <span className="is-review">{stats.review + stats.blocked} ждут</span>}
      </span>
    </button>
  );
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Записи компании: память, решения, задачи, папки, файлы и заметки проекта-хранилища — прямо в карточке. */
function CompanyRecords({ home, data, tabs, notes, docs }: { home: Project; data: MboxData; tabs: TabsApi; notes: Array<{ id: string; title: string; updated_at: string }>; docs: Array<{ id: string; title: string; updated_at: string }> }) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const todoIds = new Set(home.todos.map((todo) => todo.id));
  const memories = data.memories.filter((memory) => projectMemoryMatches(memory, home, todoIds));
  const decisions = data.decisions.filter((decision) => decision.project_id === home.id);
  const folders = data.folders.filter((folder) => folder.project_id === home.id);
  const files = data.artifacts.filter((file) => file.project_id === home.id).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
  const openTodos = projectStats(home).open;
  return (
    <div className="pj-records">
      <div className="pj-records-tiles">
        <button type="button" className="pj-record-tile" onClick={() => tabs.open(`entity:${home.id}:memories`, true)}><TreeGlyph kind="memories" size={18} /><b>{memories.length}</b><span>Память</span></button>
        <button type="button" className="pj-record-tile" onClick={() => tabs.open(`todos:${home.id}`, true)}><TreeGlyph kind="todos" size={18} /><b>{openTodos}</b><span>Задачи</span></button>
        <button type="button" className="pj-record-tile" onClick={() => tabs.open(`entity:${home.id}:relations`, true)}><TreeGlyph kind="relations" size={18} /><b>{home.relations.length}</b><span>Связи</span></button>
        {folders.map((folder) => (
          <button key={folder.id} type="button" className="pj-record-tile" onClick={() => tabs.open(`folder:${home.id}:${folder.id}`, true)}><TreeGlyph kind="folder" size={18} /><b className="is-name">{folder.name}</b><span>Папка</span></button>
        ))}
      </div>
      <div className="pj-grid">
        {decisions.length > 0 && (
          <div className="pj-mat-row is-list">
            <span className="pj-mat-title is-static"><TreeGlyph kind="philosophy" size={14} /> Решения <span className="pj-count">{decisions.length}</span></span>
            <ul>{decisions.slice(0, 6).map((decision) => <li key={decision.id} title={decision.decision}>{decision.title}<small>{formatSince(decision.created_at)}</small></li>)}</ul>
          </div>
        )}
        {(notes.length > 0 || docs.length > 0) && (
          <div className="pj-mat-row is-list">
            <span className="pj-mat-title is-static"><NotebookPen size={14} /> Заметки и документы <span className="pj-count">{notes.length + docs.length}</span></span>
            <ul>
              {notes.slice(0, 6).map((note) => <li key={`n${note.id}`}><button type="button" onClick={() => tabs.open(`note:${note.id}`, true)}>{note.title || "Без названия"}</button><small>{formatSince(note.updated_at)}</small></li>)}
              {docs.slice(0, 4).map((doc) => <li key={`d${doc.id}`}><button type="button" onClick={() => tabs.open(`doc:${doc.id}`, true)}><FileText size={12} /> {doc.title || "Без названия"}</button><small>{formatSince(doc.updated_at)}</small></li>)}
            </ul>
          </div>
        )}
        {files.length > 0 && (
          <div className="pj-mat-row is-list pj-span-2">
            <span className="pj-mat-title is-static"><TreeGlyph kind="files" size={14} /> Файлы <span className="pj-count">{files.length}</span></span>
            <ul className="pj-file-list">
              {(showAllFiles ? files : files.slice(0, 12)).map((file) => (
                <li key={file.id}><button type="button" onClick={() => tabs.open(`file:${file.id}`, true)}><FileTypeIcon name={file.name} size={14} /> {file.name || `Файл #${file.id}`}</button></li>
              ))}
            </ul>
            {files.length > 12 && <button type="button" className="pj-link" onClick={() => setShowAllFiles(!showAllFiles)}>{showAllFiles ? "Свернуть" : `Все файлы · ${files.length}`} <ChevronRight size={12} /></button>}
          </div>
        )}
      </div>
    </div>
  );
}
