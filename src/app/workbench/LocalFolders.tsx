import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Bot, ChevronRight, FilePlus2, FolderPlus, GitBranch, RefreshCw, X } from "lucide-react";
import { formatSince } from "../../lib/format";
import { IMAGE_FILE, gitStatusOf, onWorkspaceChange, useLocalWorkspace, workspaceBridge, type DirEntry, type GitSummary, type WorkspaceRoot } from "./localWorkspace";
import { usePersistentState, type TabsApi } from "./tabs";
import { WbMenu } from "./WbMenu";
import { onLocalReveal } from "./agentTabs";
import { askText } from "../../ui/askText";

const ICONS = "/assets/icons/icons";
const SYSTEM_ICONS = "/assets/icons/system";

export function localFileKey(rootKey: string, rel: string) {
  return `local:${rootKey}:${rel}`;
}

export function parseLocalKey(key: string) {
  const [kind, rootKey, ...rest] = key.split(":");
  return { kind, rootKey, rest: rest.join(":") };
}

export function gitLetter(change?: { index: string; worktree: string; untracked: boolean }) {
  if (!change) return "";
  if (change.untracked) return "U";
  const code = change.worktree !== " " ? change.worktree : change.index;
  return code === "?" ? "U" : code;
}

function iconFor(entry: { name: string; type: string }) {
  if (entry.type === "dir") return `${ICONS}/папка.png`;
  if (IMAGE_FILE.test(entry.name)) return `${SYSTEM_ICONS}/figma.png`;
  return /\.(md|mdx|markdown|txt|rst)$/i.test(entry.name) ? `${ICONS}/документы.png` : `${ICONS}/стек.png`;
}

type Menu = { rootKey: string; entry: DirEntry | null; x: number; y: number };
type Selection = { rootKey: string; entry: DirEntry | null };
type Clip = { rootKey: string; path: string; name: string; move: boolean };

