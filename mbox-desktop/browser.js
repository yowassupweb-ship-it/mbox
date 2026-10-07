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

const fs = require("node:fs");
const path = require("node:path");
const { WebContentsView, session, Menu, clipboard, shell, dialog, app } = require("electron");
const chromeImport = require("./import-chrome");
const serverState = require("./server-state");
const downloads = require("./browser-downloads");
const contextMenu = require("./browser-menu");

const PARTITION = "persist:mbox-browser";
const HOME = "about:blank";

const tabs = new Map();
const visibleKeys = new Set();
// IPC от React приходит асинхронно. При открытии новой вкладки setBounds/show могут
// успеть раньше create(), поэтому держим первый прямоугольник до создания WebContentsView.
// Без этого браузерная шапка уже показывает адрес, а сама страница остаётся невидимой.
const pendingBounds = new Map();
// Запросы HTTP-авторизации (Basic/Digest, прокси): id → callback Chromium. Пока ответа нет, страница
// вкладки спрятана — она рисуется поверх окна и закрыла бы форму входа, которую показывает интерфейс.
const pendingAuth = new Map();
let authSeq = 0;
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
  return (SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.duckduckgo)(encodeURIComponent(value));
}

// Поисковик для строки адреса выбирается в настройках браузера на странице (setSearchEngine).
const SEARCH_ENGINES = {
  yandex: (q) => `https://yandex.ru/search/?text=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
  bing: (q) => `https://www.bing.com/search?q=${q}`,
};
let searchEngine = "duckduckgo";
function setSearchEngine(id) {
  if (SEARCH_ENGINES[id]) searchEngine = id;
  return searchEngine;
}

/** Очистка кэша встроенного браузера. Куки и вход на сайты не трогаем — они синхронизируются с MBOX. */
async function clearCache() {
  const browserSession = session.fromPartition(PARTITION);
  await browserSession.clearCache();
  await browserSession.clearStorageData({ storages: ["cachestorage", "serviceworkers", "shadercache"] });
  await browserSession.clearHostResolverCache().catch(() => {});
  return { ok: true };
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
    zoom: Math.round((contents.getZoomFactor() || 1) * 100),
    favicon: currentFavicon(tab),
    find: tab.find || null,
    auth: tab.auth ? { id: tab.auth.id, host: tab.auth.host, realm: tab.auth.realm, isProxy: tab.auth.isProxy, failed: tab.auth.failed } : null,
  };
}

/**
 * Иконка вкладки — только если она того же сайта, что открыт сейчас. Раньше при переходе на другой
 * сайт вкладка до прихода новой иконки (а она приходит лишь после разбора <head>) рассылала старую уже
 * с новым адресом: на вкладке висел значок прошлого сайта, а кэш записывал его новому.
 */
function currentFavicon(tab) {
  const origin = originOf(tab.view.webContents.getURL() || tab.pending);
  return tab.favicon && tab.faviconOrigin === origin ? tab.favicon : "";
}

function publish(key) {
  const state = stateOf(key);
  if (state) emit({ type: "state", ...state });
}

