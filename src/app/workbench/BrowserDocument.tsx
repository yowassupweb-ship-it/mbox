import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Bookmark, Download, ExternalLink, Folder, Globe, History, RotateCw, Star, Trash2, X } from "lucide-react";
import type { TabsApi } from "./tabs";

/**
 * Вкладка встроенного браузера.
 *
 * Сам сайт рисует главный процесс (mbox-desktop/browser.js): почти любой сайт запрещает показывать
 * себя во фрейме, поэтому страница MBOX держит только панель адреса и пустое место, а его координаты
 * отправляет в приложение — туда и кладётся настоящая страница Chromium. Поэтому здесь нет ни iframe,
 * ни доступа к содержимому сайта.
 */

type BrowserState = {
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
};

type BrowserBridge = {
  open: (key: string, url: string) => Promise<BrowserState | null>;
  setBounds: (key: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
  show: (key: string | null) => Promise<unknown>;
  hide: (key: string) => Promise<unknown>;
  close: (key: string) => Promise<unknown>;
  capture?: (key: string) => Promise<string>;
  favicon?: (key: string, url?: string) => Promise<string>;
  act: (key: string, command: string, payload?: string) => Promise<BrowserState | null>;
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
  onEvent: (handler: (payload: { type: string; url?: string; bookmarks?: BrowserBookmark[] } & Partial<BrowserState>) => void) => () => void;
};

type BrowserBookmark = { title: string; url: string; folder?: string; source?: string };
type BrowserHistoryEntry = { url: string; title: string; visits: number; visited_at: string };

export function browserBridge(): BrowserBridge | undefined {
  return (window as unknown as { mboxDesktop?: { browser?: BrowserBridge } }).mboxDesktop?.browser;
}

/** Адрес вкладки: ключ вида «web:https://example.com». */
export const browserTabKey = (url: string) => `web:${url}`;
export const browserTabUrl = (key: string) => key.slice(4);

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
    return () => window.removeEventListener(BROWSER_FAVICON_EVENT, listener);
  }, [tabKey, url]);
  if (!src) return <Globe size={size} aria-hidden="true" />;
  return <img className="wb-browser-favicon" src={src} width={size} height={size} alt="" draggable={false} onError={() => setSrc("")} />;
}

/**
 * Меню и диалоги MBOX рисуются поверх документа, а страница браузера лежит поверх всего окна и
 * закрыла бы их собой. Пока открыто меню, страница прячется: событие шлют WbMenu и askText.
 */
export const OVERLAY_EVENT = "mbox:overlay";
/**
 * Оверлеев может быть несколько сразу (меню поверх диалога, попап шапки поверх меню), поэтому
 * считаем их, а не храним один флаг: иначе закрытие верхнего вернуло бы страницу поверх нижнего.
 */
let overlayCount = 0;
export function markOverlay(open: boolean) {
  overlayCount = Math.max(0, overlayCount + (open ? 1 : -1));
  window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: overlayCount > 0 }));
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
  return () => {
    const next = (visibleClaims.get(key) || 0) - 1;
    if (next > 0) {
      visibleClaims.set(key, next);
      return;
    }
    visibleClaims.delete(key);
    void bridge.hide(key);
  };
}

