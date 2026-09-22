import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Bookmark, Download, ExternalLink, Globe, RotateCw, Star, X } from "lucide-react";
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
};

type BrowserBridge = {
  open: (key: string, url: string) => Promise<BrowserState | null>;
  setBounds: (key: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<unknown>;
  show: (key: string | null) => Promise<unknown>;
  hide: (key: string) => Promise<unknown>;
  close: (key: string) => Promise<unknown>;
  act: (key: string, command: string, payload?: string) => Promise<BrowserState | null>;
  bookmarks: () => Promise<BrowserBookmark[]>;
  addBookmark: (bookmark: { title: string; url: string }) => Promise<BrowserBookmark[]>;
  removeBookmark: (url: string) => Promise<BrowserBookmark[]>;
  chromeProfiles: () => Promise<string[]>;
  importBookmarks: (profile: string) => Promise<{ bookmarks?: { count?: number; error?: string } }>;
  importPasswords: () => Promise<{ ok?: boolean; count?: number; error?: string; canceled?: boolean }>;
  credentials: (url: string) => Promise<{ username: string }[]>;
  fillPassword: (key: string, username: string) => Promise<{ ok: boolean; error?: string }>;
  onEvent: (handler: (payload: { type: string; url?: string } & Partial<BrowserState>) => void) => () => void;
};

type BrowserBookmark = { title: string; url: string; folder?: string; source?: string };

export function browserBridge(): BrowserBridge | undefined {
  return (window as unknown as { mboxDesktop?: { browser?: BrowserBridge } }).mboxDesktop?.browser;
}

/** Адрес вкладки: ключ вида «web:https://example.com». */
export const browserTabKey = (url: string) => `web:${url}`;
export const browserTabUrl = (key: string) => key.slice(4);

/**
 * Меню и диалоги MBOX рисуются поверх документа, а страница браузера лежит поверх всего окна и
 * закрыла бы их собой. Пока открыто меню, страница прячется: событие шлют WbMenu и askText.
 */
export const OVERLAY_EVENT = "mbox:overlay";
export function markOverlay(open: boolean) {
  window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: open }));
}

/**
 * Вкладку закрывают — страницу Chromium надо убрать. Но в режиме разработки React монтирует компонент
 * дважды, поэтому закрытие откладывается: если вкладка тут же вернулась, сайт не перезагружается.
 */
const pendingClose = new Map<string, number>();

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
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState("Default");
  const [credentials, setCredentials] = useState<{ username: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (bridge) void bridge.bookmarks().then(setBookmarks); }, [bridge]);
  useEffect(() => {
    if (!bridge || !toolsOpen) return;
    void bridge.chromeProfiles().then((items) => { setProfiles(items); if (items.length && !items.includes(profile)) setProfile(items[0]); });
    void bridge.credentials(state?.url || url).then(setCredentials);
  }, [bridge, toolsOpen, state?.url, url]);

  useEffect(() => {
    if (!bridge) return;
    const timer = pendingClose.get(tabKey);
    if (timer) { window.clearTimeout(timer); pendingClose.delete(tabKey); }
    void bridge.open(tabKey, url).then((next) => next && setState(next));
    return () => {
      pendingClose.set(tabKey, window.setTimeout(() => { pendingClose.delete(tabKey); void bridge.close(tabKey); }, 400));
    };
  }, [bridge, tabKey, url]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((payload) => {
      // Сайт попросил новое окно — открываем его вкладкой MBOX, а не отдельным окном мимо интерфейса.
      if (payload.type === "open" && payload.url) { tabs.open(browserTabKey(payload.url), true); return; }
      if (payload.type !== "state" || payload.key !== tabKey) return;
      setState(payload as BrowserState);
      // Заголовок вкладки MBOX — заголовок сайта: иначе во вкладке остаётся один домен.
      if (payload.title) onTitle(tabKey, payload.title);
      if (!editing && payload.url) setAddress(payload.url);
    });
  }, [bridge, tabKey, editing, tabs, onTitle]);

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

  useEffect(() => {
    if (!bridge || !visible) return;
    if (overlay || toolsOpen || folderOpen) { void bridge.hide(tabKey); return; }
    report();
    void bridge.show(tabKey);
    const timer = window.setInterval(report, 150);
    window.addEventListener("resize", report);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", report);
      void bridge.hide(tabKey);
    };
  }, [bridge, visible, overlay, toolsOpen, folderOpen, tabKey, report]);

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
    void bridge!.act(tabKey, "navigate", address).then((next) => next && setState(next));
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
          <Globe size={13} />
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
          <button type="button" onClick={() => { setFolderOpen(null); setToolsOpen((open) => !open); }} title="Импорт и пароли" aria-label="Импорт и пароли" aria-expanded={toolsOpen}><Download size={15} /></button>
          <button type="button" onClick={() => window.open(state?.url || url, "_blank", "noopener")} title="Открыть в системном браузере"><ExternalLink size={14} /></button>
        </div>
      </div>
      <div className="wb-browser-bookmarks" aria-label="Панель закладок">
        <Bookmark size={14} aria-hidden="true" />
        {bar.map((item) => <button type="button" key={item.url} title={item.url} onClick={() => void bridge.act(tabKey, "navigate", item.url)}>{item.title}</button>)}
        {!bar.length && !folders.length && !hasOther && <span>Добавьте страницу звёздочкой или импортируйте закладки Chrome</span>}
        {folders.map((name) => <button type="button" key={name} aria-expanded={folderOpen === name} onClick={() => { setToolsOpen(false); setFolderOpen(folderOpen === name ? null : name); }}>{name}</button>)}
        {hasOther && <button type="button" aria-expanded={folderOpen === "Другие"} onClick={() => { setToolsOpen(false); setFolderOpen(folderOpen === "Другие" ? null : "Другие"); }}>Другие</button>}
      </div>
      {folderOpen && <div className="wb-browser-folder-menu" aria-label={`Закладки: ${folderOpen}`}>
        {folderItems.map((item) => <button type="button" key={`${item.source}:${item.url}`} title={item.url} onClick={() => { setFolderOpen(null); void bridge.act(tabKey, "navigate", item.url); }}>{item.title}</button>)}
      </div>}
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
      <div ref={stageRef} className="wb-browser-stage" data-scroll-memory="off" />
    </div>
  );
}
