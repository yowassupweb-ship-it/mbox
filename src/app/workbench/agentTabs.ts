import { workspaceBridge } from "./localWorkspace";
import { browserBridge, browserTabKey } from "./BrowserDocument";
import type { TabsApi } from "./tabs";

/**
 * Агент открывает вкладку в интерфейсе (MCP open_tab → POST /api/mbox/ui/open → вебсокет open_tab, см.
 * server/ui-open.mjs). Так навык ведёт сценарий: Claude из консоли открывает форму брифа рассылки,
 * готовую папку после переписывания маршрута, созданный артефакт.
 */
export type OpenTabEvent = {
  kind: "skill-file" | "path" | "url" | "tab";
  actor: string;
  reply_to: string;
  title: string;
  note: string;
  skill?: string;
  file?: string;
  path?: string;
  url?: string;
  key?: string;
  /** Открыто самим человеком (ссылка в чате) — без уведомления «агент открыл…». */
  quiet?: boolean;
};

export type OpenTabResult = {
  text: string;
  tone: "ok" | "warn";
  /** Что можно сделать прямо из уведомления, когда открыть не вышло (подключить папку и повторить). */
  action?: { label: string; run: () => Promise<OpenTabResult | void> };
};

/** Вкладка страницы навыка: skillpage:<навык>:<файл>. Кому уходит отправленное из формы — отдельно, по ключу. */
export const skillPageKey = (skill: string, file: string) => `skillpage:${skill}:${file}`;

const REPLY_KEY = "mbox.skillpage.replyTo";

function readReplyMap(): Record<string, string> {
  try { return JSON.parse(window.localStorage.getItem(REPLY_KEY) || "{}") as Record<string, string>; } catch { return {}; }
}

export function skillPageReplyTo(key: string) {
  return readReplyMap()[key] || "Claude";
}

function rememberReplyTo(key: string, agent: string) {
  if (!agent) return;
  try { window.localStorage.setItem(REPLY_KEY, JSON.stringify({ ...readReplyMap(), [key]: agent })); } catch { /* без памяти — уйдёт Claude */ }
}

// ─── Папка на диске → раскрыть её в «Папках» ─────────────────────────────────────────

type RevealRequest = { rootKey: string; path: string };
let pendingReveal: RevealRequest | null = null;
const revealListeners = new Set<(request: RevealRequest) => void>();

/** Панель «Папки» может быть ещё не смонтирована — запрос ждёт её в pendingReveal. */
export function requestLocalReveal(request: RevealRequest) {
  if (revealListeners.size) revealListeners.forEach((listener) => listener(request));
  else pendingReveal = request;
}

export function onLocalReveal(listener: (request: RevealRequest) => void) {
  revealListeners.add(listener);
  if (pendingReveal) { listener(pendingReveal); pendingReveal = null; }
  return () => { revealListeners.delete(listener); };
}

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function openLocalPath(path: string, tabs: TabsApi, showFolders: () => void): Promise<OpenTabResult> {
  const bridge = workspaceBridge();
  if (!bridge) return { text: `Файл на компьютере открывается только в MBOX Desktop: ${path}`, tone: "warn" };
  const { roots } = await bridge.info();
  const wanted = normalizePath(path);
  // Самая глубокая подключённая папка, внутри которой лежит путь.
  const root = roots
    .filter((item) => wanted === normalizePath(item.path) || wanted.startsWith(`${normalizePath(item.path)}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) {
    // Раньше это был тупик: предупреждение без единого способа что-то сделать, и человек шёл
    // подключать папку руками, теряя сам путь. Папку по-прежнему выбирает он сам, нативным
    // диалогом — страница не может подсунуть произвольный каталог, — но теперь в один щелчок,
    // и после подключения открытие повторяется тем же путём.
    return {
      text: `Путь вне подключённых папок: ${path}`,
      tone: "warn",
      action: {
        label: "Подключить папку",
        run: async () => {
          await bridge.add();
          return openLocalPath(path, tabs, showFolders);
        },
      },
    };
  }
  const rel = path.replace(/\\/g, "/").replace(/\/+$/, "").slice(root.path.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\/+/, "");
  const isDir = rel === "" || await bridge.list(root.key, rel).then(() => true, () => false);
  if (isDir) {
    requestLocalReveal({ rootKey: root.key, path: rel });
    showFolders();
    return { text: `папку ${rel || root.name}`, tone: "ok" };
  }
  tabs.open(`local:${root.key}:${rel}`, true);
  return { text: rel.split("/").pop() || rel, tone: "ok" };
}

/** Цель страницы навыка из каталога (skill-file:…, skill-blocks:…) → событие, как если бы вкладку открыл агент. */
export function skillPageEvent(target: string, title: string): OpenTabEvent | null {
  const file = target.match(/^skill-file:([a-z0-9][a-z0-9-]*)\/(.+)$/);
  if (file) return { kind: "skill-file", skill: file[1], file: file[2], title, note: "", actor: "", reply_to: "Claude" };
  const blocks = target.match(/^skill-blocks:([a-z0-9][a-z0-9-]*)$/);
  if (blocks) return { kind: "skill-file", skill: blocks[1], file: "library.html", title, note: "", actor: "", reply_to: "Claude" };
  return null;
}

export async function applyOpenTab(event: OpenTabEvent, tabs: TabsApi, showFolders: () => void): Promise<OpenTabResult> {
  switch (event.kind) {
    case "skill-file": {
      if (!event.skill || !event.file) return { text: "Агент не указал файл навыка", tone: "warn" };
      const key = skillPageKey(event.skill, event.file);
      rememberReplyTo(key, event.reply_to || event.actor);
      tabs.open(key, true);
      return { text: event.title || event.file, tone: "ok" };
    }
    case "path":
      return event.path ? openLocalPath(event.path, tabs, showFolders) : { text: "Агент не указал путь", tone: "warn" };
    case "url":
      // В приложении ссылка открывается вкладкой встроенного браузера, в вебе — соседней вкладкой.
      if (event.url && browserBridge()) tabs.open(browserTabKey(event.url), true);
      else if (event.url) window.open(event.url, "_blank", "noopener");
      return { text: event.title || event.url || "ссылку", tone: "ok" };
    case "tab":
      if (event.key) tabs.open(event.key, true);
      return { text: event.title || event.key || "вкладку", tone: "ok" };
    default:
      return { text: "Непонятно, что открыть", tone: "warn" };
  }
}

/** Страница навыка из каталога открывается так же, как её открыл бы агент (open_tab). */
export function openSkillPage(page: { title: string; target: string }, tabs: TabsApi) {
  const event = skillPageEvent(page.target, page.title);
  if (event) void applyOpenTab(event, tabs, () => undefined);
}