export function BrowserDocument({ tabKey, visible, tabs, onTitle }: { tabKey: string; visible: boolean; tabs: TabsApi; onTitle: (key: string, title: string) => void }) {
  const bridge = browserBridge();
  const url = browserTabUrl(tabKey);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<BrowserHistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState("Default");
  const [credentials, setCredentials] = useState<{ username: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (bridge) void bridge.bookmarks().then(setBookmarks); }, [bridge]);
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
    void bridge.open(tabKey, url).then((next) => {
      if (!next) return;
      setState(next);
      if (next.favicon) publishFavicon({ key: tabKey, url: next.url || url, favicon: next.favicon });
    });
    return () => {
      pendingClose.set(tabKey, window.setTimeout(() => { pendingClose.delete(tabKey); void bridge.close(tabKey); }, 400));
    };
  }, [bridge, tabKey, url]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((payload) => {
      // Сайт попросил новое окно — открываем его вкладкой MBOX, а не отдельным окном мимо интерфейса.
      if (payload.type === "open" && payload.url) { tabs.open(browserTabKey(payload.url), true); return; }
      // Закладки общие: добавили звёздочкой в одной вкладке — панель обновляется во всех сразу.
      if (payload.type === "bookmarks") { setBookmarks(payload.bookmarks || []); return; }
      if (payload.type !== "state" || payload.key !== tabKey) return;
      setState(payload as BrowserState);
      if (payload.favicon) publishFavicon({ key: tabKey, url: payload.url || url, favicon: payload.favicon });
      // Заголовок вкладки MBOX — заголовок сайта: иначе во вкладке остаётся один домен.
      if (payload.title) onTitle(tabKey, payload.title);
      if (!editing && payload.url) setAddress(payload.url);
    });
  }, [bridge, tabKey, url, editing, tabs, onTitle]);

  useEffect(() => {
    if (!bridge?.favicon) return;
    void bridge.favicon(tabKey, state?.url || url).then((favicon) => {
      if (favicon) publishFavicon({ key: tabKey, url: state?.url || url, favicon });
    }).catch(() => undefined);
  }, [bridge, tabKey, state?.url, url]);

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

  // Меню или диалог MBOX открылись — страница сайта уходит, иначе она перекрыла бы их собой.
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => setOverlay(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(OVERLAY_EVENT, listener);
    return () => window.removeEventListener(OVERLAY_EVENT, listener);
  }, []);

  // Пока страница спрятана под меню, на её месте держим последний снимок — иначе под попапом
  // зияет пустое место и кажется, что вкладка перезагрузилась.
  const [frozen, setFrozen] = useState("");
  const hidden = Boolean(overlay || toolsOpen || folderOpen || historyOpen);

  useEffect(() => {
    if (!bridge || !visible) return;
    if (hidden) {
      let cancelled = false;
      void (bridge.capture?.(tabKey) ?? Promise.resolve("")).then((shot) => { if (!cancelled && shot) setFrozen(shot); })
        .finally(() => { if (!cancelled) void bridge.hide(tabKey); });
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
      releaseVisible();
    };
  }, [bridge, visible, hidden, tabKey, report]);

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
      if (next.favicon) publishFavicon({ key: tabKey, url: next.url || address, favicon: next.favicon });
    });
  }

  const pageUrl = state?.url || url;
  const saved = bookmarks.some((item) => item.url === pageUrl);
  const bar = bookmarks.filter((item) => item.source === "bookmark_bar" && !item.folder);
  const folders = [...new Set(bookmarks.filter((item) => item.source === "bookmark_bar" && item.folder).map((item) => item.folder!.split(" / ")[0]))];
  const hasOther = bookmarks.some((item) => item.source !== "bookmark_bar");
  const folderItems = bookmarks.filter((item) => folderOpen === "Другие" ? item.source !== "bookmark_bar" : item.source === "bookmark_bar" && item.folder?.split(" / ")[0] === folderOpen);

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

  return (
    <div className="wb-browser">
      <div className="wb-doc-bar">
        <div className="wb-browser-nav">
          <button type="button" disabled={!state?.canGoBack} onClick={() => void bridge.act(tabKey, "back")} title="Назад"><ArrowLeft size={15} /></button>
          <button type="button" disabled={!state?.canGoForward} onClick={() => void bridge.act(tabKey, "forward")} title="Вперёд"><ArrowRight size={15} /></button>
          <button type="button" onClick={() => void bridge.act(tabKey, state?.loading ? "stop" : "reload")} title={state?.loading ? "Остановить" : "Обновить"}>
            {state?.loading ? <X size={15} /> : <RotateCw size={14} />}
          </button>
        </div>
        <form className="wb-browser-address" onSubmit={submit}>
          <Favicon tabKey={tabKey} url={pageUrl} size={13} />
          <input
            value={address}
            spellCheck={false}
            onChange={(event) => { setAddress(event.target.value); setEditing(true); }}
            onFocus={(event) => { setEditing(true); event.target.select(); }}
            onBlur={() => { setEditing(false); setAddress(state?.url || url); }}
            autoFocus={!url}
            placeholder="Адрес сайта или поиск"
            aria-label="Адрес сайта"
          />
        </form>
        <div className="wb-doc-actions">
          <button type="button" disabled={!/^https?:\/\//i.test(pageUrl)} onClick={() => void toggleBookmark()} title={saved ? "Убрать из закладок" : "Добавить в закладки"} aria-label={saved ? "Убрать из закладок" : "Добавить в закладки"} aria-pressed={saved}><Star size={15} fill={saved ? "currentColor" : "none"} /></button>
          {bridge.history && (
            <button type="button" onClick={() => { setToolsOpen(false); setFolderOpen(null); setHistoryOpen((open) => !open); }} title="История браузера" aria-label="История браузера" aria-expanded={historyOpen}>
              <History size={15} />
            </button>
          )}
          <button type="button" onClick={() => { setFolderOpen(null); setHistoryOpen(false); setToolsOpen((open) => !open); }} title="Импорт и пароли" aria-label="Импорт и пароли" aria-expanded={toolsOpen}><Download size={15} /></button>
          {state?.zoom !== undefined && state.zoom !== 100 && (
            <button type="button" className="wb-browser-zoom" onClick={() => void bridge.act(tabKey, "zoom-reset").then((next) => next && setState(next))} title="Сбросить масштаб (Ctrl+колесо над страницей)">
              {state.zoom}%
            </button>
          )}
          <button type="button" onClick={() => window.open(state?.url || url, "_blank", "noopener")} title="Открыть в системном браузере"><ExternalLink size={14} /></button>
        </div>
      </div>
      <div className="wb-browser-bookmarks" aria-label="Панель закладок">
        <Bookmark size={14} aria-hidden="true" />
        {bar.map((item) => (
          <button type="button" key={item.url} title={item.url} onClick={() => void bridge.act(tabKey, "navigate", item.url)}>
            <Favicon url={item.url} />
            <span>{item.title}</span>
          </button>
        ))}
        {!bar.length && !folders.length && !hasOther && <span>Добавьте страницу звёздочкой или импортируйте закладки Chrome</span>}
        {folders.map((name) => (
          <button type="button" key={name} aria-expanded={folderOpen === name} onClick={() => { setToolsOpen(false); setFolderOpen(folderOpen === name ? null : name); }}>
            <Folder size={13} />
            <span>{name}</span>
          </button>
        ))}
        {hasOther && (
          <button type="button" aria-expanded={folderOpen === "Другие"} onClick={() => { setToolsOpen(false); setFolderOpen(folderOpen === "Другие" ? null : "Другие"); }}>
            <Folder size={13} />
            <span>Другие</span>
          </button>
        )}
      </div>
      {folderOpen && <div className="wb-browser-folder-menu" aria-label={`Закладки: ${folderOpen}`}>
        {folderItems.map((item) => (
          <button type="button" key={`${item.source}:${item.url}`} title={item.url} onClick={() => { setFolderOpen(null); void bridge.act(tabKey, "navigate", item.url); }}>
            <Favicon url={item.url} />
            <span>{item.title}</span>
          </button>
        ))}
      </div>}
      {historyOpen && (
        <div className="wb-browser-history" aria-label="История браузера">
          <div className="wb-browser-history-head">
            <input
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder="Поиск по истории"
              aria-label="Поиск по истории"
              autoFocus
            />
            <button type="button" onClick={() => { void bridge.clearHistory?.().then(() => setHistoryRows([])); }} title="Очистить историю">
              <Trash2 size={13} /> Очистить
            </button>
          </div>
          <ul>
            {historyRows.map((row) => (
              <li key={row.url}>
                <button type="button" title={row.url} onClick={() => { setHistoryOpen(false); void bridge.act(tabKey, "navigate", row.url); }}>
                  <span className="wb-browser-history-title">{row.title || row.url}</span>
                  <span className="wb-browser-history-url">{row.url}</span>
                </button>
              </li>
            ))}
            {!historyRows.length && <li className="wb-empty">{historyQuery ? "Ничего не нашлось" : "История пока пуста"}</li>}
          </ul>
        </div>
      )}
      {toolsOpen && <div className="wb-browser-tools">
        <div className="wb-browser-tools-row">
          <label htmlFor={`browser-profile-${tabKey}`}>Профиль Chrome</label>
          <select id={`browser-profile-${tabKey}`} value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy || !profiles.length}>
            {profiles.length ? profiles.map((item) => <option key={item} value={item}>{item}</option>) : <option value="Default">Профили не найдены</option>}
          </select>
          <button type="button" disabled={busy || !profiles.length} onClick={() => void importBookmarks()}>Импортировать закладки</button>
        </div>
        <div className="wb-browser-tools-row">
          <span>Пароли Chrome</span>
          <button type="button" disabled={busy} onClick={() => void importPasswords()}>Выбрать CSV для импорта</button>
          <small>Сначала экспортируйте пароли в Chrome. Они сохранятся только на этом компьютере.</small>
        </div>
        {credentials.length > 0 && <div className="wb-browser-tools-row">
          <span>Для этого сайта</span>
          {credentials.map((item) => <button type="button" key={item.username} onClick={() => { void bridge.fillPassword(tabKey, item.username).then((result) => { setMessage(result.error || "Поля входа заполнены"); setToolsOpen(false); }); }}>{`Заполнить: ${item.username}`}</button>)}
        </div>}
        {message && <div className="wb-browser-tools-message" role="status">{message}</div>}
      </div>}
      {state?.error && <div className="wb-banner is-error">{state.error}</div>}
      {/* Пустое место под страницу: её рисует поверх главный процесс по этим координатам. */}
      <div ref={stageRef} className="wb-browser-stage" data-scroll-memory="off">
        {frozen && <img className="wb-browser-frozen" src={frozen} alt="" draggable={false} />}
      </div>
    </div>
  );
}