function cleanError(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function LocalFoldersView({ tabs }: { tabs: TabsApi }) {
  const ws = useLocalWorkspace();
  const [expanded, setExpanded] = usePersistentState<string[]>("mbox.local.expanded", []);
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = usePersistentState("mbox.local.filter", "");
  const [found, setFound] = useState<Array<{ rootKey: string; path: string }>>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [gitOpen, setGitOpen] = usePersistentState("mbox.local.gitOpen", true);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = usePersistentState<Selection | null>("mbox.local.selected", null);
  const [clip, setClip] = useState<Clip | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const bridge = workspaceBridge();

  const load = useCallback(async (rootKey: string, rel: string) => {
    if (!bridge) return;
    const id = `${rootKey}:${rel}`;
    try {
      const rows = await bridge.list(rootKey, rel);
      setChildren((current) => ({ ...current, [id]: rows }));
      setErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    } catch (cause) {
      setErrors((current) => ({ ...current, [id]: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, [bridge]);

  useEffect(() => {
    for (const id of expanded) {
      const [rootKey, ...rest] = id.split(":");
      if (!children[id] && ws.roots.some((root) => root.key === rootKey)) void load(rootKey, rest.join(":"));
    }
  }, [expanded, ws.roots, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Файл появился или пропал — перечитываем только раскрытые папки, где это случилось.
  useEffect(() => onWorkspaceChange((rootKey, paths) => {
    const dirs = new Set(paths.filter((item) => item !== ".git").map((item) => item.includes("/") ? item.slice(0, item.lastIndexOf("/")) : ""));
    for (const dir of dirs) if (expandedRef.current.includes(`${rootKey}:${dir}`)) void load(rootKey, dir);
  }), [load]);

  useEffect(() => {
    if (!bridge || filter.trim().length < 2) { setFound([]); return; }
    const timer = window.setTimeout(async () => {
      const results = await Promise.all(ws.roots.map(async (root) => (await bridge.find(root.key, filter.trim()).catch(() => [])).map((path) => ({ rootKey: root.key, path }))));
      setFound(results.flat().slice(0, 80));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter, ws.roots, bridge]);

  // Агент показал папку (MCP open_tab path:…): раскрываем путь до неё и выделяем.
  useEffect(() => onLocalReveal(({ rootKey, path }) => {
    const parts = path ? path.split("/") : [];
    const chain = [`${rootKey}:`, ...parts.map((_, index) => `${rootKey}:${parts.slice(0, index + 1).join("/")}`)];
    setExpanded((current) => [...new Set([...current, ...chain])]);
    setSelected(path ? { rootKey, entry: { name: parts[parts.length - 1], path, type: "dir", size: 0, mtime: 0 } } : { rootKey, entry: null });
    for (const id of chain) { const [key, ...rest] = id.split(":"); void load(key, rest.join(":")); }
  }), [load]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(rootKey: string, rel: string) {
    const id = `${rootKey}:${rel}`;
    setExpanded((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function act(action: () => Promise<unknown>, reloadDir?: { rootKey: string; rel: string }) {
    setMenu(null);
    try {
      await action();
      if (reloadDir) await load(reloadDir.rootKey, reloadDir.rel);
    } catch (cause) {
      setNotice(cleanError(cause));
    }
  }

  /** Куда вставлять: в выделенную папку, рядом с выделенным файлом или в корень. */
  function pasteTarget(selection: Selection) {
    if (!selection.entry) return "";
    return selection.entry.type === "dir" ? selection.entry.path : parentOf(selection.entry.path);
  }

  function copy(selection: Selection, move: boolean) {
    if (!selection.entry) return;
    setClip({ rootKey: selection.rootKey, path: selection.entry.path, name: selection.entry.name, move });
    setNotice(`${move ? "Вырезано" : "Скопировано"}: ${selection.entry.name} — выберите папку и Ctrl+V`);
  }

  function paste(selection: Selection) {
    if (!clip || !bridge) return;
    const dir = pasteTarget(selection);
    void act(async () => {
      const result = await bridge.transfer(clip.rootKey, clip.path, selection.rootKey, dir, clip.move);
      if (clip.move) {
        // Открытая вкладка переезжает вместе с файлом, а не остаётся с ошибкой «нет такого файла».
        retargetTabs(clip.rootKey, clip.path, selection.rootKey, result.path);
        await load(clip.rootKey, parentOf(clip.path));
        setClip(null);
      }
      if (!expandedRef.current.includes(`${selection.rootKey}:${dir}`)) setExpanded((current) => [...current, `${selection.rootKey}:${dir}`]);
      setNotice(`Вставлено: ${result.path}`);
    }, { rootKey: selection.rootKey, rel: dir });
  }

  function pasteFromWindows(selection: Selection) {
    if (!bridge) return;
    const dir = pasteTarget(selection);
    void act(async () => {
      const result = await bridge.pasteSystem(selection.rootKey, dir);
      if (!expandedRef.current.includes(`${selection.rootKey}:${dir}`)) setExpanded((current) => [...current, `${selection.rootKey}:${dir}`]);
      setNotice(`Из Проводника: ${result.paths.length} ${result.paths.length === 1 ? "файл" : "файла(ов)"}`);
    }, { rootKey: selection.rootKey, rel: dir });
  }

  async function rename(selection: Selection) {
    const entry = selection.entry;
    if (!entry || !bridge) return;
    setMenu(null);
    const name = await askText({ title: entry.type === "dir" ? "Новое имя папки" : "Новое имя файла", value: entry.name, confirmLabel: "Переименовать", validate: (value) => (/[\\/:*?"<>|]/.test(value) ? "Нельзя использовать символы \\ / : * ? \" < > |" : "") });
    if (!name?.trim() || name.trim() === entry.name) return;
    const parent = parentOf(entry.path);
    void act(async () => {
      const result = await bridge.rename(selection.rootKey, entry.path, parent ? `${parent}/${name.trim()}` : name.trim());
      retargetTabs(selection.rootKey, entry.path, selection.rootKey, result.path);
    }, { rootKey: selection.rootKey, rel: parent });
  }

  /** Файл или папка сменили путь — открытые вкладки внутри них получают новый адрес. */
  function retargetTabs(fromRoot: string, fromPath: string, toRoot: string, toPath: string) {
    for (const tab of tabs.tabs) {
      for (const kind of ["local", "gitdiff"]) {
        const prefix = `${kind}:${fromRoot}:${fromPath}`;
        if (tab.key === prefix || tab.key.startsWith(`${prefix}/`)) tabs.replace(tab.key, `${kind}:${toRoot}:${toPath}${tab.key.slice(prefix.length)}`);
      }
    }
  }

  function trash(selection: Selection) {
    const entry = selection.entry;
    if (!entry || !bridge) return;
    if (!window.confirm(`Переместить «${entry.name}» в корзину?`)) return setMenu(null);
    void act(async () => {
      await bridge.trash(selection.rootKey, entry.path);
      tabs.close(localFileKey(selection.rootKey, entry.path));
      setSelected(null);
    }, { rootKey: selection.rootKey, rel: parentOf(entry.path) });
  }

  function onTreeKey(event: KeyboardEvent) {
    if (!selected || (event.target as HTMLElement).tagName === "INPUT") return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.code === "KeyC") { event.preventDefault(); copy(selected, false); }
    else if (mod && event.code === "KeyX") { event.preventDefault(); copy(selected, true); }
    else if (mod && event.code === "KeyV") { event.preventDefault(); if (clip) paste(selected); else pasteFromWindows(selected); }
    else if (event.key === "Delete") { event.preventDefault(); trash(selected); }
    else if (event.key === "F2") { event.preventDefault(); void rename(selected); }
    else if (event.key === "Enter" && selected.entry?.type === "file") { event.preventDefault(); tabs.open(localFileKey(selected.rootKey, selected.entry.path), true); }
  }

  function parentOf(rel: string) {
    return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  }

  async function create(rootKey: string, dir: string, type: "file" | "dir") {
    setMenu(null);
    const name = await askText({ title: type === "dir" ? "Имя новой папки" : "Имя нового файла", value: type === "dir" ? "" : "заметка.md", confirmLabel: "Создать", validate: (value) => (/[\\/:*?"<>|]/.test(value) ? "Нельзя использовать символы \\ / : * ? \" < > |" : "") });
    if (!name?.trim() || !bridge) return;
    const rel = dir ? `${dir}/${name.trim()}` : name.trim();
    void act(async () => {
      await bridge.create(rootKey, rel, type);
      if (!expandedRef.current.includes(`${rootKey}:${dir}`)) setExpanded((current) => [...current, `${rootKey}:${dir}`]);
      if (type === "file") tabs.open(localFileKey(rootKey, rel), true);
    }, { rootKey, rel: dir });
  }

  function renderEntries(root: WorkspaceRoot, rel: string, depth: number) {
    const id = `${root.key}:${rel}`;
    if (errors[id]) return <li className="wb-tree-empty" style={{ ["--depth" as string]: depth }}>{errors[id]}</li>;
    const rows = children[id];
    if (!rows) return <li className="wb-tree-empty" style={{ ["--depth" as string]: depth }}>…</li>;
    if (!rows.length) return <li className="wb-tree-empty" style={{ ["--depth" as string]: depth }}>пусто</li>;
    return rows.map((entry) => {
      const entryId = `${root.key}:${entry.path}`;
      const open = entry.type === "dir" && expanded.includes(entryId);
      const tabKey = localFileKey(root.key, entry.path);
      const letter = entry.type === "file" ? gitLetter(gitStatusOf(root.key, entry.path)) : "";
      return (
        <li key={entry.path}>
          <div
            className={["wb-tree-row", tabs.active === tabKey ? "is-active" : "", selected?.rootKey === root.key && selected.entry?.path === entry.path ? "is-selected" : "", clip?.move && clip.rootKey === root.key && clip.path === entry.path ? "is-cut" : "", entry.heavy ? "is-heavy" : "", letter ? `git-${letter}` : ""].filter(Boolean).join(" ")}
            style={{ ["--depth" as string]: depth }}
            onClick={() => { setSelected({ rootKey: root.key, entry }); if (entry.type === "dir") toggle(root.key, entry.path); else tabs.open(tabKey); }}
            onDoubleClick={() => { if (entry.type === "file") tabs.open(tabKey, true); }}
            onContextMenu={(event: MouseEvent) => { event.preventDefault(); setSelected({ rootKey: root.key, entry }); setMenu({ rootKey: root.key, entry, x: event.clientX, y: event.clientY }); }}
            title={entry.path}
          >
            {entry.type === "dir" ? <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} /> : <span className="wb-chevron-space" />}
            <img src={iconFor(entry)} width={16} height={16} alt="" />
            <span className="wb-tree-label">{entry.name}</span>
            {letter && <span className={`wb-git-letter is-${letter}`}>{letter}</span>}
          </div>
          {open && <ul className="wb-tree-children">{renderEntries(root, entry.path, depth + 1)}</ul>}
        </li>
      );
    });
  }

  if (!ws.available) {
    return (
      <div className="wb-view">
        <header className="wb-view-head"><span>Папки</span></header>
        <div className="wb-view-body">
          <p className="wb-empty">Локальные папки открываются и правятся в приложении MBOX Desktop. Здесь — те, что оно подключило.</p>
          {ws.server.map((row) => <ServerWorkspaceCard key={row.id} row={row} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Папки</span>
        <div className="wb-view-actions">
          <button type="button" onClick={() => void act(ws.add)} title="Подключить папку"><FolderPlus size={14} /></button>
          <button type="button" onClick={() => { ws.refresh(); for (const id of expanded) { const [rootKey, ...rest] = id.split(":"); void load(rootKey, rest.join(":")); } }} title="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Найти файл по имени" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      {notice && <div className="wb-files-notice">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      <div className="wb-view-body" tabIndex={0} onKeyDown={onTreeKey}>
        {filter.trim().length >= 2 ? (
          <ul className="wb-tree">
            {found.map((item) => (
              <li key={`${item.rootKey}:${item.path}`}>
                <div className={tabs.active === localFileKey(item.rootKey, item.path) ? "wb-tree-row is-active" : "wb-tree-row"} style={{ ["--depth" as string]: 0 }} onClick={() => tabs.open(localFileKey(item.rootKey, item.path))} onDoubleClick={() => tabs.open(localFileKey(item.rootKey, item.path), true)} title={item.path}>
                  <img src={iconFor({ name: item.path, type: "file" })} width={16} height={16} alt="" />
                  <span className="wb-tree-label">{item.path.split("/").pop()}</span>
                  <span className="wb-tree-hint">{item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : ws.roots.find((root) => root.key === item.rootKey)?.name}</span>
                </div>
              </li>
            ))}
            {!found.length && <li className="wb-tree-empty">Ничего не найдено</li>}
          </ul>
        ) : ws.roots.length ? ws.roots.map((root) => {
          const open = expanded.includes(`${root.key}:`);
          const server = ws.serverWorkspace(root.key);
          return (
            <ul className="wb-tree" key={root.key}>
              <li>
                <div className="wb-tree-row wb-tree-project wb-root-row" style={{ ["--depth" as string]: 0 }} onClick={() => { setSelected({ rootKey: root.key, entry: null }); toggle(root.key, ""); }} onContextMenu={(event: MouseEvent) => { event.preventDefault(); setSelected({ rootKey: root.key, entry: null }); setMenu({ rootKey: root.key, entry: null, x: event.clientX, y: event.clientY }); }} title={root.path}>
                  <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} />
                  <span className="wb-tree-label">{root.name}</span>
                  <span className="wb-root-actions">
                    <button type="button" onClick={(event) => { event.stopPropagation(); create(root.key, "", "file"); }} title="Новый файл"><FilePlus2 size={13} /></button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); create(root.key, "", "dir"); }} title="Новая папка"><FolderPlus size={13} /></button>
                  </span>
                  {server && (
                    <button
                      type="button"
                      className={server.agent_write ? "wb-agent-toggle is-on" : "wb-agent-toggle"}
                      onClick={(event) => { event.stopPropagation(); void ws.setAgentWrite(root.key, !server.agent_write); }}
                      title={server.agent_write ? "Агенты (Джарвис, Claude, Codex) могут править файлы — нажми, чтобы запретить" : "Агентам запрещено править файлы — нажми, чтобы разрешить"}
                    >
                      <Bot size={13} />
                    </button>
                  )}
                </div>
                {open && <ul className="wb-tree-children">{renderEntries(root, "", 1)}</ul>}
              </li>
            </ul>
          );
        }) : (
          <div className="wb-session-empty">
            <p>Подключи папку — её файлы можно будет читать и править здесь, а агенты получат к ним доступ с историей версий.</p>
            <button type="button" onClick={() => void act(ws.add)}><FolderPlus size={13} /> Подключить папку</button>
          </div>
        )}
      </div>
      {ws.roots.some((root) => ws.git(root.key)?.isRepo) && (
        <section className={gitOpen ? "wb-git-panel is-open" : "wb-git-panel"}>
          <button type="button" className="wb-menu-group-head" onClick={() => setGitOpen((value) => !value)}>
            <span className={gitOpen ? "wb-caret is-open" : "wb-caret"}>›</span>Git
          </button>
          {gitOpen && (
            <div className="wb-git-body">
              {ws.roots.map((root) => {
                const git = ws.git(root.key);
                return git?.isRepo ? <GitRootSummary key={root.key} rootKey={root.key} name={root.name} git={git} tabs={tabs} multiple={ws.roots.length > 1} onRefresh={() => ws.refreshGit(root.key)} /> : null;
              })}
            </div>
          )}
        </section>
      )}
      {menu && bridge && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(!menu.entry || menu.entry.type === "dir") && (
            <>
              <button type="button" onClick={() => { setMenu(null); create(menu.rootKey, menu.entry?.path ?? "", "file"); }}>Новый файл</button>
              <button type="button" onClick={() => { setMenu(null); create(menu.rootKey, menu.entry?.path ?? "", "dir"); }}>Новая папка</button>
            </>
          )}
          {menu.entry && (
            <>
              <div className="wb-menu-sep" />
              <button type="button" onClick={() => { setMenu(null); copy({ rootKey: menu.rootKey, entry: menu.entry }, false); }}>Копировать<kbd>Ctrl+C</kbd></button>
              <button type="button" onClick={() => { setMenu(null); copy({ rootKey: menu.rootKey, entry: menu.entry }, true); }}>Вырезать<kbd>Ctrl+X</kbd></button>
            </>
          )}
          {clip && <button type="button" onClick={() => { setMenu(null); paste({ rootKey: menu.rootKey, entry: menu.entry }); }}>Вставить «{clip.name}»<kbd>Ctrl+V</kbd></button>}
          <button type="button" onClick={() => { setMenu(null); pasteFromWindows({ rootKey: menu.rootKey, entry: menu.entry }); }}>Вставить из Проводника</button>
          {menu.entry && (
            <>
              <div className="wb-menu-sep" />
              {menu.entry.type === "file" && <button type="button" onClick={() => void act(() => bridge.openDefault(menu.rootKey, menu.entry!.path))}>Открыть в программе по умолчанию</button>}
              <button type="button" onClick={() => void act(async () => { await bridge.copySystem(menu.rootKey, menu.entry!.path); setNotice("Файл в буфере — вставьте в Проводнике (Ctrl+V)"); })}>Копировать для Проводника</button>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(menu.entry!.path); setMenu(null); }}>Копировать путь</button>
              <div className="wb-menu-sep" />
              <button type="button" onClick={() => { setMenu(null); rename({ rootKey: menu.rootKey, entry: menu.entry }); }}>Переименовать<kbd>F2</kbd></button>
              <button type="button" className="is-danger" onClick={() => { setMenu(null); trash({ rootKey: menu.rootKey, entry: menu.entry }); }}>Удалить в корзину<kbd>Del</kbd></button>
            </>
          )}
          <button type="button" onClick={() => void act(() => bridge.reveal(menu.rootKey, menu.entry?.path ?? ""))}>Показать в проводнике Windows</button>
          {!menu.entry && <button type="button" onClick={() => { if (window.confirm("Отключить папку от MBOX? Файлы на диске останутся.")) void act(() => ws.remove(menu.rootKey)); else setMenu(null); }}>Отключить папку</button>}
        </WbMenu>
      )}
    </div>
  );
}

function GitRootSummary({ rootKey, name, git, tabs, multiple, onRefresh }: { rootKey: string; name: string; git: GitSummary; tabs: TabsApi; multiple: boolean; onRefresh: () => void }) {
  const changes = git.changes ?? [];
  return (
    <div className="wb-git-root">
      <div className="wb-git-branch">
        <GitBranch size={13} />
        <b>{multiple ? `${name} · ` : ""}{git.branch || "—"}</b>
        {(git.ahead ?? 0) > 0 && <span title="Коммитов не отправлено">↑{git.ahead}</span>}
        {(git.behind ?? 0) > 0 && <span title="Коммитов не получено">↓{git.behind}</span>}
        <span className="wb-git-count">{git.changesTotal ?? changes.length} изм.</span>
        <button type="button" className="wb-icon-btn" onClick={onRefresh} title="Обновить"><RefreshCw size={12} /></button>
      </div>
      {changes.slice(0, 40).map((change) => {
        const letter = gitLetter(change);
        return (
          <button key={change.path} type="button" className="wb-git-change" onClick={() => tabs.open(`gitdiff:${rootKey}:${change.path}`)} onDoubleClick={() => tabs.open(`gitdiff:${rootKey}:${change.path}`, true)} title={change.path}>
            <span className="wb-tree-label">{change.path.split("/").pop()}</span>
            <span className="wb-tree-hint">{change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : ""}</span>
            <span className={`wb-git-letter is-${letter}`}>{letter}</span>
          </button>
        );
      })}
      {changes.length > 40 && <p className="wb-empty">и ещё {changes.length - 40}</p>}
      <div className="wb-git-commits">
        {(git.commits ?? []).slice(0, 12).map((commit) => (
          <button key={commit.hash} type="button" className="wb-git-commit" onClick={() => tabs.open(`commit:${rootKey}:${commit.hash}`)} title={`${commit.hash}\n${commit.author}`}>
            <span className="wb-git-hash">{commit.short}</span>
            <span className="wb-tree-label">{commit.subject}</span>
            <span className="wb-tree-hint">{formatSince(commit.date)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ServerWorkspaceCard({ row }: { row: { id: string; name: string; device_name: string; online: boolean; agent_write: boolean; git: GitSummary | Record<string, never>; last_seen: string } }) {
  const git = row.git as GitSummary;
  return (
    <div className="wb-ws-card">
      <div className="wb-ws-card-head">
        <i className={row.online ? "wb-dot is-live" : "wb-dot"} />
        <b>{row.name}</b>
        <span>{row.device_name} · {row.online ? "в сети" : formatSince(row.last_seen)}</span>
      </div>
      {git?.isRepo && (
        <div className="wb-ws-card-git">
          <GitBranch size={12} /> {git.branch} · {git.changesTotal ?? 0} изм.
          {(git.commits ?? []).slice(0, 3).map((commit) => <div key={commit.hash} className="wb-tree-hint">{commit.short} {commit.subject}</div>)}
        </div>
      )}
    </div>
  );
}