function create(key) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "browser-tab-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const tab = { view, bounds: pendingBounds.get(key) || null, visible: false, error: "", pending: "", favicon: "", faviconOrigin: "", auth: null, authTries: 0, find: null };
  pendingBounds.delete(key);
  tabs.set(key, tab);

  const contents = view.webContents;
  for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
    contents.on(event, () => publish(key));
  }
  contents.on("did-start-loading", () => { tab.error = ""; });

  contents.on("page-favicon-updated", (_event, favicons) => {
    tab.favicon = Array.isArray(favicons) ? favicons.find(Boolean) || "" : "";
    tab.faviconOrigin = originOf(contents.getURL());
    if (tab.favicon && tab.faviconOrigin) faviconCache.set(tab.faviconOrigin, tab.favicon);
    publish(key);
  });
  // Иконку нового сайта начинаем искать уже на старте перехода, параллельно с загрузкой страницы:
  // к коммиту она обычно в кэше и встаёт сразу, а не после разбора страницы.
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) void favicon(details.url).catch(() => "");
  });
  contents.on("did-navigate", (_event, url) => {
    const origin = originOf(url);
    if (!origin || tab.faviconOrigin === origin) return;
    const apply = (icon) => {
      if (!icon || tab.faviconOrigin === origin || originOf(contents.getURL()) !== origin) return;
      tab.favicon = icon;
      tab.faviconOrigin = origin;
      publish(key);
    };
    if (faviconCache.has(origin)) apply(faviconCache.get(origin));
    else void favicon(url).then(apply).catch(() => undefined);
  });
  // История пишется на сервер — она общая для всех машин (см. server-state.js). Заголовок к моменту
  // did-navigate ещё не пришёл, поэтому отмечаем переход и на смене заголовка: запись одна, по адресу.
  contents.on("did-navigate", (_event, url) => serverState.recordVisit(url, contents.getTitle()));
  contents.on("page-title-updated", (_event, title) => serverState.recordVisit(contents.getURL(), title));
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 = ERR_ABORTED: пользователь сам ушёл со страницы, это не ошибка.
    if (!isMainFrame || code === -3) return;
    tab.error = `${description || "не удалось открыть"} (${code}) · ${url}`;
    publish(key);
  });

  // Ctrl+колесо над страницей. Сам Chromium масштаб при этом не меняет (visual zoom выключен),
  // но сообщает направление — переводим его в шаг масштаба, как в обычном браузере.
  contents.on("zoom-changed", (_event, direction) => {
    const current = contents.getZoomFactor() || 1;
    const next = direction === "in" ? current * 1.1 : current / 1.1;
    contents.setZoomFactor(Math.min(3, Math.max(0.25, next)));
    publish(key);
  });

  // Новое окно сайта — новая вкладка MBOX, а не отдельное окно Chromium мимо интерфейса. from — какая
  // вкладка попросила: только она открывает новую (раньше открывали все браузеры сразу), и если она во
  // второй области, новая встаёт туда же.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) emit({ type: "open", url, from: key });
    return { action: "deny" };
  });

  // Сайт за Basic Auth (nginx «401 Authorization Required»): без обработчика Chromium молча отменял
  // вход и показывал 401 — ввести логин было негде. Спрашиваем интерфейс MBOX.
  contents.on("login", (event, details, authInfo, callback) => {
    event.preventDefault();
    const id = `${key}#${++authSeq}`;
    const failed = tab.authTries > 0 && tab.auth === null;
    tab.authTries += 1;
    for (const [pendingId, entry] of pendingAuth) {
      if (entry.key === key) { pendingAuth.delete(pendingId); try { entry.callback(); } catch { /* уже отменён */ } }
    }
    pendingAuth.set(id, { key, callback });
    tab.auth = { id, host: authInfo?.host || "", realm: authInfo?.realm || "", isProxy: Boolean(authInfo?.isProxy), failed, url: details?.url || "" };
    if (tab.visible) { tab.visible = false; view.setVisible(false); }
    publish(key);
  });
  contents.on("did-navigate", () => { if (!tab.auth) tab.authTries = 0; });
  contents.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url) || /^about:blank$/i.test(url)) return;
    event.preventDefault();
  });

  // Результат поиска по странице: номер текущего совпадения и сколько их всего.
  contents.on("found-in-page", (_event, result) => {
    if (!tab.find) return;
    tab.find = { ...tab.find, ordinal: result.activeMatchOrdinal || 0, matches: result.matches || 0 };
    publish(key);
  });
  contents.on("did-navigate", () => { if (tab.find) { tab.find = null; publish(key); } });

  contents.on("context-menu", (_event, params) => showContextMenu(key, params));
  contents.on("before-input-event", (event, input) => { if (handleShortcut(key, tab, input)) event.preventDefault(); });

  window.contentView.addChildView(view);
  view.setVisible(false);
  return tab;
}

function searchUrl(text) {
  return (SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.duckduckgo)(encodeURIComponent(text));
}

const ENGINE_LABEL = { yandex: "Яндексе", google: "Google", duckduckgo: "DuckDuckGo", bing: "Bing" };

/** Сообщение интерфейсу: «в этой вкладке просят …» (поиск по странице, закладка, фокус на адресе). */
function ask(key, action) {
  emit({ type: "shortcut", key, action });
}

/** Меню правой кнопки: нативное, поэтому рисуется поверх страницы, которую главный процесс кладёт над окном. */
function showContextMenu(key, params) {
  const tab = tabs.get(key);
  if (!tab || !window) return;
  const contents = tab.view.webContents;
  const pageUrl = contents.getURL();
  const act = {
    undo: () => contents.undo(),
    redo: () => contents.redo(),
    cut: () => contents.cut(),
    copy: () => contents.copy(),
    paste: () => contents.paste(),
    pasteText: () => contents.pasteAndMatchStyle(),
    selectAll: () => contents.selectAll(),
    copyText: (text) => clipboard.writeText(String(text || "")),
    copyImage: () => contents.copyImageAt(params.x, params.y),
    openTab: (url) => emit({ type: "open", url, from: key }),
    openExternal: (url) => { if (/^https?:/i.test(url)) void shell.openExternal(url); },
    search: (text) => emit({ type: "open", url: searchUrl(text), from: key }),
    download: (url, saveAs) => { if (saveAs) downloads.expectSaveAs(url); contents.downloadURL(url); },
    back: () => contents.navigationHistory.canGoBack() && contents.navigationHistory.goBack(),
    forward: () => contents.navigationHistory.canGoForward() && contents.navigationHistory.goForward(),
    reload: () => contents.reload(),
    find: () => ask(key, "find"),
    bookmark: () => ask(key, "bookmark"),
    savePage: () => void savePage(key),
    savePdf: () => void savePdf(key),
    print: () => printPage(key),
    inspect: () => contents.inspectElement(params.x, params.y),
  };
  const template = contextMenu.buildTemplate(params, {
    pageUrl,
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    engine: ENGINE_LABEL[searchEngine] || "поиске",
    devTools: !app.isPackaged,
  }, act);
  if (template.length) Menu.buildFromTemplate(template).popup({ window });
}

