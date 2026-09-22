// Встроенный браузер MBOX.
//
// Страница интерфейса не может показать чужой сайт сама: почти все сайты запрещают себя во фрейме
// (X-Frame-Options, CSP frame-ancestors), а webview в Electron объявлен устаревшим. Поэтому каждая
// вкладка браузера — это WebContentsView, живущий в главном процессе поверх окна: интерфейс MBOX
// рисует панель адреса и пустое место под страницу, а сюда присылает прямоугольник, куда эту страницу
// положить. Всё, что видит интерфейс, — адрес, заголовок и состояние кнопок; доступа к содержимому
// чужого сайта у страницы MBOX нет.
//
// Вход в сайты сохраняется между запусками: общий раздел сессии persist:mbox-browser. Он намеренно
// отдельный от сессии самого MBOX — у сайтов не должно быть ни куки MBOX, ни моста к диску и агентам.

const { WebContentsView, session } = require("electron");
const chromeImport = require("./import-chrome");

const PARTITION = "persist:mbox-browser";
const HOME = "about:blank";

const tabs = new Map();
let window = null;
let emit = () => {};

/** Только настоящие веб-адреса. Всё остальное (mailto:, tel:, file:) — во внешнее приложение. */
function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) return HOME;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^about:blank$/i.test(value)) return HOME;
  // Похоже на адрес (есть точка и нет пробелов) — считаем сайтом, иначе ищем.
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(value)) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function stateOf(key) {
  const tab = tabs.get(key);
  if (!tab) return null;
  const contents = tab.view.webContents;
  return {
    key,
    url: contents.getURL() || tab.pending || "",
    title: contents.getTitle() || "",
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    error: tab.error || "",
  };
}

function publish(key) {
  const state = stateOf(key);
  if (state) emit({ type: "state", ...state });
}

function create(key) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const tab = { view, bounds: null, visible: false, error: "", pending: "" };
  tabs.set(key, tab);

  const contents = view.webContents;
  for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
    contents.on(event, () => publish(key));
  }
  contents.on("did-start-loading", () => { tab.error = ""; });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 = ERR_ABORTED: пользователь сам ушёл со страницы, это не ошибка.
    if (!isMainFrame || code === -3) return;
    tab.error = `${description || "не удалось открыть"} (${code}) · ${url}`;
    publish(key);
  });

  // Новое окно сайта — новая вкладка MBOX, а не отдельное окно Chromium мимо интерфейса.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) emit({ type: "open", url });
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url) || /^about:blank$/i.test(url)) return;
    event.preventDefault();
  });

  window.contentView.addChildView(view);
  view.setVisible(false);
  return tab;
}

/** Прямоугольник приходит из интерфейса в его же пикселях — переводим по текущему масштабу окна. */
function applyBounds(tab) {
  if (!tab.bounds || !window) return;
  const zoom = window.webContents.getZoomFactor() || 1;
  const scale = (value) => Math.round(value * zoom);
  tab.view.setBounds({ x: scale(tab.bounds.x), y: scale(tab.bounds.y), width: Math.max(0, scale(tab.bounds.width)), height: Math.max(0, scale(tab.bounds.height)) });
}

function open(key, url) {
  const tab = tabs.get(key) || create(key);
  const next = normalizeUrl(url);
  if (next !== HOME && tab.view.webContents.getURL() !== next) {
    tab.pending = next;
    void tab.view.webContents.loadURL(next);
  }
  publish(key);
  return stateOf(key);
}

function setBounds(key, bounds) {
  const tab = tabs.get(key);
  if (!tab) return;
  tab.bounds = bounds;
  applyBounds(tab);
}

/** Показываем страницу только у активной вкладки: WebContentsView рисуется поверх интерфейса и
 *  иначе перекрыл бы собой заметки, чат и всё остальное. */
function show(key) {
  for (const [current, tab] of tabs) {
    const visible = current === key;
    if (tab.visible === visible) continue;
    tab.visible = visible;
    tab.view.setVisible(visible);
    if (visible) applyBounds(tab);
  }
}

function hideAll() {
  show(null);
}

/** Скрыть одну вкладку, не трогая остальные: вкладку MBOX увели, а какая станет активной — решит она сама. */
function hide(key) {
  const tab = tabs.get(key);
  if (!tab || !tab.visible) return;
  tab.visible = false;
  tab.view.setVisible(false);
}

function close(key) {
  const tab = tabs.get(key);
  if (!tab) return;
  tabs.delete(key);
  try {
    window?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  } catch {
    // окно уже закрыто
  }
}

function act(key, command, payload) {
  const tab = tabs.get(key);
  if (!tab) return null;
  const contents = tab.view.webContents;
  if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  if (command === "reload") contents.reload();
  if (command === "stop") contents.stop();
  if (command === "navigate") return open(key, payload);
  return stateOf(key);
}

async function fillPassword(key, username) {
  const tab = tabs.get(key);
  if (!tab) return { ok: false, error: "Вкладка закрыта" };
  const contents = tab.view.webContents;
  const pageUrl = contents.getURL();
  const entries = chromeImport.credentialsFor(pageUrl);
  const entry = entries.find((item) => item.username === username);
  if (!entry) return { ok: false, error: "Для этого сайта пароль не найден" };
  const script = `(() => {
    if (location.origin !== ${JSON.stringify(new URL(pageUrl).origin)}) return false;
    const password = document.querySelector('input[type="password"]');
    if (!password) return false;
    const username = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i]');
    const set = (element, value) => {
      if (!element) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(username, ${JSON.stringify(entry.username)});
    set(password, ${JSON.stringify(entry.password)});
    return true;
  })()`;
  const filled = await contents.executeJavaScript(script, true);
  return filled ? { ok: true } : { ok: false, error: "На странице нет поля пароля" };
}

/**
 * Подключает браузер к окну MBOX. Вызывается один раз при создании окна: виды живут внутри окна и
 * пересоздаются вместе с ним.
 */
function attach(mainWindow, sendToUi) {
  window = mainWindow;
  emit = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) sendToUi(payload);
  };

  const browserSession = session.fromPartition(PARTITION);
  // Сайты не получают разрешения, файловые загрузки и доступ к мосту MBOX.
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event) => event.preventDefault());

  // Масштаб интерфейса меняется — прямоугольник в пикселях окна становится другим.
  mainWindow.webContents.on("zoom-changed", () => { for (const tab of tabs.values()) applyBounds(tab); });
  mainWindow.on("closed", () => { tabs.clear(); window = null; });
}

module.exports = { attach, open, setBounds, show, hide, hideAll, close, act, fillPassword, state: stateOf, PARTITION };
