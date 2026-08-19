import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, File, Folder, Pencil, Plus, X } from "lucide-react";
import { saveEntity } from "../../lib/api";
import { projectMemoryMatches } from "../../lib/memory";
import type { Memory, Project } from "../../types";
import { Button, EmptyState, SaveButton, TextArea, TextInput, type SaveState } from "../../ui";
import { PropsEditor } from "./PropsEditor";
import { RelationsPanel } from "./RelationsPanel";
import type { ProjectEntityKind } from "../tree/entityKinds";

/** Единая точка входа для постоянных сущностей проекта. */
export function ProjectEntityView({ project, projects, memories, kind, onSaved }: { project: Project; projects: Project[]; memories: Memory[]; kind: ProjectEntityKind; onSaved: () => void }) {
  if (kind === "properties") return <PropsEditor project={project} onSaved={onSaved} />;
  if (kind === "relations") return <RelationsPanel project={project} projects={projects} onSaved={onSaved} />;
  if (kind === "stack") return <StackPanel project={project} onSaved={onSaved} />;
  if (kind === "git") return <GitPanel project={project} onSaved={onSaved} />;
  if (kind === "figma") return <FigmaPanel project={project} onSaved={onSaved} />;
  if (kind === "deploy") return <DeployPanel project={project} onSaved={onSaved} />;
  if (kind === "philosophy") return <PhilosophyPanel project={project} onSaved={onSaved} />;
  if (kind === "memories") return <MemoriesPanel project={project} memories={memories} />;
  return <AccessPanel project={project} onSaved={onSaved} />;
}

function useSave(project: Project, onSaved: () => void) {
  const [state, setState] = useState<SaveState>("idle");
  useEffect(() => setState("idle"), [project.id]);

  async function save(payload: Record<string, unknown>) {
    setState("saving");
    try {
      await saveEntity("/api/mbox/projects", project.id, payload);
      setState("saved");
      onSaved();
      return true;
    } catch {
      setState("error");
      return false;
    }
  }

  return { state, setState, save };
}

export function StackPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [items, setItems] = useState<string[]>(project.stack);
  const [draft, setDraft] = useState("");
  const { state, setState, save } = useSave(project, onSaved);

  // По содержимому, а не по ссылке: перезагрузка раз в пять секунд приносит новый массив с тем же
  // содержимым и иначе стирала бы недописанное. См. подробный разбор в PropsEditor.
  const serverStack = project.stack.join("\0");

  useEffect(() => {
    setItems(project.stack);
    setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, serverStack]);

  const dirty = items.join("\0") !== project.stack.join("\0");

  function add() {
    const parts = draft.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return;
    setItems((current) => [...current, ...parts.filter((part) => !current.includes(part))]);
    setDraft("");
    setState("idle");
  }

  return (
    <div className="entity-panel stack-panel">
      {items.length ? (
        <div className="stack-chips">
          {items.map((item) => (
            <span className="stack-chip" key={item}>
              {item}
              <button type="button" aria-label={`Убрать ${item}`} onClick={() => { setItems((current) => current.filter((value) => value !== item)); setState("idle"); }}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      ) : <EmptyState text="Стек не заполнен. Технологии проекта читают агенты, когда выбирают, чем чинить." />}

      <div className="stack-add">
        <TextInput
          value={draft}
          placeholder="React, PostgreSQL, Docker"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        />
        <Button variant="ghost" icon={Plus} onClick={add}>Добавить</Button>
      </div>

      <SaveButton state={state} disabled={!dirty} idleLabel="Сохранить стек" onClick={() => save({ stack: items })} />
    </div>
  );
}

type RepoStructure = { paths: string[]; file_count: number; updated_at: string; updated_by: string };

type TreeNode = { name: string; isFile: boolean; children: Map<string, TreeNode> };

function buildRepoTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", isFile: false, children: new Map() };
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, isFile, children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    });
  }
  return root;
}

/** Папки первого уровня раскрыты по умолчанию — остальное сворачивается: у репозитория MBOX
 * 85 файлов, полностью развёрнутое дерево длиннее экрана. */
