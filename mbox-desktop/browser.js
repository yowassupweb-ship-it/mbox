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
const serverState = require("./server-state");

const PARTITION = "persist:mbox-browser";
const HOME = "about:blank";

const tabs = new Map();
const visibleKeys = new Set();
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
    zoom: Math.round((contents.getZoomFactor() || 1) * 100),
    favicon: tab.favicon || "",
    auth: tab.auth ? { id: tab.auth.id, host: tab.auth.host, realm: tab.auth.realm, isProxy: tab.auth.isProxy, failed: tab.auth.failed } : null,
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
  const tab = { view, bounds: null, visible: false, error: "", pending: "", favicon: "", auth: null, authTries: 0 };
  tabs.set(key, tab);

  const contents = view.webContents;
  for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
    contents.on(event, () => publish(key));
  }
  contents.on("did-start-loading", () => { tab.error = ""; });
  contents.on("page-favicon-updated", (_event, favicons) => {
    tab.favicon = Array.isArray(favicons) ? favicons.find(Boolean) || "" : "";
    publish(key);
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

function close(key) {
  const tab = tabs.get(key);
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
    if (!tab.favicon) continue;
    if (originOf(tab.view.webContents.getURL()) === origin) {
      faviconCache.set(origin, tab.favicon);
      return tab.favicon;
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

/** Набор функций агента внутри страницы. Ставится один раз на документ; повторная установка ничего не ломает. */
const AGENT_KIT = String.raw`(() => {
  if (window.__mboxAgent) return true;
  const style = document.createElement("style");
  style.textContent = [
    ".__mbox-hl{outline:2px solid #0a84ff !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(10,132,255,.22) !important;border-radius:4px;transition:outline-color .3s,box-shadow .3s}",
    ".__mbox-hl.__mbox-done{outline-color:#30d158 !important;box-shadow:0 0 0 6px rgba(48,209,88,.2) !important}",
    ".__mbox-badge{position:absolute;z-index:2147483647;max-width:320px;padding:3px 8px;border-radius:6px;background:#0a84ff;color:#fff;font:600 12px/1.35 -apple-system,'Segoe UI',Inter,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;white-space:normal}",
    ".__mbox-badge.__mbox-done{background:#248a3d}",
  ].join("");
  (document.head || document.documentElement).appendChild(style);
  let seq = 0;
  const badges = new Set();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (text, max = 120) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  const labelOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "); if (clean(t)) return clean(t); }
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return clean(l.innerText); }
    const wrap = el.closest("label"); if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i += 1, prev = prev.previousElementSibling) if (clean(prev.innerText)) return clean(prev.innerText, 80);
    // Текст родителя — подпись, только если он короткий: иначе полю доставалась в подпись вся форма.
    const parentText = clean(el.parentElement?.innerText, 200);
    return (parentText.length <= 60 ? parentText : "") || clean(el.name || el.id);
  };
  const refOf = (el, prefix) => {
    if (!el.dataset.mboxRef) el.dataset.mboxRef = prefix + (++seq);
    return el.dataset.mboxRef;
  };
  const find = (ref) => document.querySelector('[data-mbox-ref="' + CSS.escape(String(ref)) + '"]');
  const byLabel = (label) => {
    const want = clean(label).toLowerCase();
    if (!want) return null;
    const fields = [...document.querySelectorAll("input,textarea,select,[contenteditable=''],[contenteditable='true'],[role='textbox'],[role='combobox']")].filter(visible);
    return fields.find((el) => labelOf(el).toLowerCase() === want) || fields.find((el) => labelOf(el).toLowerCase().includes(want)) || fields.find((el) => clean(el.name).toLowerCase() === want) || null;
  };
  const clearMarks = () => {
    document.querySelectorAll(".__mbox-hl").forEach((el) => el.classList.remove("__mbox-hl", "__mbox-done"));
    badges.forEach((b) => b.remove()); badges.clear();
  };
  const mark = (el, text, done) => {
    el.classList.add("__mbox-hl");
    el.classList.toggle("__mbox-done", Boolean(done));
    if (!text) return;
    const r = el.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.className = "__mbox-badge" + (done ? " __mbox-done" : "");
    badge.textContent = text;
    badge.style.left = Math.max(4, r.left + scrollX) + "px";
    badge.style.top = Math.max(4, r.top + scrollY - 26) + "px";
    document.body.appendChild(badge);
    badges.add(badge);
  };
  const later = (ms, fn) => setTimeout(fn, ms);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fieldValue = (el) => {
    if (el.type === "password") return el.value ? "(заполнен, скрыт)" : "";
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.isContentEditable) return clean(el.innerText, 500);
    if (el.tagName === "SELECT") return el.selectedOptions?.[0] ? clean(el.selectedOptions[0].text) : "";
    return String(el.value ?? "").slice(0, 500);
  };
  const setValue = (el, value) => {
    el.focus();
    if (el.tagName === "SELECT") {
      const want = String(value).toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
      if (!option) return "нет такого варианта";
      el.value = option.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      const on = value === true || /^(1|true|да|yes|on)$/i.test(String(value));
      if (el.checked !== on) el.click();
      return "";
    } else if (el.isContentEditable) {
      el.textContent = String(value);
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return "";
  };
  window.__mboxAgent = {
    snapshot(maxText) {
      const fields = [];
      for (const el of document.querySelectorAll("input,textarea,select,[contenteditable=''],[contenteditable='true'],[role='textbox'],[role='combobox'],[role='checkbox']")) {
        if (fields.length >= 150 || !visible(el)) continue;
        if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image", "reset", "file"].includes(el.type)) continue;
        const item = { ref: refOf(el, "f"), label: labelOf(el), kind: el.tagName === "SELECT" ? "select" : el.isContentEditable ? "editable" : (el.type || el.tagName.toLowerCase()), value: fieldValue(el) };
        if (el.name) item.name = el.name;
        if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
        if (el.disabled || el.readOnly) item.disabled = true;
        if (el.tagName === "SELECT") item.options = [...el.options].slice(0, 40).map((o) => clean(o.text, 60));
        fields.push(item);
      }
      const actions = [];
      for (const el of document.querySelectorAll("button,a[href],input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem]")) {
        if (actions.length >= 120 || !visible(el)) continue;
        const text = clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title, 80);
        if (!text) continue;
        const item = { ref: refOf(el, "b"), text, kind: el.tagName === "A" ? "link" : "button" };
        if (el.tagName === "A") item.href = el.href.slice(0, 200);
        actions.push(item);
      }
      const headings = [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 30).map((h) => clean(h.innerText, 100)).filter(Boolean);
      const text = clean(document.body?.innerText || "", Number(maxText) || 6000);
      return { url: location.href, title: document.title, selection: clean(String(getSelection() || ""), 2000), headings, fields, actions, text, frames: document.querySelectorAll("iframe").length };
    },
    async fill(items, actor, note) {
      clearMarks();
      const results = [];
      for (const item of items) {
        const el = (item.ref && find(item.ref)) || (item.label && byLabel(item.label));
        if (!el) { results.push({ ref: item.ref, label: item.label, ok: false, error: "поле не найдено — обновите снимок" }); continue; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        await sleep(180);
        const name = labelOf(el) || item.ref;
        mark(el, actor + ": " + (note || "заполняет") + " · " + name);
        await sleep(260);
        const error = el.type === "file" ? "файл агент не выбирает" : setValue(el, item.value);
        badges.forEach((b) => b.remove()); badges.clear();
        mark(el, "", !error);
        results.push({ ref: refOf(el, "f"), label: name, ok: !error, ...(error ? { error } : {}), value: fieldValue(el) });
      }
      later(6000, clearMarks);
      return results;
    },
    async click(ref, actor, note) {
      const el = find(ref);
      if (!el) return { ok: false, error: "элемент не найден — обновите снимок" };
      clearMarks();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await sleep(200);
      mark(el, actor + ": " + (note || "нажимает") + " · " + clean(el.innerText || el.value || el.getAttribute("aria-label"), 60));
      await sleep(450);
      el.click();
      later(2500, clearMarks);
      return { ok: true };
    },
    highlight(refs, actor, note, ms) {
      clearMarks();
      const found = refs.map(find).filter(Boolean);
      found[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      found.forEach((el, index) => mark(el, index === 0 ? actor + (note ? ": " + note : "") : ""));
      if (ms !== 0) later(Number(ms) || 8000, clearMarks);
      return { ok: true, found: found.length, missing: refs.length - found.length };
    },
    clear() { clearMarks(); return { ok: true }; },
    scroll(ref, to) {
      if (ref) { const el = find(ref); if (!el) return { ok: false, error: "элемент не найден" }; el.scrollIntoView({ block: "center", behavior: "smooth" }); return { ok: true }; }
      const height = innerHeight * 0.85;
      if (to === "top") scrollTo({ top: 0, behavior: "smooth" });
      else if (to === "bottom") scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      else scrollBy({ top: to === "up" ? -height : height, behavior: "smooth" });
      return { ok: true };
    },
  };
  return true;
})()`;

function agentTab(key) {
  const wanted = key && tabs.get(key) ? key : [...visibleKeys].find((item) => tabs.has(item)) || (tabs.has(lastShownKey) ? lastShownKey : "");
  return wanted ? { key: wanted, tab: tabs.get(wanted) } : null;
}

async function inPage(contents, call) {
  await contents.executeJavaScript(AGENT_KIT, true);
  return contents.executeJavaScript(`(async () => window.__mboxAgent.${call})()`, true);
}

/** Действие агента во вкладке. key пустой — вкладка, которую человек видит сейчас. */
async function agentAction(key, action, args = {}, actor = "Агент", note = "") {
  if (action === "tabs") {
    return { ok: true, active: agentTab("")?.key || "", tabs: [...tabs.keys()].map((item) => ({ ...stateOf(item), visible: tabs.get(item).visible })) };
  }
  // Без вкладки браузера navigate тоже вернёт no_tab: новую вкладку открывает страница MBOX (browserAgent.ts).
  const target = agentTab(key);
  if (!target) return { ok: false, error: "no_tab", message: "В MBOX не открыта ни одна вкладка браузера. Откройте страницу (browser_navigate) или попросите человека." };
  const contents = target.tab.view.webContents;
  const who = JSON.stringify(String(actor || "Агент").slice(0, 40));
  const say = JSON.stringify(String(note || "").slice(0, 160));
  emit({ type: "agent", key: target.key, actor: String(actor || "Агент"), action, note: String(note || "") });
  try {
    if (action === "navigate") {
      open(target.key, args.url);
      return { ok: true, key: target.key, url: normalizeUrl(args.url) };
    }
    if (action === "snapshot") {
      if (contents.isLoading()) await new Promise((resolve) => { contents.once("did-stop-loading", resolve); setTimeout(resolve, 8000); });
      return { ok: true, key: target.key, ...(await inPage(contents, `snapshot(${Number(args.max_text) || 6000})`)) };
    }
    if (action === "fill") {
      const items = (Array.isArray(args.fields) ? args.fields : []).slice(0, 80).map((item) => ({ ref: item?.ref ? String(item.ref) : "", label: item?.label ? String(item.label) : "", value: item?.value ?? "" }));
      if (!items.length) return { ok: false, error: "fields_required" };
      return { ok: true, key: target.key, results: await inPage(contents, `fill(${JSON.stringify(items)}, ${who}, ${say})`) };
    }
    if (action === "click") return { key: target.key, ...(await inPage(contents, `click(${JSON.stringify(String(args.ref || ""))}, ${who}, ${say})`)) };
    if (action === "highlight") {
      if (args.clear) return { key: target.key, ...(await inPage(contents, "clear()")) };
      const refs = (Array.isArray(args.refs) ? args.refs : [args.ref]).filter(Boolean).map(String).slice(0, 40);
      return { key: target.key, ...(await inPage(contents, `highlight(${JSON.stringify(refs)}, ${who}, ${say}, ${Number(args.ms ?? 8000)})`)) };
    }
    if (action === "scroll") return { key: target.key, ...(await inPage(contents, `scroll(${JSON.stringify(String(args.ref || ""))}, ${JSON.stringify(String(args.to || "down"))})`)) };
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
  // Сайты не получают разрешения, файловые загрузки и доступ к мосту MBOX.
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event) => event.preventDefault());

  // Масштаб интерфейса меняется — прямоугольник в пикселях окна становится другим.
  mainWindow.webContents.on("zoom-changed", () => { for (const tab of tabs.values()) applyBounds(tab); });
  mainWindow.on("closed", () => { tabs.clear(); window = null; });
}

module.exports = { attach, open, setBounds, show, hide, hideAll, close, act, capture, favicon, fillPassword, answerAuth, agentAction, state: stateOf, PARTITION };