/** Сочетания клавиш, как в обычном браузере. Без этого страница поверх окна съедала их все, а Ctrl+R
 *  обновлял не сайт, а сам MBOX (пункт меню приложения). true — клавишу обработали, странице не отдаём. */
function handleShortcut(key, tab, input) {
  if (input.type !== "keyDown") return false;
  const contents = tab.view.webContents;
  const mod = input.control || input.meta;
  const k = String(input.key || "").toLowerCase();
  if (mod && !input.alt) {
    if (k === "l" && !input.shift) { ask(key, "address"); return true; }
    if (k === "f" && !input.shift) { ask(key, "find"); return true; }
    if (k === "d" && !input.shift) { ask(key, "bookmark"); return true; }
    if (k === "r") { if (input.shift) contents.reloadIgnoringCache(); else contents.reload(); return true; }
    if (k === "p" && !input.shift) { printPage(key); return true; }
    if (k === "s" && !input.shift) { void savePage(key); return true; }
    if (k === "=" || k === "+") { act(key, "zoom-in"); return true; }
    if (k === "-" || k === "_") { act(key, "zoom-out"); return true; }
    if (k === "0") { act(key, "zoom-reset"); return true; }
    return false;
  }
  if (k === "f5") { if (input.shift || input.control) contents.reloadIgnoringCache(); else contents.reload(); return true; }
  if (input.alt && k === "arrowleft") { act(key, "back"); return true; }
  if (input.alt && k === "arrowright") { act(key, "forward"); return true; }
  if (k === "escape" && tab.find) { act(key, "find-stop"); ask(key, "find-close"); return true; }
  return false;
}

function pageFileName(contents, ext) {
  const base = downloads.safeFileName(contents.getTitle() || new URL(contents.getURL() || "about:blank").hostname || "page");
  return `${base}.${ext}`;
}

