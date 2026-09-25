import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/api";

export type WorkspaceRoot = { key: string; name: string; path: string };
export type DirEntry = { name: string; path: string; type: "dir" | "file"; size: number; mtime: number; heavy?: boolean };
export type ImageRead = { path: string; size: number; mtime: number; mime: string; dataUrl: string; tooLarge?: boolean };
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
export type DataRead = { path: string; size: number; mtime: number; mime: string; base64: string; tooLarge?: boolean };
export const OFFICE_FILE = /\.(pdf|docx?|xlsx?|csv|tsv)$/i;
export type FileRead = { path: string; size: number; mtime: number; content: string; binary?: boolean; tooLarge?: boolean };
export type GitChange = { path: string; index: string; worktree: string; untracked: boolean };
export type GitCommit = { hash: string; short: string; author: string; date: string; subject: string };
export type GitSummary = {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  remote?: string;
  changes?: GitChange[];
  changesTotal?: number;
  commits?: GitCommit[];
  checkedAt?: string;
};
export type FileVersion = { id: string; path: string; sha: string; size_bytes: number; author: string; source: string; message: string; created_at: string };
export type ServerWorkspace = { id: string; device_id: string; device_name: string; root_key: string; name: string; root_path: string; agent_write: boolean; git: GitSummary | Record<string, never>; last_seen: string; online: boolean };

type Op = { id: string; workspace_id: string; op: string; path: string; content: string | null; message: string; requested_by: string };

export type WorkspaceBridge = {
  info: () => Promise<{ deviceId: string; deviceName: string; roots: WorkspaceRoot[] }>;
  add: () => Promise<{ deviceId: string; deviceName: string; roots: WorkspaceRoot[] }>;
  remove: (key: string) => Promise<{ deviceId: string; deviceName: string; roots: WorkspaceRoot[] }>;
  list: (key: string, rel: string) => Promise<DirEntry[]>;
  read: (key: string, rel: string) => Promise<FileRead>;
  readImage?: (key: string, rel: string) => Promise<ImageRead>;
  readData?: (key: string, rel: string) => Promise<DataRead>;
  write: (key: string, rel: string, content: string, expectedMtime?: number) => Promise<{ path: string; size: number; mtime: number; previous: string | null }>;
  writeData?: (key: string, rel: string, base64: string, expectedMtime?: number) => Promise<{ path: string; size: number; mtime: number }>;
  create: (key: string, rel: string, type: "file" | "dir") => Promise<{ path: string }>;
  rename: (key: string, rel: string, nextRel: string) => Promise<{ path: string }>;
  trash: (key: string, rel: string) => Promise<unknown>;
  find: (key: string, query: string) => Promise<string[]>;
  reveal: (key: string, rel: string) => Promise<unknown>;
  transfer: (fromKey: string, fromRel: string, toKey: string, toDirRel: string, move: boolean) => Promise<{ path: string }>;
  pasteSystem: (key: string, toDirRel: string) => Promise<{ paths: string[] }>;
  copySystem: (key: string, rel: string) => Promise<unknown>;
  openDefault: (key: string, rel: string) => Promise<unknown>;
  git: (key: string) => Promise<GitSummary>;
  gitLog: (key: string, rel: string) => Promise<GitCommit[]>;
  gitDiff: (key: string, rel: string) => Promise<{ diff: string; note?: string }>;
  gitShow: (key: string, hash: string) => Promise<{ text: string }>;
  onChange: (handler: (payload: { key: string; paths: string[] }) => void) => () => void;
};

export function workspaceBridge(): WorkspaceBridge | undefined {
  return (window.mboxDesktop as unknown as { workspace?: WorkspaceBridge } | undefined)?.workspace;
}

/** Расширения, у которых история пишется и для правок «на диске» (Claude/Codex правят файлы напрямую). */
const DOC_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc|org)$/i;
const MAX_TRACK_BYTES = 512 * 1024;

type Listener = () => void;
type ChangeListener = (key: string, paths: string[]) => void;

const store = {
  deviceId: "",
  deviceName: "",
  roots: [] as WorkspaceRoot[],
  git: new Map<string, GitSummary>(),
  serverIds: new Map<string, string>(),
  server: [] as ServerWorkspace[],
  tracked: new Map<string, Set<string>>(),
  listeners: new Set<Listener>(),
  changeListeners: new Set<ChangeListener>(),
  started: false,
  // Свои записи (из MBOX и по операциям агентов) наблюдатель за диском тоже видит — без этой памяти
  // он успевал сохранить версию раньше и подписывал её «на диске» вместо настоящего автора.
  recentWrites: new Map<string, { content: string; at: number }>(),
  user: "",
  agentHint: () => "",
};

function emit() {
  store.listeners.forEach((listener) => listener());
}

async function refreshGit(key: string) {
  const bridge = workspaceBridge();
  if (!bridge) return;
  try {
    store.git.set(key, await bridge.git(key));
    emit();
  } catch {
    // папку могли отключить между событиями
  }
}

