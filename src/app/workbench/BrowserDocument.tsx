import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Bookmark, ChevronDown, ChevronUp, Copy, Download, Eraser, ExternalLink, FileDown, FolderOpen, Globe, History, Import, KeyRound, MoreHorizontal, Pause, Play, Printer, RotateCw, Search, Sparkles, Star, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { TabsApi } from "./tabs";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon";
import { askConfirm, showNotice } from "../../ui/askText";
import { formatBytes } from "../../lib/format";
import { readBrowserSettings, SEARCH_ENGINES, useBrowserSettings } from "./browserSettings";
import { DOWNLOAD_START_EVENT, downloadPercent, useBrowserDownloads, wireBrowserDownloads, type BrowserDownload } from "./browserDownloads";

/**
 * Вкладка встроенного браузера.
 *
 * Сам сайт рисует главный процесс (mbox-desktop/browser.js): почти любой сайт запрещает показывать
 * себя во фрейме, поэтому страница MBOX держит только панель адреса и пустое место, а его координаты
 * отправляет в приложение — туда и кладётся настоящая страница Chromium. Поэтому здесь нет ни iframe,
 * ни доступа к содержимому сайта.
 */

export type BrowserState = {
  key: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string;
  /** Масштаб страницы в процентах — меняется Ctrl+колесом над самой страницей. */
  zoom?: number;
  favicon?: string;
  /** Поиск по странице: ordinal — номер текущего совпадения, matches — сколько их (-1, пока ответа нет). */
  find?: { text: string; ordinal: number; matches: number } | null;
  /** Сайт просит HTTP-вход (Basic Auth): пока не ответили, страница спрятана и видна форма MBOX. */
  auth?: { id: string; host: string; realm: string; isProxy: boolean; failed?: boolean } | null;
};

type BrowserBridge = {
  open: (key: string, url: string) => Promise<BrowserState | null>;
  setBounds: (key: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
  show: (key: string | null) => Promise<unknown>;
  hide: (key: string) => Promise<unknown>;
  close: (key: string) => Promise<unknown>;
  capture?: (key: string) => Promise<string>;
  favicon?: (url: string) => Promise<string>;
  setSearchEngine?: (id: string) => Promise<string>;
  clearCache?: () => Promise<{ ok: boolean }>;
  moveBookmark?: (url: string, beforeUrl: string) => Promise<BrowserBookmark[]>;
  openBookmarkFolder?: (key: string, name: string, x: number, y: number) => Promise<{ ok: boolean; error?: string }>;
  openBookmarkFolderMenu?: (name: string, x: number, y: number) => Promise<{ ok: boolean; error?: string }>;
  openBookmarkMenu?: (key: string, bookmark: BrowserBookmark, x: number, y: number) => Promise<{ ok: boolean; error?: string }>;
  act: (key: string, command: string, payload?: unknown) => Promise<BrowserState | null>;
  downloads?: () => Promise<BrowserDownload[]>;
  downloadAction?: (id: number, action: string) => Promise<{ ok: boolean; error?: string }>;
  clearDownloads?: () => Promise<unknown>;
  openDownloadsFolder?: () => Promise<{ ok: boolean; error?: string }>;
  bookmarks: () => Promise<BrowserBookmark[]>;
  /** История переходов — общая, лежит на сервере MBOX (см. server/browser-state.mjs). */
  history?: (search: string, limit?: number) => Promise<BrowserHistoryEntry[]>;
  clearHistory?: (url?: string) => Promise<unknown>;
  addBookmark: (bookmark: { title: string; url: string }) => Promise<BrowserBookmark[]>;
  removeBookmark: (url: string) => Promise<BrowserBookmark[]>;
  chromeProfiles: () => Promise<string[]>;
  importBookmarks: (profile: string) => Promise<{ bookmarks?: { count?: number; error?: string } }>;
  importPasswords: () => Promise<{ ok?: boolean; count?: number; error?: string; canceled?: boolean }>;
  credentials: (url: string) => Promise<{ username: string }[]>;
  fillPassword: (key: string, username: string) => Promise<{ ok: boolean; error?: string }>;
  /** Ответ на HTTP-вход сайта: null вместо имени — отменить. Нет у старых версий приложения. */
  auth?: (id: string, username: string | null, password?: string) => Promise<{ ok: boolean; error?: string }>;
  onEvent: (handler: (payload: { type: string; url?: string; from?: string; action?: string; bookmarks?: BrowserBookmark[]; download?: BrowserDownload } & Partial<BrowserState>) => void) => () => void;
};

type BrowserBookmark = { title: string; url: string; folder?: string; source?: string; imported?: boolean };
type BrowserHistoryEntry = { url: string; title: string; visits: number; visited_at: string };

export function browserBridge(): BrowserBridge | undefined {
  return (window as unknown as { mboxDesktop?: { browser?: BrowserBridge } }).mboxDesktop?.browser;
}

/** Адрес вкладки: ключ вида «web:https://example.com». */
export const browserTabKey = (url: string) => `web:${url}`;
export const browserBlankTabKey = () => `web:blank-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const AGENT_ACTION_LABEL: Record<string, string> = {
  snapshot: "читает страницу",
  fill: "заполняет поля",
  click: "нажимает",
  highlight: "показывает",
  navigate: "открывает страницу",
  scroll: "прокручивает",
  screenshot: "смотрит на экран",
};
export const browserTabUrl = (key: string) => {
  const url = key.slice(4);
  return url.startsWith("blank-") ? "" : url;
};

export const BROWSER_FAVICON_EVENT = "mbox:browser-favicon";
export type BrowserFaviconDetail = { key?: string; url?: string; favicon: string };

const faviconByOrigin = new Map<string, string>();
const faviconByKey = new Map<string, string>();

export function browserFaviconOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

function rememberFavicon(detail: BrowserFaviconDetail) {
  if (!detail.favicon) return;
  if (detail.key) faviconByKey.set(detail.key, detail.favicon);
  const origin = detail.url ? browserFaviconOrigin(detail.url) : "";
  if (origin) faviconByOrigin.set(origin, detail.favicon);
}

export function cachedBrowserFavicon(key?: string, url?: string): string {
  return (key && faviconByKey.get(key)) || (url && faviconByOrigin.get(browserFaviconOrigin(url))) || "";
}

function publishFavicon(detail: BrowserFaviconDetail) {
  rememberFavicon(detail);
  window.dispatchEvent(new CustomEvent<BrowserFaviconDetail>(BROWSER_FAVICON_EVENT, { detail }));
}

/**
 * Меню, диалоги и попапы шапки рисуются страницей MBOX, а сайт — главным процессом поверх всего окна,
 * и он закрыл бы их собой. Пока открыт хоть один такой оверлей, страница сайта прячется, а на её месте
 * стоит снимок (см. эффект видимости в BrowserDocument). Оверлеев может быть несколько сразу, поэтому
 * счётчик, а не флаг: закрытие верхнего не должно вернуть страницу поверх нижнего.
 */
const OVERLAY_EVENT = "mbox:overlay";
let overlayCount = 0;
export function markOverlay(open: boolean) {
  overlayCount = Math.max(0, overlayCount + (open ? 1 : -1));
  window.dispatchEvent(new CustomEvent<boolean>(OVERLAY_EVENT, { detail: overlayCount > 0 }));
}

function useOverlayOpen() {
  const [open, setOpen] = useState(overlayCount > 0);
  useEffect(() => {
    const listener = (event: Event) => setOpen(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(OVERLAY_EVENT, listener);
    return () => window.removeEventListener(OVERLAY_EVENT, listener);
  }, []);
  return open;
}

function floatingPoint(rect: DOMRect, menu: { width: number; height: number }, offset = 4) {
  const padding = 8;
  return {
    x: Math.min(Math.max(padding, rect.left), Math.max(padding, window.innerWidth - menu.width - padding)),
    y: Math.min(Math.max(padding, rect.bottom + offset), Math.max(padding, window.innerHeight - menu.height - padding)),
  };
}

function pointerPoint(x: number, y: number, menu: { width: number; height: number }) {
  const padding = 8;
  return {
    x: Math.min(Math.max(padding, x), Math.max(padding, window.innerWidth - menu.width - padding)),
    y: Math.min(Math.max(padding, y), Math.max(padding, window.innerHeight - menu.height - padding)),
  };
}

function bookmarkLabel(item: BrowserBookmark) {
  const title = String(item.title || "").trim();
  if (!title || /^https?:\/\//i.test(title)) return "";
  try {
    const parsed = new URL(item.url);
    const compactUrl = `${parsed.hostname}${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    const compactTitle = title.replace(/^www\./i, "").replace(/\/$/, "");
    if (compactTitle === parsed.href.replace(/\/$/, "") || compactTitle === compactUrl.replace(/^www\./i, "")) return "";
  } catch {
    // If the URL is malformed, keep a non-empty human title rather than hiding too much.
  }
  return title;
}