function RepoTreeNode({ node, depth }: { node: TreeNode; depth: number }) {
  const entries = [...node.children.values()].sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
  return (
    <ul className="repo-tree-list">
      {entries.map((child) => (
        <li key={child.name}>
          {child.isFile ? (
            <span className="repo-tree-file"><File size={13} />{child.name}</span>
          ) : (
            <details open={depth < 1}>
              <summary><Folder size={13} />{child.name}</summary>
              <RepoTreeNode node={child} depth={depth + 1} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function RepoTreePanel({ structure }: { structure: RepoStructure }) {
  const tree = useMemo(() => buildRepoTree(structure.paths), [structure.paths]);
  return (
    <div className="repo-tree">
      <div className="repo-tree-head">
        <span>Структура репозитория</span>
        <span className="muted">{structure.file_count} файлов · опубликовал {structure.updated_by}</span>
      </div>
      <RepoTreeNode node={tree} depth={0} />
    </div>
  );
}

export function GitPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(!project.git_url);
  const [url, setUrl] = useState(project.git_url || "");
  const { state, setState, save } = useSave(project, onSaved);

  useEffect(() => {
    setUrl(project.git_url || "");
    setEditing(!project.git_url);
  }, [project.id, project.git_url]);

  const href = normalizeGitUrl(project.git_url || "");
  // Публикует scripts/publish-repo-structure.mjs (или MCP-инструмент set_repo_structure) —
  // только пути, без содержимого файлов, специально для find_file у Джарвиса.
  const repoStructure = (project.props as unknown as { repo_structure?: RepoStructure } | undefined)?.repo_structure;

  return (
    <div className="entity-panel git-panel">
      {project.git_url ? (
        <a className="git-link" href={href} target="_blank" rel="noreferrer">
          <span className="git-repo">{repoShortName(project.git_url)}</span>
          <span className="git-host">{hostOf(href)}</span>
          <ExternalLink size={16} />
        </a>
      ) : <EmptyState text="Репозиторий не указан" />}

      {editing ? (
        <>
          <TextInput
            label="Адрес репозитория"
            hint="https://github.com/owner/repo или git@github.com:owner/repo.git"
            value={url}
            spellCheck={false}
            onChange={(event) => { setUrl(event.target.value); setState("idle"); }}
          />
          <SaveButton state={state} idleLabel="Сохранить Git" onClick={async () => { if (await save({ git_url: url })) setEditing(false); }} />
        </>
      ) : <Button variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Изменить адрес</Button>}

      {repoStructure && Array.isArray(repoStructure.paths) && repoStructure.paths.length > 0 && (
        <RepoTreePanel structure={repoStructure} />
      )}
    </div>
  );
}

/** Ссылка на дизайн в Figma — как Git, но URL живёт в props (своей колонки под неё нет и не нужна). */
export function FigmaPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const savedUrl = String(project.props?.figma_url || "");
  const [editing, setEditing] = useState(!savedUrl);
  const [url, setUrl] = useState(savedUrl);
  const { state, setState, save } = useSave(project, onSaved);

  useEffect(() => {
    setUrl(savedUrl);
    setEditing(!savedUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, savedUrl]);

  return (
    <div className="entity-panel git-panel">
      {savedUrl ? (
        <a className="git-link" href={savedUrl} target="_blank" rel="noreferrer">
          <span className="git-repo">{figmaFileName(savedUrl)}</span>
          <span className="git-host">figma.com</span>
          <ExternalLink size={16} />
        </a>
      ) : <EmptyState text="Дизайн не привязан" />}

      {editing ? (
        <>
          <TextInput
            label="Ссылка на Figma"
            hint="https://www.figma.com/file/... или /design/..."
            value={url}
            spellCheck={false}
            onChange={(event) => { setUrl(event.target.value); setState("idle"); }}
          />
          <SaveButton state={state} idleLabel="Сохранить Figma" onClick={async () => { if (await save({ props: { ...(project.props || {}), figma_url: url } })) setEditing(false); }} />
        </>
      ) : <Button variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Изменить ссылку</Button>}
    </div>
  );
}

export function DeployPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(!project.deploy_provider && !project.deploy_target);
  const [provider, setProvider] = useState(project.deploy_provider || "");
  const [target, setTarget] = useState(project.deploy_target || "");
  const { state, setState, save } = useSave(project, onSaved);

  useEffect(() => {
    setProvider(project.deploy_provider || "");
    setTarget(project.deploy_target || "");
    setEditing(!project.deploy_provider && !project.deploy_target);
  }, [project.id, project.deploy_provider, project.deploy_target]);

  const steps = String(project.props?.deploy_steps || "").trim();

  return (
    <div className="entity-panel deploy-panel">
      <div className="fact-rows">
        <div className="fact-row">
          <span>Провайдер</span>
          <strong>{project.deploy_provider || "не указан"}</strong>
        </div>
        <div className="fact-row">
          <span>Цель</span>
          <strong>{project.deploy_target || "не указана"}</strong>
        </div>
      </div>

      {steps && (
        <div className="deploy-steps">
          <span className="fact-caption">Шаги из свойства deploy_steps</span>
          <p>{steps}</p>
        </div>
      )}

      {editing ? (
        <>
          <TextInput label="Провайдер" hint="Docker Compose, Vercel, bare metal" value={provider} onChange={(event) => { setProvider(event.target.value); setState("idle"); }} />
          <TextInput label="Цель" hint="Домен, сервер или окружение" value={target} onChange={(event) => { setTarget(event.target.value); setState("idle"); }} />
          <SaveButton state={state} idleLabel="Сохранить деплой" onClick={async () => { if (await save({ deploy_provider: provider, deploy_target: target })) setEditing(false); }} />
        </>
      ) : <Button variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Изменить</Button>}
    </div>
  );
}

export function PhilosophyPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const saved = { philosophy: project.props?.philosophy || "", principles: project.props?.principles || "" };
  const [editing, setEditing] = useState(!saved.philosophy && !saved.principles);
  const [philosophy, setPhilosophy] = useState(saved.philosophy);
  const [principles, setPrinciples] = useState(saved.principles);
  const { state, setState, save } = useSave(project, onSaved);

  // Тоже по содержимому: иначе тик сервера затирал недописанный текст. См. PropsEditor.
  useEffect(() => {
    setPhilosophy(saved.philosophy);
    setPrinciples(saved.principles);
    setEditing(!saved.philosophy && !saved.principles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, saved.philosophy, saved.principles]);

  const principleList = saved.principles.split(/\r?\n/).map((line) => line.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

  return (
    <div className="entity-panel philosophy-panel">
      {saved.philosophy || principleList.length ? (
        <>
          {saved.philosophy && <div className="philosophy-text">{saved.philosophy.split(/\n{2,}/).map((block, index) => <p key={index}>{block}</p>)}</div>}
          {principleList.length > 0 && (
            <ul className="principle-list">
              {principleList.map((line) => <li key={line}><Check size={14} />{line}</li>)}
            </ul>
          )}
        </>
      ) : <EmptyState text="Философия не записана. Здесь живёт то, что нельзя вывести из кода: зачем проект и что важно не потерять." />}

      {editing ? (
        <>
          <TextArea label="Зачем проект" value={philosophy} rows={5} onChange={(event) => { setPhilosophy(event.target.value); setState("idle"); }} placeholder="Зачем существует проект, какой вкус решений, что важно не потерять" />
          <TextArea label="Принципы" hint="По одному в строке" value={principles} rows={4} onChange={(event) => { setPrinciples(event.target.value); setState("idle"); }} />
          <SaveButton state={state} idleLabel="Сохранить философию" onClick={async () => { if (await save({ props: { ...(project.props || {}), philosophy, principles } })) setEditing(false); }} />
        </>
      ) : <Button variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Изменить</Button>}
    </div>
  );
}

const accessLevels = [
  { value: "private", label: "private", hint: "Видит только владелец. Агенты проект не получают." },
  { value: "agents", label: "agents", hint: "Проект отдаётся агентам в контексте: todo, props, связи, история." },
  { value: "public", label: "public", hint: "Открыт всем, у кого есть доступ к MBOX." },
];

export function AccessPanel({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [level, setLevel] = useState(project.access_level || "private");
  const { state, setState, save } = useSave(project, onSaved);

  useEffect(() => setLevel(project.access_level || "private"), [project.id, project.access_level]);

  return (
    <div className="entity-panel access-panel">
      <div className="access-levels" role="radiogroup" aria-label="Уровень доступа">
        {accessLevels.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={level === option.value}
            className={level === option.value ? "access-level is-active" : "access-level"}
            type="button"
            onClick={() => { setLevel(option.value); setState("idle"); }}
          >
            <b>{option.label}</b>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>
      <SaveButton state={state} disabled={level === (project.access_level || "private")} idleLabel="Сохранить доступ" onClick={() => save({ access_level: level })} />
    </div>
  );
}

function normalizeGitUrl(value: string) {
  const ssh = value.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return value.replace(/\.git$/, "");
}

function repoShortName(value: string) {
  const path = normalizeGitUrl(value).replace(/^https?:\/\/[^/]+\//, "");
  return path || value;
}

function figmaFileName(value: string) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || value).replace(/-/g, " ");
  } catch {
    return value;
  }
}

function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

/** Полноценная вкладка вместо тизера на странице проекта — весь пул памяти проекта с поиском,
 * как Git/Стек/Доступ. Джарвис ищет по этому же пулу через свой инструмент search_memory. */
export function MemoriesPanel({ project, memories }: { project: Project; memories: Memory[] }) {
  const [search, setSearch] = useState("");
  const todoIds = new Set(project.todos.map((todo) => todo.id));
  const projectMemories = memories
    .filter((memory) => projectMemoryMatches(memory, project, todoIds))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const q = search.trim().toLowerCase();
  const visible = q
    ? projectMemories.filter((memory) => `${memory.title} ${memory.content}`.toLowerCase().includes(q))
    : projectMemories;

  if (!projectMemories.length) {
    return (
      <div className="entity-panel memories-panel">
        <EmptyState text="У проекта пока нет записей в памяти — Джарвис и агенты пишут их через record_memory по ходу работы" />
      </div>
    );
  }

  return (
    <div className="entity-panel memories-panel">
      <TextInput
        label="Поиск по памяти проекта"
        hint={`${visible.length} из ${projectMemories.length}`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        spellCheck={false}
      />
      <div className="project-facts-list memories-tab-list">
        {visible.map((memory) => (
          <article key={memory.id} className="project-fact-card">
            <b>{memory.title}</b>
            <p>{memory.content}</p>
            <time>{memory.entity_type} · {new Date(memory.updated_at).toLocaleDateString("ru-RU")}</time>
          </article>
        ))}
      </div>
    </div>
  );
}