async function register() {
  const bridge = workspaceBridge();
  if (!bridge) return;
  const info = await bridge.info();
  store.deviceId = info.deviceId;
  store.deviceName = info.deviceName;
  store.roots = info.roots;
  await Promise.all(info.roots.filter((root) => !store.git.has(root.key)).map((root) => refreshGit(root.key)));
  try {
    const response = await fetchJson<{ workspaces: ServerWorkspace[] }>("/api/mbox/workspaces/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: info.deviceId,
        device_name: info.deviceName,
        roots: info.roots.map((root) => ({ key: root.key, name: root.name, path: root.path, git: compactGit(store.git.get(root.key)) })),
      }),
    });
    for (const row of response.workspaces) {
      store.serverIds.set(row.root_key, row.id);
      if (!store.tracked.has(row.root_key)) {
        const tracked = await fetchJson<{ paths: string[] }>(`/api/mbox/workspaces/${row.id}/tracked`).catch(() => ({ paths: [] }));
        store.tracked.set(row.root_key, new Set(tracked.paths));
      }
    }
    store.server = response.workspaces;
  } catch {
    // сервер недоступен — локальная работа с файлами всё равно идёт
  }
  emit();
}

/** На сервер уходит сводка без простыни: агентам хватает ветки, счётчиков и последних коммитов. */
function compactGit(summary?: GitSummary) {
  if (!summary) return {};
  return { ...summary, changes: (summary.changes ?? []).slice(0, 60), commits: (summary.commits ?? []).slice(0, 10) };
}

async function recordVersionFor(key: string, path: string, content: string, source: string, author: string, previous?: string | null, message = "") {
  const workspaceId = store.serverIds.get(key);
  if (!workspaceId) return;
  await fetchJson(`/api/mbox/workspaces/${workspaceId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content, source, author, message, previous_content: previous ?? undefined }),
  }).catch(() => undefined);
  const set = store.tracked.get(key) ?? new Set<string>();
  set.add(path);
  store.tracked.set(key, set);
}

/** Операции от Джарвиса и MCP-агентов: приложение забирает их с сервера и выполняет на диске. */
async function executeOps() {
  const bridge = workspaceBridge();
  if (!bridge || !store.deviceId || !store.serverIds.size) return;
  let ops: Op[] = [];
  try {
    ops = (await fetchJson<{ ops: Op[] }>(`/api/mbox/workspaces/ops/pending?device_id=${encodeURIComponent(store.deviceId)}`)).ops;
  } catch {
    return;
  }
  for (const op of ops) {
    const key = [...store.serverIds.entries()].find(([, id]) => id === op.workspace_id)?.[0];
    let result: unknown = null;
    let error = "";
    try {
      if (!key) throw new Error("папка не подключена на этом компьютере");
      if (op.op === "list") result = { entries: await bridge.list(key, op.path) };
      else if (op.op === "read") {
        const file = await bridge.read(key, op.path);
        result = file.binary ? { path: file.path, binary: true, size: file.size } : file.tooLarge ? { path: file.path, tooLarge: true, size: file.size } : { path: file.path, size: file.size, content: file.content };
      } else if (op.op === "write") {
        rememberWrite(key, op.path, op.content ?? "");
        const written = await bridge.write(key, op.path, op.content ?? "");
        await recordVersionFor(key, written.path, op.content ?? "", "agent", op.requested_by || "агент", written.previous, op.message);
        result = { path: written.path, size: written.size };
      } else if (op.op === "find") result = { paths: await bridge.find(key, op.path) };
      else if (op.op === "git_log") result = { commits: op.path ? await bridge.gitLog(key, op.path) : (await bridge.git(key)).commits ?? [] };
      // Таблицы и Word — отдельным модулем: exceljs и mammoth тяжёлые и нужны только по запросу агента.
      else if (op.op === "read_table") result = await (await import("./officeOps")).readTable(bridge, key, op.path, parseOpContent(op.content));
      else if (op.op === "write_cells") result = await (await import("./officeOps")).writeCells(bridge, key, op.path, parseOpContent(op.content));
      else if (op.op === "read_doc") result = await (await import("./officeOps")).readDocument(bridge, key, op.path);
      else if (op.op === "write_data") {
        if (!bridge.writeData) throw new Error("обновите MBOX Desktop: запись документов недоступна");
        result = await bridge.writeData(key, op.path, op.content ?? "");
      } else throw new Error(`неизвестная операция ${op.op}`);
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
    await fetchJson(`/api/mbox/workspaces/ops/${op.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: error ? "failed" : "done", result, error }),
    }).catch(() => undefined);
  }
}

function parseOpContent(content: string | null) {
  if (!content) return {};
  try { return JSON.parse(content) as Record<string, never>; } catch { throw new Error("параметры операции — не JSON"); }
}