export function Favicon({ url, tabKey, size = 14 }: { url?: string; tabKey?: string; size?: number }) {
  const [src, setSrc] = useState(() => cachedBrowserFavicon(tabKey, url || ""));
  useEffect(() => {
    setSrc(cachedBrowserFavicon(tabKey, url || ""));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<BrowserFaviconDetail>).detail;
      const sameKey = tabKey && detail.key === tabKey;
      const sameOrigin = url && detail.url && browserFaviconOrigin(detail.url) === browserFaviconOrigin(url);
      if (sameKey || sameOrigin) setSrc(detail.favicon);
    };
    window.addEventListener(BROWSER_FAVICON_EVENT, listener);
    // Закладка — это адрес, который может быть ни разу не открыт, и ждать события от вкладки
    // бессмысленно: иконки бы не появились никогда. Спрашиваем её у приложения сами.
    const bridge = browserBridge();
    let alive = true;
    if (url && !cachedBrowserFavicon(tabKey, url) && bridge?.favicon) {
      void bridge.favicon(url).then((icon) => {
        if (!alive || !icon) return;
        publishFavicon({ url, favicon: icon });
        setSrc(icon);
      }).catch(() => undefined);
    }
    return () => {
      alive = false;
      window.removeEventListener(BROWSER_FAVICON_EVENT, listener);
    };
  }, [tabKey, url]);
  if (!src) return <Globe size={size} aria-hidden="true" />;
  return <img className="wb-browser-favicon" src={src} width={size} height={size} alt="" draggable={false} onError={() => setSrc("")} />;
}

/**
 * Вкладку закрывают — страницу Chromium надо убрать. Но в режиме разработки React монтирует компонент
 * дважды, поэтому закрытие откладывается: если вкладка тут же вернулась, сайт не перезагружается.
 */
const pendingClose = new Map<string, number>();
const visibleClaims = new Map<string, number>();

function claimVisibleBrowser(bridge: BrowserBridge, key: string) {
  visibleClaims.set(key, (visibleClaims.get(key) || 0) + 1);
  void bridge.show(key);
  /** keepShown — страницу сейчас спрячет сам вызывающий, после снимка: прятать её раньше нельзя. */
  return (keepShown = false) => {
    const next = (visibleClaims.get(key) || 0) - 1;
    if (next > 0) {
      visibleClaims.set(key, next);
      return;
    }
    visibleClaims.delete(key);
    if (!keepShown) void bridge.hide(key);
  };
}