async function savePage(key) {
  const tab = tabs.get(key);
  if (!tab || !window) return { ok: false };
  const contents = tab.view.webContents;
  const picked = await dialog.showSaveDialog(window, {
    title: "Сохранить страницу",
    defaultPath: path.join(app.getPath("downloads"), pageFileName(contents, "html")),
    filters: [{ name: "Веб-страница, полностью", extensions: ["html"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  await contents.savePage(picked.filePath, "HTMLComplete");
  downloads.addSaved(picked.filePath);
  return { ok: true };
}

async function savePdf(key) {
  const tab = tabs.get(key);
  if (!tab || !window) return { ok: false };
  const contents = tab.view.webContents;
  const picked = await dialog.showSaveDialog(window, {
    title: "Сохранить как PDF",
    defaultPath: path.join(app.getPath("downloads"), pageFileName(contents, "pdf")),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  const data = await contents.printToPDF({ printBackground: true });
  await fs.promises.writeFile(picked.filePath, data);
  downloads.addSaved(picked.filePath);
  return { ok: true };
}

function printPage(key) {
  const tab = tabs.get(key);
  if (tab) tab.view.webContents.print({ printBackground: true });
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
  // show() мог быть вызван из рендера на один IPC раньше open(). В таком случае
  // вкладка уже числится видимой, но созданный view ещё не получил это состояние.
  if (visibleKeys.has(key) && !tab.auth && !tab.visible) {
    tab.visible = true;
    tab.view.setVisible(true);
    applyBounds(tab);
  }
  publish(key);
  return stateOf(key);
}

function setBounds(key, bounds) {
  const tab = tabs.get(key);
  if (!tab) {
    pendingBounds.set(key, bounds);
    return;
  }
  tab.bounds = bounds;
  applyBounds(tab);
}

/** Показываем страницы только у видимых вкладок. В split-режиме браузеров может быть два:
 *  активная вкладка и документ во второй области. */
function show(key) {
  if (key) { visibleKeys.add(key); lastShownKey = key; }
  else visibleKeys.clear();
  for (const [current, tab] of tabs) {
    const visible = visibleKeys.has(current) && !tab.auth;
    if (tab.visible === visible) continue;
    tab.visible = visible;
    tab.view.setVisible(visible);
    if (visible) applyBounds(tab);
  }
}

function hideAll() {
  show(null);
}

/**
 * Снимок видимой страницы в PNG (data:URL).
 *
 * Пока открыто меню или попап MBOX, страницу приходится прятать — она рисуется поверх всего окна.
 * Раньше на её месте зияла пустота; теперь интерфейс кладёт туда этот снимок, и подложка под меню
 * выглядит как была.
 */
async function capture(key) {
  const tab = tabs.get(key);
  if (!tab || !tab.visible) return "";
  try {
    const image = await tab.view.webContents.capturePage();
    return image.isEmpty() ? "" : image.toDataURL();
  } catch {
    return "";
  }
}

/** Скрыть одну вкладку, не трогая остальные: вкладку MBOX увели, а какая станет активной — решит она сама. */
function hide(key) {
  const tab = tabs.get(key);
  visibleKeys.delete(key);
  if (!tab || !tab.visible) return;
  tab.visible = false;
  tab.view.setVisible(false);
}

/** Ответ на запрос входа: имя и пароль — войти, null — отменить (Chromium покажет страницу 401). */
function answerAuth(id, username, password) {
  const entry = pendingAuth.get(id);
  if (!entry) return { ok: false, error: "Запрос входа уже закрыт" };
  pendingAuth.delete(id);
  const tab = tabs.get(entry.key);
  if (tab) tab.auth = null;
  try {
    if (typeof username === "string" && username) entry.callback(username, String(password || ""));
    else entry.callback();
  } catch {
    // вкладку закрыли, пока человек вводил пароль
  }
  if (tab && visibleKeys.has(entry.key) && !tab.visible) {
    tab.visible = true;
    tab.view.setVisible(true);
    applyBounds(tab);
  }
  publish(entry.key);
  return { ok: true };
}

/**
 * User-Agent обычного Chrome той же версии. По умолчанию в нём «Electron/…» и имя приложения, и Google
 * по ним отказывает во входе («Включите JavaScript в Chrome… поддерживаемый браузер»): встроенные
 * браузеры он не пускает. Версия — только major, как у самого Chrome с урезанным UA.
 */
function chromeUserAgent() {
  const major = String(process.versions.chrome || "130").split(".")[0];
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function chromeClientHints() {
  const major = String(process.versions.chrome || "130").split(".")[0];
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return {
    "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${platform}"`,
  };
}

function installChromeIdentity(browserSession) {
  const hints = chromeClientHints();
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const [key, value] of Object.entries(hints)) {
      const current = Object.keys(requestHeaders).find((name) => name.toLowerCase() === key);
      if (current) requestHeaders[current] = value;
      else requestHeaders[key] = value;
    }
    callback({ requestHeaders });
  });
}

function close(key) {
  const tab = tabs.get(key);
  pendingBounds.delete(key);
  if (!tab) return;
  for (const [pendingId, entry] of pendingAuth) {
    if (entry.key === key) { pendingAuth.delete(pendingId); try { entry.callback(); } catch { /* вкладка уже закрыта */ } }
  }
  tabs.delete(key);
  visibleKeys.delete(key);
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
  if (command === "zoom-reset") contents.setZoomFactor(1);
  if (command === "zoom-in") contents.setZoomFactor(Math.min(3, (contents.getZoomFactor() || 1) * 1.1));
  if (command === "zoom-out") contents.setZoomFactor(Math.max(0.25, (contents.getZoomFactor() || 1) / 1.1));
  if (command === "find") {
    const text = String(payload?.text ?? "");
    if (!text) { contents.stopFindInPage("clearSelection"); tab.find = null; }
    else {
      const fresh = !tab.find || tab.find.text !== text;
      tab.find = { text, ordinal: fresh ? 0 : tab.find.ordinal, matches: fresh ? -1 : tab.find.matches };
      contents.findInPage(text, { forward: payload?.forward !== false, findNext: !fresh, matchCase: Boolean(payload?.matchCase) });
    }
  }
  if (command === "find-stop") { contents.stopFindInPage("clearSelection"); tab.find = null; }
  if (command === "print") printPage(key);
  if (command === "save-page") void savePage(key);
  if (command === "save-pdf") void savePdf(key);
  if (command === "copy-url" && /^https?:/i.test(contents.getURL())) clipboard.writeText(contents.getURL());
  if (command === "open-external" && /^https?:/i.test(contents.getURL())) void shell.openExternal(contents.getURL());
  return stateOf(key);
}

/**
 * Иконка сайта для произвольного адреса — нужна панели закладок и выпадающим папкам, где вкладки
 * может не быть вовсе. Раньше искали только среди открытых вкладок, поэтому у закладок иконок не
 * было никогда: сайт, который ни разу не открывали, взять их неоткуда.
 *
 * Порядок: уже известная иконка открытой вкладки того же сайта (бесплатно и точно), иначе
 * /favicon.ico самого сайта через тот же раздел сессии, что и сам браузер. Запрос идёт к сайту
 * напрямую, без посредников вроде сервиса иконок Google — у MBOX нет причин рассказывать третьей
 * стороне, какие сайты лежат в закладках.
 *
 * Результат кешируется по origin, включая отрицательный: иначе панель закладок долбила бы десятки
 * сайтов на каждую перерисовку.
 */
const faviconCache = new Map();
const MAX_FAVICON_BYTES = 256 * 1024;

function originOf(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

async function favicon(url) {
  const origin = originOf(url);
  if (!origin) return "";
  if (faviconCache.has(origin)) return faviconCache.get(origin);

  for (const tab of tabs.values()) {
    const icon = currentFavicon(tab);
    if (icon && tab.faviconOrigin === origin) {
      faviconCache.set(origin, icon);
      return icon;
    }
  }

  let result = "";
  try {
    const response = await session.fromPartition(PARTITION).fetch(`${origin}/favicon.ico`);
    const type = response.headers.get("content-type") || "";
    if (response.ok && /^image\//i.test(type)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length && buffer.length <= MAX_FAVICON_BYTES) {
        result = `data:${type.split(";")[0]};base64,${buffer.toString("base64")}`;
      }
    }
  } catch {
    // сайт недоступен или не отдаёт иконку — запомним пустой результат, чтобы не ходить повторно
  }
  faviconCache.set(origin, result);
  return result;
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

// ─── Агент во вкладке браузера ──────────────────────────────────────────────────────────────
//
// Агент (MCP browser_* → сервер → страница MBOX → сюда) видит страницу, открытую у человека, и действует
// на ней на глазах: каждое поле, которое он заполняет, и каждая кнопка, которую нажимает, подсвечиваются
// рамкой с подписью «Claude: …». Страницу агент читает как список полей и кнопок с короткими метками
// (f1, b7) — по ним он потом и действует, без хрупких CSS-селекторов. Значения паролей наружу не уходят.

let lastShownKey = "";

const AGENT_KIT = require("./agent-kit");

function agentTab(key) {
  const wanted = key && tabs.get(key) ? key : [...visibleKeys].find((item) => tabs.has(item)) || (tabs.has(lastShownKey) ? lastShownKey : "");
  return wanted ? { key: wanted, tab: tabs.get(wanted) } : null;
}

async function inPage(contents, call) {
  await contents.executeJavaScript(AGENT_KIT, true);
  return contents.executeJavaScript(`(async () => window.__mboxAgent.${call})()`, true);
}

// ─── Управление агентом человеком: пауза, продолжить, стоп ───────────────────────────────────────────────────────────
// Пока вкладка на паузе, действия агента, меняющие страницу, ждут (до 20 с) и затем возвращают paused_by_human; «Стоп» отвечает
// stopped_by_human, пока человек сам не снимет остановку. Чтение (снимок, вкладки) работает всегда.
const agentControl = new Map();
const controlOf = (key) => { if (!agentControl.has(key)) agentControl.set(key, { paused: false, stopped: false }); return agentControl.get(key); };
const READ_ONLY_ACTIONS = new Set(["tabs", "snapshot", "screenshot", "find_text", "extract", "blockers", "status"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setAgentControl(key, command) {
  const state = controlOf(key);
  if (command === "pause") state.paused = true;
  else if (command === "resume") { state.paused = false; state.stopped = false; }
  else if (command === "stop") { state.stopped = true; state.paused = false; }
  else if (command === "clear") { state.paused = false; state.stopped = false; }
  emit?.({ type: "agent-state", key, paused: state.paused, stopped: state.stopped });
  return { ok: true, paused: state.paused, stopped: state.stopped };
}

async function gate(key) {
  const state = controlOf(key);
  if (state.stopped) return { ok: false, error: "stopped_by_human", message: "Человек остановил агента в этой вкладке. Не продолжай действия: напиши в чате, что остановлен, и спроси, что делать дальше." };
  if (state.paused) {
    const until = Date.now() + 20_000;
    while (controlOf(key).paused && !controlOf(key).stopped && Date.now() < until) await sleep(250);
    if (controlOf(key).stopped) return { ok: false, error: "stopped_by_human", message: "Человек остановил агента в этой вкладке." };
    if (controlOf(key).paused) return { ok: false, error: "paused_by_human", message: "Человек поставил агента на паузу. Подожди и повтори действие через несколько секунд; если пауза затянулась — спроси в чате." };
  }
  return null;
}

// ─── Настоящий ввод: события мыши и клавиатуры, неотличимые от человеческих (синтетический el.click() многие сайты игнорируют) ───

const KEY_NAMES = { arrowdown: "Down", arrowup: "Up", arrowleft: "Left", arrowright: "Right", esc: "Escape", return: "Enter", del: "Delete", pgup: "PageUp", pgdn: "PageDown", pageup: "PageUp", pagedown: "PageDown", space: "Space", spacebar: "Space", ctrl: "Control", cmd: "Meta", option: "Alt" };
const MODIFIERS = new Set(["control", "shift", "alt", "meta"]);

function parseKey(spec) {
  const parts = String(spec || "").split("+").map((item) => item.trim()).filter(Boolean);
  const modifiers = [];
  let key = "";
  for (const part of parts) {
    const lower = (KEY_NAMES[part.toLowerCase()] || part).toLowerCase();
    if (MODIFIERS.has(lower) && parts.length > 1 && part !== parts[parts.length - 1]) modifiers.push(lower);
    else key = KEY_NAMES[part.toLowerCase()] || (part.length === 1 ? part : part[0].toUpperCase() + part.slice(1));
  }
  return { modifiers, key };
}

async function pressKey(contents, spec) {
  const { modifiers, key } = parseKey(spec);
  if (!key) return false;
  contents.focus();
  contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
  if (key.length === 1 && !modifiers.some((item) => item === "control" || item === "meta" || item === "alt")) contents.sendInputEvent({ type: "char", keyCode: key, modifiers });
  await sleep(25);
  contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  return true;
}

function mouse(contents, type, x, y, extra = {}) {
  const zoom = contents.getZoomFactor?.() || 1;
  contents.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), ...extra });
}

async function pointOf(contents, args, who, key) {
  if (args.ref) {
    const spot = await inPage(contents, `locate(${JSON.stringify(String(args.ref))})`);
    if (!spot?.ok) return spot;
    if (spot.disabled) return { ok: false, error: "disabled", message: `Элемент недоступен (${spot.label}).` };
    if (spot.covered && !args.force) return { ok: false, error: "covered", message: `Элемент перекрыт: ${spot.coveredBy}. Закройте баннер или окно поверх него (или добавьте force=true).`, label: spot.label };
    return spot;
  }
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    const info = await inPage(contents, `pointInfo(${Number(args.x)}, ${Number(args.y)})`);
    return { ok: true, x: Number(args.x), y: Number(args.y), label: info?.label || "точка", ref: info?.ref };
  }
  return { ok: false, error: "target_required", message: "Нужен ref из browser_snapshot либо координаты x и y." };
}

async function pointerAction(contents, args, who, kind) {
  const spot = await pointOf(contents, args, who);
  if (!spot.ok) return spot;
  await inPage(contents, `cursor(${spot.x}, ${spot.y}, ${who}, ${kind !== "hover"})`);
  contents.focus?.();
  if (kind === "hover") { mouse(contents, "mouseMove", spot.x, spot.y); await sleep(200); return { ok: true, hovered: spot.label }; }
  const button = kind === "right_click" ? "right" : "left";
  mouse(contents, "mouseMove", spot.x, spot.y);
  await sleep(40);
  mouse(contents, "mouseDown", spot.x, spot.y, { button, clickCount: 1 });
  mouse(contents, "mouseUp", spot.x, spot.y, { button, clickCount: 1 });
  if (kind === "double_click") {
    await sleep(60);
    mouse(contents, "mouseDown", spot.x, spot.y, { button, clickCount: 2 });
    mouse(contents, "mouseUp", spot.x, spot.y, { button, clickCount: 2 });
  }
  await sleep(350);
  return { ok: true, clicked: spot.label, url: contents.getURL() };
}

async function waitFor(contents, args) {
  const limit = Math.min(Math.max(Number(args.ms) || 10_000, 500), 20_000);
  const spec = { text: args.text, gone_text: args.gone_text, ref: args.ref, gone: Boolean(args.gone), selector: args.selector };
  const started = Date.now();
  while (Date.now() - started < limit) {
    const urlOk = !args.url_contains || contents.getURL().includes(String(args.url_contains));
    const loadOk = !args.load || !contents.isLoading();
    let pageOk = true;
    if (spec.text || spec.gone_text || spec.ref || spec.selector) {
      try { pageOk = Boolean(await inPage(contents, `checkWait(${JSON.stringify(spec)})`)); } catch { pageOk = false; }
    }
    if (urlOk && loadOk && pageOk) return { ok: true, waited_ms: Date.now() - started, url: contents.getURL() };
    await sleep(250);
  }
  return { ok: false, error: "timeout", message: `Не дождался за ${Math.round(limit / 1000)} с. Сделайте browser_snapshot и посмотрите, что на странице; если застряли — browser_ask_help.`, url: contents.getURL() };
}

/** Действие агента во вкладке. key пустой — вкладка, которую человек видит сейчас. */
async function agentAction(key, action, args = {}, actor = "Агент", note = "") {
  if (action === "tabs") {
    return { ok: true, active: agentTab("")?.key || "", tabs: [...tabs.keys()].map((item) => ({ ...stateOf(item), visible: tabs.get(item).visible, agent: { ...controlOf(item) } })) };
  }
  // Без вкладки браузера navigate тоже вернёт no_tab: новую вкладку открывает страница MBOX (browserAgent.ts).
  const target = agentTab(key);
  if (!target) return { ok: false, error: "no_tab", message: "В MBOX не открыта ни одна вкладка браузера. Откройте страницу (browser_navigate) или попросите человека." };
  const contents = target.tab.view.webContents;
  const who = JSON.stringify(String(actor || "Агент").slice(0, 40));
  const say = JSON.stringify(String(note || "").slice(0, 160));
  if (action === "status") return { ok: true, key: target.key, url: contents.getURL(), loading: contents.isLoading(), agent: { ...controlOf(target.key) } };
  if (!READ_ONLY_ACTIONS.has(action)) {
    const blocked = await gate(target.key);
    if (blocked) return { key: target.key, ...blocked };
  }
  emit({ type: "agent", key: target.key, actor: String(actor || "Агент"), action, note: String(note || "") });
  try {
    if (action === "navigate") {
      open(target.key, args.url);
      return { ok: true, key: target.key, url: normalizeUrl(args.url) };
    }
    if (action === "back" || action === "forward" || action === "reload") {
      const history = contents.navigationHistory;
      if (action === "reload") contents.reload();
      else if (action === "back") { if (history ? history.canGoBack() : contents.canGoBack()) (history || contents).goBack(); else return { ok: false, error: "no_history" }; }
      else if (history ? history.canGoForward() : contents.canGoForward()) (history || contents).goForward(); else return { ok: false, error: "no_history" };
      return { ok: true, key: target.key };
    }
    if (action === "new_tab") {
      if (!/^https?:\/\//i.test(String(args.url || ""))) return { ok: false, error: "bad_url" };
      emit({ type: "open", url: String(args.url), from: target.key });
      return { ok: true, hint: "Новая вкладка откроется в MBOX; через пару секунд browser_tabs покажет её ключ." };
    }
    if (action === "snapshot") {
      if (contents.isLoading()) await new Promise((resolve) => { contents.once("did-stop-loading", resolve); setTimeout(resolve, 8000); });
      return { ok: true, key: target.key, ...(await inPage(contents, `snapshot(${Number(args.max_text) || 6000})`)) };
    }
    if (action === "blockers") return { ok: true, key: target.key, blockers: await inPage(contents, "blockers()") };
    if (action === "extract") return { key: target.key, ...(await inPage(contents, `extract(${JSON.stringify(String(args.kind || "text"))}, ${JSON.stringify(String(args.ref || ""))}, ${Number(args.max) || 100})`)) };
    if (action === "find_text") return { key: target.key, ...(await inPage(contents, `findText(${JSON.stringify(String(args.query || ""))}, ${Number(args.max) || 15})`)) };
    if (action === "fill") {
      const items = (Array.isArray(args.fields) ? args.fields : []).slice(0, 80).map((item) => ({ ref: item?.ref ? String(item.ref) : "", label: item?.label ? String(item.label) : "", value: item?.value ?? "" }));
      if (!items.length) return { ok: false, error: "fields_required" };
      return { ok: true, key: target.key, results: await inPage(contents, `fill(${JSON.stringify(items)}, ${who}, ${say})`) };
    }
    if (action === "click" || action === "double_click" || action === "right_click" || action === "hover") {
      // Настоящий клик по умолчанию; trusted=false — старый способ (el.click() внутри страницы) для сайтов, где мышь не нужна.
      if (action === "click" && args.trusted === false && args.ref) return { key: target.key, ...(await inPage(contents, `click(${JSON.stringify(String(args.ref))}, ${who}, ${say})`)) };
      return { key: target.key, ...(await pointerAction(contents, args, who, action)) };
    }
    if (action === "move_cursor") {
      const spot = await pointOf(contents, args, who);
      if (!spot.ok) return spot;
      await inPage(contents, `cursor(${spot.x}, ${spot.y}, ${who}, false)`);
      mouse(contents, "mouseMove", spot.x, spot.y);
      return { ok: true, key: target.key, at: { x: spot.x, y: spot.y }, over: spot.label };
    }
    if (action === "drag") {
      const from = await pointOf(contents, args.from || {}, who);
      if (!from.ok) return from;
      const to = await pointOf(contents, args.to || {}, who);
      if (!to.ok) return to;
      await inPage(contents, `cursor(${from.x}, ${from.y}, ${who}, true)`);
      contents.focus?.();
      mouse(contents, "mouseMove", from.x, from.y);
      mouse(contents, "mouseDown", from.x, from.y, { button: "left", clickCount: 1 });
      const steps = 14;
      for (let step = 1; step <= steps; step += 1) {
        const x = from.x + ((to.x - from.x) * step) / steps;
        const y = from.y + ((to.y - from.y) * step) / steps;
        mouse(contents, "mouseMove", x, y, { button: "left" });
        if (step === 1 || step === steps) await inPage(contents, `cursor(${x}, ${y}, ${who}, false)`);
        await sleep(25);
      }
      mouse(contents, "mouseUp", to.x, to.y, { button: "left", clickCount: 1 });
      return { ok: true, key: target.key, from: from.label, to: to.label };
    }
    if (action === "type") {
      const text = String(args.text ?? "");
      if (args.ref || Number.isFinite(Number(args.x))) {
        const clicked = await pointerAction(contents, args, who, "click");
        if (!clicked.ok) return clicked;
        if (args.clear !== false) { await pressKey(contents, process.platform === "darwin" ? "Meta+A" : "Control+A"); await sleep(40); }
      }
      contents.focus?.();
      // Пароли, номера карт и коды подтверждения агент не печатает: это делает человек (browser_ask_help).
      const sensitive = await contents.executeJavaScript(`(() => { const el = document.activeElement; if (!el) return ""; const ac = String(el.getAttribute("autocomplete") || "").toLowerCase(); return el.type === "password" ? "пароль" : /cc-|one-time-code/.test(ac) ? "платёжные данные или код подтверждения" : ""; })()`, true).catch(() => "");
      if (sensitive) return { ok: false, error: "sensitive_field", message: `Это поле для чувствительных данных (${sensitive}). Их вводит человек: вызови browser_ask_help.` };
      if (args.slow) {
        for (const char of [...text].slice(0, 400)) { contents.insertText(char); await sleep(25 + Math.random() * 45); }
      } else contents.insertText(text);
      if (args.submit) { await sleep(120); await pressKey(contents, "Enter"); }
      await sleep(150);
      return { ok: true, key: target.key, typed: text.length };
    }
    if (action === "press") {
      const list = (Array.isArray(args.keys) ? args.keys : [args.key || args.keys]).filter(Boolean).slice(0, 20);
      for (const spec of list) { if (!(await pressKey(contents, spec))) return { ok: false, error: "bad_key", key: spec }; await sleep(70); }
      return { ok: true, key: target.key, pressed: list };
    }
    if (action === "wait") return { key: target.key, ...(await waitFor(contents, args)) };
    if (action === "highlight") {
      if (args.clear) return { key: target.key, ...(await inPage(contents, "clear()")) };
      const refs = (Array.isArray(args.refs) ? args.refs : [args.ref]).filter(Boolean).map(String).slice(0, 40);
      return { key: target.key, ...(await inPage(contents, `highlight(${JSON.stringify(refs)}, ${who}, ${say}, ${Number(args.ms ?? 8000)})`)) };
    }
    if (action === "scroll") {
      if (Number.isFinite(Number(args.amount)) && !args.ref) {
        const size = contents.getSize ? contents.getSize() : { width: 800, height: 600 };
        mouse(contents, "mouseWheel", size.width / 2, size.height / 2, { deltaY: -Number(args.amount), canScroll: true });
        await sleep(250);
        return { key: target.key, ok: true, ...(await inPage(contents, "state()")) };
      }
      return { key: target.key, ...(await inPage(contents, `scroll(${JSON.stringify(String(args.ref || ""))}, ${JSON.stringify(String(args.to || "down"))})`)) };
    }
    if (action === "screenshot") {
      if (!target.tab.visible) return { ok: false, error: "tab_hidden", message: "Вкладка сейчас не на экране — снимок был бы пустым." };
      const image = await contents.capturePage();
      const size = image.getSize();
      const scaled = size.width > 1280 ? image.resize({ width: 1280 }) : image;
      return { ok: true, key: target.key, url: contents.getURL(), image: `data:image/jpeg;base64,${scaled.toJPEG(72).toString("base64")}` };
    }
    return { ok: false, error: `unknown_action:${action}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
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
  browserSession.setUserAgent(chromeUserAgent());
  installChromeIdentity(browserSession);

  // Сайты не получают разрешений (камера, геолокация, уведомления) и доступа к мосту MBOX. Исключение —
  // запись текста в буфер обмена: без неё не работают кнопки «Копировать» на сайтах. Чтение буфера закрыто.
  const allowed = (permission) => permission === "clipboard-sanitized-write";
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
  browserSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));
  downloads.attach(browserSession, emit);

  // Масштаб интерфейса меняется — прямоугольник в пикселях окна становится другим.
  mainWindow.webContents.on("zoom-changed", () => { for (const tab of tabs.values()) applyBounds(tab); });
  mainWindow.on("closed", () => { tabs.clear(); window = null; });
}

module.exports = { attach, downloads, setAgentControl, open, setBounds, show, hide, hideAll, close, act, capture, favicon, fillPassword, answerAuth, agentAction, setSearchEngine, clearCache, state: stateOf, PARTITION };