async function onDiskChange(key: string, paths: string[]) {
  const bridge = workspaceBridge();
  if (!bridge) return;
  if (paths.includes(".git") || paths.length) void refreshGit(key);
  store.changeListeners.forEach((listener) => listener(key, paths));
  const tracked = store.tracked.get(key) ?? new Set<string>();
  for (const path of paths) {
    if (path === ".git" || !(DOC_EXTENSIONS.test(path) || tracked.has(path))) continue;
    try {
      const file = await bridge.read(key, path);
      if (file.binary || file.tooLarge || file.size > MAX_TRACK_BYTES) continue;
      const own = store.recentWrites.get(`${key}:${path}`);
      if (own && own.content === file.content && Date.now() - own.at < 10_000) continue;
      const hint = store.agentHint();
      await recordVersionFor(key, path, file.content, "disk", hint ? `${hint} · на диске` : "на диске");
    } catch {
      // файл удалён или переименован — фиксировать нечего
    }
  }
}

function ensureStarted() {
  const bridge = workspaceBridge();
  if (store.started || !bridge) return;
  store.started = true;
  void register();
  window.setInterval(() => { void register(); }, 60_000);
  window.setInterval(() => { void executeOps(); }, 2_000);
  window.setInterval(() => { store.roots.forEach((root) => void refreshGit(root.key)); }, 30_000);
  bridge.onChange(({ key, paths }) => { void onDiskChange(key, paths); });
}

export function useLocalWorkspace() {
  const [, setTick] = useState(0);
  const [available, setAvailable] = useState(() => Boolean(workspaceBridge()));
  // Без зависимостей намеренно: запуск идемпотентный, а так он переживает и позднее появление моста.
  useEffect(() => { if (workspaceBridge()) ensureStarted(); });

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    store.listeners.add(rerender);
    const onReady = () => { setAvailable(Boolean(workspaceBridge())); ensureStarted(); };
    window.addEventListener("mbox-desktop-ready", onReady);
    onReady();
    if (!workspaceBridge()) {
      void fetchJson<{ workspaces: ServerWorkspace[] }>("/api/mbox/workspaces").then((response) => { store.server = response.workspaces; rerender(); }).catch(() => undefined);
    }
    return () => {
      store.listeners.delete(rerender);
      window.removeEventListener("mbox-desktop-ready", onReady);
    };
  }, []);

  return {
    available,
    roots: store.roots,
    server: store.server,
    git: (key: string) => store.git.get(key),
    serverWorkspace: (key: string) => store.server.find((row) => row.root_key === key),
    refresh: () => void register(),
    refreshGit: (key: string) => void refreshGit(key),
    add: async () => { await workspaceBridge()?.add(); await register(); },
    remove: async (key: string) => {
      const id = store.serverIds.get(key);
      await workspaceBridge()?.remove(key);
      if (id) await fetchJson(`/api/mbox/workspaces/${id}`, { method: "DELETE" }).catch(() => undefined);
      store.serverIds.delete(key);
      store.git.delete(key);
      await register();
    },
    setAgentWrite: async (key: string, value: boolean) => {
      const id = store.serverIds.get(key);
      if (!id) return;
      await fetchJson(`/api/mbox/workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_write: value }) });
      await register();
    },
  };
}

export function onWorkspaceChange(listener: ChangeListener) {
  store.changeListeners.add(listener);
  return () => { store.changeListeners.delete(listener); };
}

export function setWorkspaceUser(name: string) {
  store.user = name;
}

/** Кому приписать правку, замеченную на диске: единственный агент, который только что что-то выводил. */
export function setAgentHint(hint: () => string) {
  store.agentHint = hint;
}

function rememberWrite(key: string, path: string, content: string) {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  store.recentWrites.set(`${key}:${clean}`, { content, at: Date.now() });
  for (const [entry, value] of store.recentWrites) if (Date.now() - value.at > 30_000) store.recentWrites.delete(entry);
}

export async function saveLocalFile(key: string, path: string, content: string, expectedMtime?: number) {
  const bridge = workspaceBridge();
  if (!bridge) throw new Error("Локальные файлы доступны в приложении MBOX Desktop");
  rememberWrite(key, path, content);
  const written = await bridge.write(key, path, content, expectedMtime);
  await recordVersionFor(key, written.path, content, "mbox", store.user || "человек", written.previous);
  return written;
}

export async function fetchVersions(key: string, path: string) {
  const id = store.serverIds.get(key);
  if (!id) return [];
  return (await fetchJson<{ versions: FileVersion[] }>(`/api/mbox/workspaces/${id}/versions?path=${encodeURIComponent(path)}`)).versions;
}

export async function fetchVersion(versionId: string) {
  return (await fetchJson<{ version: FileVersion & { content: string } }>(`/api/mbox/workspaces/versions/${versionId}`)).version;
}

export function rootName(key: string) {
  return store.roots.find((root) => root.key === key)?.name ?? key;
}

export function gitStatusOf(key: string, path: string): GitChange | undefined {
  return store.git.get(key)?.changes?.find((change) => change.path === path);
}