export function BrowserDocument({ tabKey, visible, tabs, onTitle, onState, onOpenUrl }: { tabKey: string; visible: boolean; tabs: TabsApi; onTitle: (key: string, title: string) => void; onState?: (key: string, state: BrowserState) => void; onOpenUrl?: (fromKey: string, url: string) => void }) {
  const bridge = browserBridge();
  const url = browserTabUrl(tabKey);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Меню папки — плавающее: рисуется по координатам кнопки, а не раздвигает панель.
  const [folderOpen, setFolderOpen] = useState<{ name: string; x: number; y: number } | null>(null);
  const [dragUrl, setDragUrl] = useState("");
  const [dropUrl, setDropUrl] = useState("");
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarksQuery, setBookmarksQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<BrowserHistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findTick, setFindTick] = useState(0);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const downloads = useBrowserDownloads();
  const activeDownloads = downloads.filter((item) => item.state === "progressing").length;
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState("Default");
  const [credentials, setCredentials] = useState<{ username: string }[]>([]);
  const [message, setMessage] = useState("");
  // Агент сейчас действует в этой вкладке (browser.js подсвечивает поля на самой странице, здесь — кто и что).
  const [agentNote, setAgentNote] = useState<{ actor: string; text: string } | null>(null);
  useEffect(() => {
    if (!agentNote) return;
    const timer = window.setTimeout(() => setAgentNote(null), 6000);
    return () => window.clearTimeout(timer);
  }, [agentNote]);
  const [busy, setBusy] = useState(false);
  const [settings, updateSettings] = useBrowserSettings();
  useEffect(() => { void bridge?.setSearchEngine?.(settings.search); }, [bridge, settings.search]);

  useEffect(() => { if (bridge) void bridge.bookmarks().then(setBookmarks); }, [bridge]);
  useEffect(() => { wireBrowserDownloads(bridge); }, [bridge]);
  useEffect(() => {
    if (!bridge?.history || !historyOpen) return;
    const timer = window.setTimeout(() => { void bridge.history!(historyQuery).then(setHistoryRows).catch(() => setHistoryRows([])); }, historyQuery ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [bridge, historyOpen, historyQuery]);

  useEffect(() => {
    if (!bridge || !toolsOpen) return;
    void bridge.chromeProfiles().then((items) => { setProfiles(items); if (items.length && !items.includes(profile)) setProfile(items[0]); });
    void bridge.credentials(state?.url || url).then(setCredentials);
  }, [bridge, toolsOpen, state?.url, url]);

  useEffect(() => {
    if (!bridge) return;
    const timer = pendingClose.get(tabKey);
    if (timer) { window.clearTimeout(timer); pendingClose.delete(tabKey); }
    const settings = readBrowserSettings();
    const startUrl = !url && settings.start === "url" ? settings.startUrl.trim() : "";
    void bridge.open(tabKey, url || startUrl).then((next) => {
      if (!next) return;
      setState(next);
      onState?.(tabKey, next);
      if (next.title) onTitle(tabKey, next.title);
      if (next.favicon) publishFavicon({ key: tabKey, url: next.url || url, favicon: next.favicon });
    });
    return () => {
      pendingClose.set(tabKey, window.setTimeout(() => { pendingClose.delete(tabKey); void bridge.close(tabKey); }, 400));
    };
  }, [bridge, tabKey, url, onState, onTitle]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((payload) => {
      // Сайт попросил новое окно — открываем его вкладкой MBOX, а не отдельным окном мимо интерфейса.
      // from — вкладка, которую попросил сайт: открывает только она (события приходят во все браузеры),
      // а Workbench решает, в какой области — во второй, если просящий браузер стоит там.
      if (payload.type === "open" && payload.url) {
        if (payload.from && payload.from !== tabKey) return;
        if (onOpenUrl) onOpenUrl(tabKey, payload.url);
        else tabs.open(browserTabKey(payload.url), true);
        return;
      }
      // Закладки общие: добавили звёздочкой в одной вкладке — панель обновляется во всех сразу.
      if (payload.type === "bookmarks") { setBookmarks(payload.bookmarks || []); return; }
      if (payload.type === "shortcut" && payload.key === tabKey) {
        if (payload.action === "address") { addressRef.current?.focus(); addressRef.current?.select(); }
        else if (payload.action === "find") openFind();
        else if (payload.action === "find-close") closeFind();
        else if (payload.action === "bookmark") void toggleBookmark();
        return;
      }
      if (payload.type === "agent") {
        const agentPayload = payload as { key?: string; actor?: string; action?: string; note?: string };
        if (agentPayload.key === tabKey) setAgentNote({ actor: agentPayload.actor || "Агент", text: agentPayload.note || AGENT_ACTION_LABEL[agentPayload.action || ""] || "работает на странице" });
        return;
      }
      if (payload.type !== "state" || payload.key !== tabKey) return;
      const next = payload as BrowserState;
      setState(next);
      onState?.(tabKey, next);
      if (payload.favicon) publishFavicon({ key: tabKey, url: payload.url || url, favicon: payload.favicon });
      // Заголовок вкладки MBOX — заголовок сайта: иначе во вкладке остаётся один домен.
      if (payload.title) onTitle(tabKey, payload.title);
      if (!editing && payload.url) setAddress(payload.url);
    });
  });

  useEffect(() => {
    if (!bridge?.favicon) return;
    void bridge.favicon(state?.url || url).then((favicon) => {
      if (favicon) publishFavicon({ key: tabKey, url: state?.url || url, favicon });
    }).catch(() => undefined);
  }, [bridge, tabKey, state?.url, url]);

  // Ctrl+F при уже открытом поиске возвращает фокус в поле и выделяет текст — так делает и Chrome.
  useEffect(() => {
    if (!findTick) return;
    findRef.current?.focus();
    findRef.current?.select();
  }, [findTick]);

  // Скачивание началось — показываем панель загрузок в той вкладке, которую видит человек, как в Chrome.
  useEffect(() => {
    if (!visible) return;
    const onStart = () => { setFolderOpen(null); setHistoryOpen(false); setToolsOpen(false); setDownloadsOpen(true); };
    window.addEventListener(DOWNLOAD_START_EVENT, onStart);
    return () => window.removeEventListener(DOWNLOAD_START_EVENT, onStart);
  }, [visible]);

  // Куда положить страницу. Позиция меняется не только от размера окна: двигаются боковая панель,
  // консоль, строка вкладок — поэтому прямоугольник проверяется по таймеру, а отправляется только
  // при изменении.
  const lastBounds = useRef("");
  const report = useCallback(() => {
    const element = stageRef.current;
    if (!bridge || !element) return;
    const rect = element.getBoundingClientRect();
    const bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    const signature = JSON.stringify(bounds);
    if (signature === lastBounds.current) return;
    lastBounds.current = signature;
    void bridge.setBounds(tabKey, bounds);
  }, [bridge, tabKey]);

  // Пока страница спрятана под меню, на её месте держим последний снимок — иначе под попапом
  // зияет пустое место и кажется, что вкладка перезагрузилась.
  const [frozen, setFrozen] = useState("");
  const lastFrozen = useRef("");
  // Пустая вкладка — стартовая страница MBOX вместо белого about:blank; плавающие окна (папка, история,
  // настройки) тоже прячут страницу: её рисует главный процесс поверх окна, и она закрыла бы их собой.
  const isBlank = state ? !state.url || state.url === "about:blank" : !url;
  // Страница ушла на другой адрес (например, «Открыть» в меню закладки из папки) — папка больше не нужна.
  const lastUrl = useRef(state?.url);
  useEffect(() => {
    if (state?.url && lastUrl.current && state.url !== lastUrl.current) setFolderOpen(null);
    lastUrl.current = state?.url;
  }, [state?.url]);
  const overlayOpen = useOverlayOpen();
  const hidden = Boolean(folderOpen) || bookmarksOpen || historyOpen || toolsOpen || downloadsOpen || isBlank || overlayOpen;
  // Снимок нужно сделать, пока страница ещё видна: capture() у спрятанной вкладки пустой. Раньше
  // уборка прошлого эффекта прятала страницу раньше снимка — и под «…» зияла пустота вместо сайта.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    if (!bridge || !visible) return;
    if (hidden) {
      let cancelled = false;
      if (lastFrozen.current && !isBlank) setFrozen(lastFrozen.current);
      if (isBlank) {
        void bridge.hide(tabKey);
        return () => { cancelled = true; };
      }
      const capture = bridge.capture?.(tabKey) ?? Promise.resolve("");
      const limit = new Promise<string>((resolve) => window.setTimeout(() => resolve(""), 350));
      void Promise.race([capture, limit]).then((shot) => {
        if (cancelled) return;
        if (shot) {
          lastFrozen.current = shot;
          setFrozen(shot);
        }
        // Кадр со снимком должен успеть нарисоваться до того, как уйдёт живая страница.
        window.requestAnimationFrame(() => { if (!cancelled && hiddenRef.current) void bridge.hide(tabKey); });
      }).catch(() => { if (!cancelled) void bridge.hide(tabKey); });
      return () => { cancelled = true; };
    }
    setFrozen("");
    report();
    const releaseVisible = claimVisibleBrowser(bridge, tabKey);
    const frame = window.requestAnimationFrame(report);
    // Раньше прямоугольник проверялся таймером шесть раз в секунду, и каждая проверка заставляла
    // браузер пересчитывать раскладку. ResizeObserver сообщает о смене размера сам; таймер остался
    // редким страховочным — место могло съехать без изменения размера (открыли панель сверху).
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    const timer = window.setInterval(report, 1500);
    window.addEventListener("resize", report);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearInterval(timer);
      window.removeEventListener("resize", report);
      // Переход в «спрятано»: страницу уберёт ветка выше, когда снимет снимок.
      releaseVisible(hiddenRef.current);
    };
  }, [bridge, visible, hidden, isBlank, tabKey, report]);

  if (!bridge) {
    return (
      <div className="wb-doc-missing">
        Встроенный браузер работает в приложении MBOX Desktop. Здесь, в браузере, страница {url} откроется соседней вкладкой:{" "}
        <a href={url} target="_blank" rel="noreferrer">открыть</a>.
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setEditing(false);
    void bridge!.act(tabKey, "navigate", address).then((next) => {
      if (!next) return;
      setState(next);
      onState?.(tabKey, next);
      if (next.favicon) publishFavicon({ key: tabKey, url: next.url || address, favicon: next.favicon });
    });
  }

  const pageUrl = state?.url || url;
  const saved = bookmarks.some((item) => item.url === pageUrl);
  // Панель в порядке списка, как в Chrome: папка стоит там, где её первая закладка, а не после всех закладок.
  const barEntries: Array<{ kind: "bookmark"; item: BrowserBookmark } | { kind: "folder"; name: string }> = [];
  const placedFolders = new Set<string>();
  for (const item of bookmarks) {
    if (item.source !== "bookmark_bar") continue;
    if (!item.folder) { barEntries.push({ kind: "bookmark", item }); continue; }
    const name = item.folder.split(" / ")[0];
    if (placedFolders.has(name)) continue;
    placedFolders.add(name);
    barEntries.push({ kind: "folder", name });
  }
  const hasOther = bookmarks.some((item) => item.source !== "bookmark_bar");
  const folderItems = bookmarks.filter((item) => folderOpen?.name === "Другие" ? item.source !== "bookmark_bar" : item.source === "bookmark_bar" && item.folder?.split(" / ")[0] === folderOpen?.name);

  const folderRows: Array<{ kind: "group"; key: string; label: string; depth: number } | { kind: "bookmark"; item: BrowserBookmark; depth: number }> = [];
  const seenFolderRows = new Set<string>();
  for (const item of folderItems) {
    const parts = String(item.folder || "").split(" / ").filter(Boolean);
    const nested = folderOpen?.name === "Другие" ? parts : parts.slice(1);
    nested.forEach((part, index) => {
      const key = nested.slice(0, index + 1).join(" / ");
      if (!key || seenFolderRows.has(key)) return;
      seenFolderRows.add(key);
      folderRows.push({ kind: "group", key, label: part, depth: index });
    });
    folderRows.push({ kind: "bookmark", item, depth: nested.length });
  }

  async function dropBookmark(url: string, beforeUrl: string) {
    if (!url || url === beforeUrl || !bridge!.moveBookmark) return;
    try { setBookmarks(await bridge!.moveBookmark(url, beforeUrl)); }
    catch (error) { setMessage(String(error)); }
    finally { setDropUrl(""); }
  }

  /** keepFolder — меню вызвано из открытой папки: она остаётся открытой, пока с закладкой что-то делают. */
  function openBookmarkMenu(item: BrowserBookmark, x: number, y: number, keepFolder = false) {
    if (!keepFolder) setFolderOpen(null);
    if (bridge!.openBookmarkMenu) {
      void bridge!.openBookmarkMenu(tabKey, item, x, y).catch((error) => setMessage(String(error)));
      return;
    }
    void bridge!.act(tabKey, "navigate", item.url);
  }

  function openBookmarkFolder(name: string, x: number, y: number) {
    setToolsOpen(false);
    setHistoryOpen(false);
    setFolderOpen(null);
    // Меню рисуется порталом в корень рабочего места (как WbMenu): внутри области браузера его обрезала бы
    // соседняя панель чата, а у панелей contain: layout, из-за чего fixed считался бы от области, а не от окна.
    const point = pointerPoint(x, y, { width: 320, height: Math.min(window.innerHeight * 0.6, 440) });
    setFolderOpen({ name, x: point.x, y: point.y });
  }

  async function toggleBookmark() {
    if (!/^https?:\/\//i.test(pageUrl)) return;
    try {
      setBookmarks(saved ? await bridge!.removeBookmark(pageUrl) : await bridge!.addBookmark({ title: state?.title || new URL(pageUrl).hostname, url: pageUrl }));
    } catch (error) { setMessage(String(error)); }
  }

  async function importBookmarks() {
    setBusy(true);
    try {
      const result = await bridge!.importBookmarks(profile);
      setMessage(result.bookmarks?.error || `Импортировано закладок: ${result.bookmarks?.count ?? 0}`);
      setBookmarks(await bridge!.bookmarks());
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function importPasswords() {
    setBusy(true);
    try {
      const result = await bridge!.importPasswords();
      if (!result.canceled) setMessage(result.error || `Импортировано паролей: ${result.count ?? 0}. Удалите CSV после импорта.`);
      setCredentials(await bridge!.credentials(pageUrl));
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  function closePanels() {
    setFolderOpen(null);
    setBookmarksOpen(false);
    setHistoryOpen(false);
    setToolsOpen(false);
    setDownloadsOpen(false);
  }

  function openFind() {
    closePanels();
    setFindOpen(true);
    setFindTick((tick) => tick + 1);
  }

  function closeFind() {
    setFindOpen(false);
    setFindText("");
    void bridge!.act(tabKey, "find-stop");
  }

  function runFind(text: string, forward = true) {
    setFindText(text);
    void bridge!.act(tabKey, "find", { text, forward });
  }

  /** Действие из меню «Страница»: печать, PDF, сохранение — выполняет главный процесс. */
  function pageAction(command: string) {
    setToolsOpen(false);
    void bridge!.act(tabKey, command);
  }

  async function downloadAction(item: BrowserDownload, action: string) {
    const result = await bridge!.downloadAction?.(item.id, action);
    if (result && !result.ok && result.error) void showNotice("Не получилось", result.error);
  }

  function navigate(target: string) {
    closePanels();
    void bridge!.act(tabKey, "navigate", target).then((next) => {
      if (!next) return;
      setState(next);
      onState?.(tabKey, next);
      if (next.favicon) publishFavicon({ key: tabKey, url: next.url || target, favicon: next.favicon });
    });
  }

  async function clearCache() {
    if (!bridge!.clearCache) return;
    setBusy(true);
    try {
      await bridge!.clearCache();
      setMessage("Кэш очищен. Вход на сайты сохранён.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function clearAllHistory() {
    if (!(await askConfirm({ title: "Очистить всю историю браузера?", message: "История общая для всех ваших устройств.", confirmLabel: "Очистить", danger: true }))) return;
    await bridge!.clearHistory?.();
    setHistoryRows([]);
  }

  async function removeFromFolder(item: BrowserBookmark) {
    try { setBookmarks(await bridge!.removeBookmark(item.url)); }
    catch (error) { setMessage(String(error)); }
  }

  const engineLabel = SEARCH_ENGINES.find((item) => item.id === settings.search)?.label || "";
  const bookmarkSearch = bookmarksQuery.trim().toLowerCase();
  const managedBookmarks = bookmarkSearch
    ? bookmarks.filter((item) => [item.title, item.url, item.folder, item.source].some((part) => String(part || "").toLowerCase().includes(bookmarkSearch)))
    : bookmarks;

  return (
    <div className="wb-browser" ref={rootRef}>
      <div className="wb-doc-bar wb-browser-bar">
        <div className="wb-browser-nav">
          <button type="button" disabled={!state?.canGoBack} onClick={() => void bridge.act(tabKey, "back")} title="Назад" aria-label="Назад"><ArrowLeft size={16} /></button>
          <button type="button" disabled={!state?.canGoForward} onClick={() => void bridge.act(tabKey, "forward")} title="Вперёд" aria-label="Вперёд"><ArrowRight size={16} /></button>
          <button type="button" onClick={() => void bridge.act(tabKey, state?.loading ? "stop" : "reload")} title={state?.loading ? "Остановить" : "Обновить"} aria-label={state?.loading ? "Остановить" : "Обновить"}>
            {state?.loading ? <X size={16} /> : <RotateCw size={15} />}
          </button>
        </div>
        <form className="wb-browser-address" onSubmit={submit}>
          {isBlank && !editing ? <Search size={14} aria-hidden="true" /> : <Favicon tabKey={tabKey} url={pageUrl} size={14} />}
          <input
            ref={addressRef}
            value={isBlank && !editing ? "" : address}
            spellCheck={false}
            onKeyDown={(event) => { if (event.key === "Escape") { setAddress(state?.url || url); event.currentTarget.blur(); } }}
            onChange={(event) => { setAddress(event.target.value); setEditing(true); }}
            onFocus={(event) => { setEditing(true); event.target.select(); }}
            onBlur={() => { setEditing(false); setAddress(state?.url || url); }}
            placeholder={`Поиск в ${engineLabel} или адрес`}
            aria-label="Адрес сайта"
          />
          {state?.zoom !== undefined && state.zoom !== 100 && (
            <button type="button" className="wb-browser-zoom" onClick={() => void bridge.act(tabKey, "zoom-reset").then((next) => next && setState(next))} title="Сбросить масштаб (Ctrl+колесо над страницей)">
              {state.zoom}%
            </button>
          )}
          <button type="button" className="wb-browser-star" disabled={!/^https?:\/\//i.test(pageUrl)} onClick={() => void toggleBookmark()} title={saved ? "Убрать из закладок" : "Добавить в закладки"} aria-label={saved ? "Убрать из закладок" : "Добавить в закладки"} aria-pressed={saved}>
            <Star size={15} fill={saved ? "currentColor" : "none"} />
          </button>
        </form>
        {agentNote && <span className="wb-browser-agent" role="status"><Sparkles size={13} aria-hidden="true" />{agentNote.actor}: {agentNote.text}</span>}
        <div className="wb-browser-actions">
          <button type="button" className={bookmarksOpen ? "is-on" : undefined} onClick={() => { const next = !bookmarksOpen; closePanels(); setBookmarksOpen(next); }} title="Закладки" aria-label="Закладки" aria-expanded={bookmarksOpen}>
            <Bookmark size={16} />
          </button>
          {bridge.downloads && (
            <button type="button" className={downloadsOpen ? "is-on wb-browser-downloads-button" : "wb-browser-downloads-button"} onClick={() => { const next = !downloadsOpen; closePanels(); setDownloadsOpen(next); }} title="Загрузки" aria-label={activeDownloads ? `Загрузки, идёт ${activeDownloads}` : "Загрузки"} aria-expanded={downloadsOpen}>
              <Download size={16} />
              {activeDownloads > 0 && <span className="wb-browser-badge" aria-hidden="true">{activeDownloads}</span>}
            </button>
          )}
          {bridge.history && (
            <button type="button" className={historyOpen ? "is-on" : undefined} onClick={() => { const next = !historyOpen; closePanels(); setHistoryOpen(next); }} title="История" aria-label="История" aria-expanded={historyOpen}>
              <History size={16} />
            </button>
          )}
          <button type="button" className={toolsOpen ? "is-on" : undefined} onClick={() => { const next = !toolsOpen; closePanels(); setMessage(""); setToolsOpen(next); }} title="Настройки браузера" aria-label="Настройки браузера" aria-expanded={toolsOpen}>
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>
      <div
        className="wb-browser-bookmarks"
        aria-label="Панель закладок"
        // Колесо мыши листает панель вбок, как в Chrome: вертикальной прокрутки у неё нет.
        onWheel={(event) => {
          if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        <Bookmark size={14} aria-hidden="true" />
        {barEntries.map((entry) => {
          if (entry.kind === "folder") {
            const name = entry.name;
            return (
              <button
                type="button"
                className="wb-bookmark-folder"
                key={`folder:${name}`}
                aria-expanded={folderOpen?.name === name}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (folderOpen?.name === name) setFolderOpen(null);
                  else openBookmarkFolder(name, rect.left, rect.bottom + 4);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setFolderOpen(null);
                  void bridge.openBookmarkFolderMenu?.(name, event.clientX, event.clientY).catch((error) => setMessage(String(error)));
                }}
              >
                <FolderIcon size={16} open={folderOpen?.name === name} />
                <span>{name}</span>
              </button>
            );
          }
          const item = entry.item;
          const label = bookmarkLabel(item);
          return (
          <button
            type="button"
            key={item.url}
            className={dropUrl === item.url ? "is-drop-target" : undefined}
            title={label ? `${label}\n${item.url}` : item.url}
            draggable
            onDragStart={(event) => { setDragUrl(item.url); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/uri-list", item.url); }}
            onDragOver={(event) => { if (dragUrl && dragUrl !== item.url) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropUrl(item.url); } }}
            onDragLeave={() => { if (dropUrl === item.url) setDropUrl(""); }}
            onDrop={(event) => { event.preventDefault(); void dropBookmark(dragUrl, item.url); setDragUrl(""); }}
            onDragEnd={() => { setDragUrl(""); setDropUrl(""); }}
            onClick={() => navigate(item.url)}
            onContextMenu={(event) => {
              event.preventDefault();
              openBookmarkMenu(item, event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                void bridge.removeBookmark(item.url).then(setBookmarks).catch((error) => setMessage(String(error)));
              }
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openBookmarkMenu(item, rect.left, rect.bottom);
              }
            }}
          >
            <Favicon url={item.url} />
            {/* Без названия остаётся одна фавиконка — правило CSS :not(:has(span)) поджимает отступы. */}
            {label && <span>{label}</span>}
          </button>
          );
        })}
        {!barEntries.length && !hasOther && <span>Добавьте страницу звёздочкой или импортируйте закладки Chrome</span>}
        {hasOther && (
          <button
            type="button"
            className="wb-bookmark-folder"
            aria-expanded={folderOpen?.name === "Другие"}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (folderOpen?.name === "Другие") setFolderOpen(null);
              else openBookmarkFolder("Другие", rect.left, rect.bottom + 4);
            }}
          >
            <FolderIcon size={16} open={folderOpen?.name === "Другие"} />
            <span>Другие</span>
          </button>
        )}
      </div>

      {/* Плавающие окна: подложка ловит клик мимо и закрывает их. */}
      {(folderOpen || bookmarksOpen || historyOpen || toolsOpen || downloadsOpen) && (
        <div className="wb-bookmark-scrim" onClick={closePanels} onContextMenu={(event) => { event.preventDefault(); closePanels(); }} />
      )}

      {folderOpen && createPortal(
        <div className="wb-browser-pop wb-browser-folder-menu" style={{ left: folderOpen.x, top: folderOpen.y }} role="menu" aria-label={`Закладки: ${folderOpen.name}`}>
          <div className="wb-browser-pop-head"><FolderIcon size={16} open /><span>{folderOpen.name}</span><small>{folderItems.length}</small></div>
          <div className="wb-browser-pop-list">
            {folderRows.map((row) => {
              if (row.kind === "group") {
                return (
                  <div className="wb-browser-pop-folder-row" key={`folder:${row.key}`} style={{ "--depth": row.depth } as CSSProperties}>
                    <FolderIcon size={14} open />
                    <span>{row.label}</span>
                  </div>
                );
              }
              const item = row.item;
              const label = bookmarkLabel(item) || bookmarkHost(item.url);
              return (
                <div className="wb-browser-pop-row" key={`${item.source}:${item.url}`} role="none" style={{ "--depth": row.depth } as CSSProperties}>
                  <button
                    type="button"
                    role="menuitem"
                    title={`${label}\n${item.url}`}
                    onClick={() => { closePanels(); navigate(item.url); }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openBookmarkMenu(item, event.clientX, event.clientY, true);
                    }}
                  >
                    <Favicon url={item.url} size={16} />
                    <span>{label}</span>
                  </button>
                  <button type="button" className="wb-browser-pop-remove" onClick={() => void removeFromFolder(item)} title="Удалить закладку" aria-label={`Удалить закладку ${label}`}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {!folderItems.length && <div className="wb-browser-pop-empty">Папка пуста</div>}
          </div>
        </div>,
        document.querySelector(".wb") ?? document.body,
      )}

      {bookmarksOpen && (
        <div className="wb-browser-pop wb-browser-manager" role="dialog" aria-label="Закладки">
          <div className="wb-browser-pop-head">
            <Bookmark size={14} /><span>Закладки</span><small>{bookmarks.length}</small>
          </div>
          <label className="wb-browser-pop-search">
            <Search size={13} aria-hidden="true" />
            <input value={bookmarksQuery} onChange={(event) => setBookmarksQuery(event.target.value)} placeholder="Найти закладку" aria-label="Найти закладку" autoFocus />
          </label>
          <div className="wb-browser-pop-list">
            {managedBookmarks.map((item, index) => {
              const label = bookmarkLabel(item) || bookmarkHost(item.url);
              return (
                <div className="wb-browser-pop-row" key={`manager:${item.source || "bookmark"}:${item.folder || ""}:${item.url}:${index}`}>
                  <button
                    type="button"
                    title={`${label}\n${item.url}`}
                    onClick={() => { closePanels(); navigate(item.url); }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openBookmarkMenu(item, event.clientX, event.clientY);
                    }}
                  >
                    <Favicon url={item.url} size={16} />
                    <span className="wb-browser-history-text">
                      <span className="wb-browser-history-title">{label}</span>
                      <span className="wb-browser-history-url">{[item.folder, bookmarkHost(item.url)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                  <button type="button" className="wb-browser-pop-remove" onClick={() => void removeFromFolder(item)} title="Удалить закладку" aria-label={`Удалить закладку ${label}`}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {!managedBookmarks.length && <div className="wb-browser-pop-empty">{bookmarksQuery ? "Ничего не найдено" : "Закладок пока нет"}</div>}
          </div>
        </div>
      )}


      {downloadsOpen && (
        <div className="wb-browser-pop wb-browser-downloads" role="dialog" aria-label="Загрузки">
          <div className="wb-browser-pop-head">
            <Download size={14} /><span>Загрузки</span>
            {downloads.some((item) => item.state !== "progressing") && <button type="button" className="wb-browser-pop-link" onClick={() => void bridge.clearDownloads?.()}>Очистить список</button>}
          </div>
          <div className="wb-browser-pop-list">
            {downloads.map((item) => <DownloadRow key={item.id} item={item} onAction={(action) => void downloadAction(item, action)} />)}
            {!downloads.length && <div className="wb-browser-pop-empty">Скачанных файлов пока нет</div>}
          </div>
          <div className="wb-browser-pop-foot">
            <button type="button" className="wb-browser-pop-link" onClick={() => void bridge.openDownloadsFolder?.()}><FolderOpen size={13} /> Открыть папку загрузок</button>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="wb-browser-pop wb-browser-history" role="dialog" aria-label="История браузера">
          <div className="wb-browser-pop-head">
            <History size={14} /><span>История</span>
            <button type="button" className="wb-browser-pop-link" onClick={() => void clearAllHistory()}>Очистить всё</button>
          </div>
          <label className="wb-browser-pop-search">
            <Search size={13} aria-hidden="true" />
            <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Поиск по истории" aria-label="Поиск по истории" autoFocus />
          </label>
          <div className="wb-browser-pop-list">
            {historyRows.map((row) => (
              <div className="wb-browser-pop-row" key={row.url}>
                <button type="button" title={row.url} onClick={() => navigate(row.url)}>
                  <Favicon url={row.url} size={16} />
                  <span className="wb-browser-history-text">
                    <span className="wb-browser-history-title">{row.title || bookmarkHost(row.url)}</span>
                    <span className="wb-browser-history-url">{bookmarkHost(row.url)} · {visitedLabel(row.visited_at)}</span>
                  </span>
                </button>
                <button type="button" className="wb-browser-pop-remove" onClick={() => { void bridge.clearHistory?.(row.url).then(() => setHistoryRows((rows) => rows.filter((item) => item.url !== row.url))); }} title="Убрать из истории" aria-label="Убрать из истории">
                  <X size={13} />
                </button>
              </div>
            ))}
            {!historyRows.length && <div className="wb-browser-pop-empty">{historyQuery ? "Ничего не нашлось" : "История пока пуста"}</div>}
          </div>
        </div>
      )}

      {toolsOpen && (
        <div className="wb-browser-pop wb-browser-settings" role="dialog" aria-label="Настройки браузера">
          {!isBlank && (
            <section>
              <h4>Страница</h4>
              <div className="wb-browser-pop-buttons">
                <button type="button" onClick={() => { setToolsOpen(false); openFind(); }}><Search size={14} /> Найти</button>
                <button type="button" onClick={() => pageAction("print")}><Printer size={14} /> Печать</button>
                <button type="button" onClick={() => pageAction("save-pdf")}><FileDown size={14} /> Сохранить как PDF</button>
                <button type="button" onClick={() => pageAction("save-page")}><Download size={14} /> Сохранить страницу</button>
                <button type="button" disabled={!/^https?:\/\//i.test(pageUrl)} onClick={() => { void bridge.act(tabKey, "copy-url"); setMessage("Адрес скопирован"); }}><Copy size={14} /> Копировать адрес</button>
              </div>
            </section>
          )}
          <section>
            <h4>Поиск в строке адреса</h4>
            <div className="wb-segmented" role="radiogroup" aria-label="Поисковик">
              {SEARCH_ENGINES.map((engine) => (
                <button key={engine.id} type="button" role="radio" aria-checked={settings.search === engine.id} className={settings.search === engine.id ? "is-on" : undefined} onClick={() => updateSettings({ search: engine.id })}>{engine.label}</button>
              ))}
            </div>
          </section>
          <section>
            <h4>Новая вкладка</h4>
            <label className="wb-browser-radio"><input type="radio" name={`start-${tabKey}`} checked={settings.start === "mbox"} onChange={() => updateSettings({ start: "mbox" })} /> Стартовая страница MBOX: поиск, закладки, недавнее</label>
            <label className="wb-browser-radio"><input type="radio" name={`start-${tabKey}`} checked={settings.start === "url"} onChange={() => updateSettings({ start: "url" })} /> Открывать адрес</label>
            <input
              className="wb-browser-pop-input"
              value={settings.startUrl}
              disabled={settings.start !== "url"}
              onChange={(event) => updateSettings({ startUrl: event.target.value })}
              placeholder="https://ya.ru"
              spellCheck={false}
              aria-label="Адрес новой вкладки"
            />
            {!isBlank && <button type="button" className="wb-browser-pop-link" onClick={() => updateSettings({ start: "url", startUrl: pageUrl })}>Сделать текущую страницу стартовой</button>}
          </section>
          <section>
            <h4>Данные</h4>
            <div className="wb-browser-pop-buttons">
              {bridge.clearCache && <button type="button" disabled={busy} onClick={() => void clearCache()}><Eraser size={14} /> Очистить кэш</button>}
              {bridge.history && <button type="button" onClick={() => void clearAllHistory()}><Trash2 size={14} /> Очистить историю</button>}
            </div>
          </section>
          <section>
            <h4>Импорт из Chrome</h4>
            <div className="wb-browser-pop-buttons">
              <select value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy || !profiles.length} aria-label="Профиль Chrome">
                {profiles.length ? profiles.map((item) => <option key={item} value={item}>{item}</option>) : <option value="Default">Профили не найдены</option>}
              </select>
              <button type="button" disabled={busy || !profiles.length} onClick={() => void importBookmarks()}><Import size={14} /> Закладки</button>
              <button type="button" disabled={busy} onClick={() => void importPasswords()}><KeyRound size={14} /> Пароли из CSV</button>
            </div>
            <small>Пароли сначала экспортируйте в Chrome. Они сохранятся только на этом компьютере.</small>
          </section>
          {credentials.length > 0 && (
            <section>
              <h4>Вход на этот сайт</h4>
              <div className="wb-browser-pop-buttons">
                {credentials.map((item) => <button type="button" key={item.username} onClick={() => { void bridge.fillPassword(tabKey, item.username).then((result) => { setMessage(result.error || "Поля входа заполнены"); setToolsOpen(false); }); }}><KeyRound size={14} /> {item.username}</button>)}
              </div>
            </section>
          )}
          {!isBlank && (
            <section>
              <button type="button" className="wb-browser-pop-link" onClick={() => pageAction("open-external")}><ExternalLink size={13} /> Открыть в системном браузере</button>
            </section>
          )}
          {message && <div className="wb-browser-tools-message" role="status">{message}</div>}
        </div>
      )}
      {findOpen && (
        <div className="wb-browser-find" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={findRef}
            value={findText}
            spellCheck={false}
            placeholder="Найти на странице"
            aria-label="Найти на странице"
            onChange={(event) => runFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeFind(); }
              else if (event.key === "Enter") { event.preventDefault(); if (findText) runFind(findText, !event.shiftKey); }
            }}
          />
          <span className="wb-browser-find-count" role="status" aria-live="polite">
            {findText && state?.find && state.find.matches >= 0 ? (state.find.matches ? `${state.find.ordinal} из ${state.find.matches}` : "Нет совпадений") : ""}
          </span>
          <button type="button" disabled={!state?.find?.matches || state.find.matches < 0} onClick={() => runFind(findText, false)} title="Предыдущее (Shift+Enter)" aria-label="Предыдущее совпадение"><ChevronUp size={15} /></button>
          <button type="button" disabled={!state?.find?.matches || state.find.matches < 0} onClick={() => runFind(findText, true)} title="Следующее (Enter)" aria-label="Следующее совпадение"><ChevronDown size={15} /></button>
          <button type="button" onClick={() => closeFind()} title="Закрыть (Esc)" aria-label="Закрыть поиск"><X size={14} /></button>
        </div>
      )}
      {state?.error && <div className="wb-banner is-error" role="alert">{state.error}</div>}
      {/* Пустое место под страницу: её рисует поверх главный процесс по этим координатам. */}
      <div ref={stageRef} className="wb-browser-stage" data-scroll-memory="off">
        {isBlank && !state?.auth && <BrowserStartPage engine={engineLabel} bookmarks={bookmarks} history={bridge.history} onNavigate={navigate} />}
        {frozen && !isBlank && !state?.auth && <img className="wb-browser-frozen" src={frozen} alt="" draggable={false} />}
        {state?.auth && bridge?.auth && <BrowserAuthForm key={state.auth.id} auth={state.auth} answer={bridge.auth} />}
      </div>
    </div>
  );
}

function downloadStatus(item: BrowserDownload) {
  if (item.state === "completed") return `${formatBytes(item.total || item.received)}${item.host ? ` · ${item.host}` : ""}`;
  if (item.state === "cancelled") return "Отменено";
  if (item.state === "interrupted") return item.error || "Загрузка прервана";
  const percent = downloadPercent(item);
  const size = item.total > 0 ? `${formatBytes(item.received)} из ${formatBytes(item.total)}` : formatBytes(item.received);
  return `${item.paused ? "Пауза · " : ""}${size}${percent !== null ? ` · ${percent}%` : ""}`;
}

function DownloadRow({ item, onAction }: { item: BrowserDownload; onAction: (action: string) => void }) {
  const percent = downloadPercent(item);
  const live = item.state === "progressing";
  const failed = item.state === "cancelled" || item.state === "interrupted";
  return (
    <div className={`wb-browser-download${failed ? " is-failed" : ""}`}>
      <FileTypeIcon name={item.name} size={22} />
      <div className="wb-browser-download-main">
        <span className="wb-browser-download-name" title={item.path || item.name}>{item.name}</span>
        <span className="wb-browser-download-meta">{downloadStatus(item)}{item.state === "completed" && item.risky ? " · исполняемый файл" : ""}</span>
        {live && (
          <div className="wb-browser-download-bar" role="progressbar" aria-label={`Загрузка ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <span className={percent === null ? "is-indeterminate" : undefined} style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="wb-browser-download-actions">
        {live && <button type="button" onClick={() => onAction(item.paused ? "resume" : "pause")} title={item.paused ? "Продолжить" : "Приостановить"} aria-label={item.paused ? `Продолжить ${item.name}` : `Приостановить ${item.name}`}>{item.paused ? <Play size={14} /> : <Pause size={14} />}</button>}
        {live && <button type="button" className="is-danger" onClick={() => onAction("cancel")} title="Отменить" aria-label={`Отменить ${item.name}`}><X size={14} /></button>}
        {item.state === "completed" && !item.risky && <button type="button" onClick={() => onAction("open")} title="Открыть файл" aria-label={`Открыть ${item.name}`}><ExternalLink size={14} /></button>}
        {item.state === "completed" && <button type="button" onClick={() => onAction("reveal")} title="Показать в папке" aria-label={`Показать ${item.name} в папке`}><FolderOpen size={14} /></button>}
        {!live && <button type="button" className="is-danger" onClick={() => onAction("remove")} title="Убрать из списка" aria-label={`Убрать ${item.name} из списка`}><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

function bookmarkHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function visitedLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `вчера, ${time}`;
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Новая вкладка: большая строка поиска, закладки плитками, недавнее — вместо белого листа. */
function BrowserStartPage({ engine, bookmarks, history, onNavigate }: {
  engine: string;
  bookmarks: BrowserBookmark[];
  history?: BrowserBridge["history"];
  onNavigate: (target: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<BrowserHistoryEntry[]>([]);
  useEffect(() => {
    if (!history) return;
    let alive = true;
    void history("", 12).then((rows) => { if (alive) setRecent(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [history]);
  const tiles = bookmarks.filter((item) => item.source === "bookmark_bar" && !item.folder).slice(0, 12);
  return (
    <div className="wb-browser-start">
      <form className="wb-browser-start-search" onSubmit={(event) => { event.preventDefault(); if (query.trim()) onNavigate(query.trim()); }}>
        <Search size={18} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Поиск в ${engine} или адрес сайта`} aria-label="Поиск или адрес" spellCheck={false} autoFocus />
      </form>
      {tiles.length > 0 && (
        <section>
          <h3>Закладки</h3>
          <div className="wb-browser-start-tiles">
            {tiles.map((item) => (
              <button type="button" key={item.url} onClick={() => onNavigate(item.url)} title={item.url}>
                <span className="wb-browser-start-icon"><Favicon url={item.url} size={24} /></span>
                <span className="wb-browser-start-label">{bookmarkLabel(item) || bookmarkHost(item.url)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h3>Недавно открытые</h3>
          <div className="wb-browser-start-recent">
            {recent.map((row) => (
              <button type="button" key={row.url} onClick={() => onNavigate(row.url)} title={row.url}>
                <Favicon url={row.url} size={16} />
                <span className="wb-browser-history-title">{row.title || bookmarkHost(row.url)}</span>
                <span className="wb-browser-history-url">{bookmarkHost(row.url)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Вход на сайт по HTTP-авторизации (Basic/Digest, nginx «401 Authorization Required»). Chromium
 * спрашивает имя и пароль сам, но встроенному браузеру показать своё окно негде — страница спрятана,
 * и на её месте эта форма. Пароль уходит только в Chromium этой вкладки; Chromium сам помнит вход до
 * конца сессии браузера.
 */
function BrowserAuthForm({ auth, answer }: { auth: NonNullable<BrowserState["auth"]>; answer: NonNullable<BrowserBridge["auth"]> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (cancel = false) => {
    setBusy(true);
    void answer(auth.id, cancel ? null : username, cancel ? "" : password).finally(() => setBusy(false));
  };
  return (
    <form className="wb-browser-auth" onSubmit={(event) => { event.preventDefault(); submit(); }} aria-label="Вход на сайт">
      <strong>{auth.isProxy ? "Вход на прокси-сервер" : "Сайт просит вход"}</strong>
      <span className="wb-browser-auth-host">{auth.host}{auth.realm ? ` · ${auth.realm}` : ""}</span>
      {auth.failed && <span className="wb-browser-auth-error" role="alert">Имя или пароль не подошли — попробуйте ещё раз.</span>}
      <label>
        <span>Имя пользователя</span>
        <input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} />
      </label>
      <label>
        <span>Пароль</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
      </label>
      <div className="wb-browser-auth-actions">
        <button type="submit" className="is-primary" disabled={busy || !username}>Войти</button>
        <button type="button" onClick={() => submit(true)} disabled={busy}>Отмена</button>
      </div>
    </form>
  );
}
