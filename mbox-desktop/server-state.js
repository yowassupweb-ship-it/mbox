// Состояние встроенного браузера на сервере MBOX: закладки, история, куки.
//
// Смысл — сквозная сессия: сел за другой компьютер, поставил MBOX Desktop, и там те же закладки,
// та же история и те же входы на сайты. Серверная часть — server/browser-state.mjs.
//
// Правила, которых тут придерживаемся:
//  - сервер главный, локальный файл (import-chrome.js) остаётся запасным на случай, когда MBOX
//    недоступен: без сети браузер обязан работать, просто без синхронизации;
//  - пароли сюда НЕ попадают, они остаются в локальном vault под safeStorage (решение #24);
//  - куки уезжают целиком одним набором и так же целиком возвращаются — сравнивать их по одной
//    бессмысленно, сайты всё равно меняют их пачками.

const { app, net, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// Куки входа Google/YouTube не переносим между машинами ни в какую сторону: Google привязывает сессию к
// устройству и постоянно перевыпускает эти куки, а копия с сервера (или с другой машины) расходилась с
// ними — Gmail через раз открывался страницей «Обнаружена неполадка в настройках файла cookie».
const NO_SYNC_DOMAINS = /(^|\.)(google|youtube|gstatic|googleusercontent|googleapis|withgoogle)\.[a-z.]+$/i;
const syncable = (cookie) => !NO_SYNC_DOMAINS.test(String(cookie?.domain || "").replace(/^\./, ""));

let serverUrl = "";
let enabled = false;

/** Запрос к MBOX от имени вошедшего пользователя: cookie сессии подставит сетевой стек. */
async function call(path, init = {}) {
  if (!serverUrl) throw new Error("MBOX_URL не задан");
  const response = await session.defaultSession.fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

function configure(url) {
  serverUrl = String(url || "").replace(/\/+$/, "");
}

/** Сервер доступен и пустил? Первая же удачная ручка включает синхронизацию на весь сеанс. */
async function probe() {
  try {
    await call("/api/mbox/browser/bookmarks");
    enabled = true;
  } catch {
    enabled = false;
  }
  return enabled;
}

const isOn = () => enabled;

// ── Закладки ────────────────────────────────────────────────────────────────────────────────

async function bookmarks() {
  const data = await call("/api/mbox/browser/bookmarks");
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function addBookmark(bookmark) {
  const data = await call("/api/mbox/browser/bookmarks", { method: "POST", body: JSON.stringify(bookmark) });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

/** Пачкой — это импорт из Chrome: на сервере он сливается с уже сохранённым, не затирая его. */
async function importBookmarks(items) {
  const data = await call("/api/mbox/browser/bookmarks", { method: "POST", body: JSON.stringify({ bookmarks: items }) });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function removeBookmark(url) {
  const data = await call(`/api/mbox/browser/bookmarks?url=${encodeURIComponent(url)}`, { method: "DELETE" });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function moveBookmark(url, beforeUrl) {
  const data = await call("/api/mbox/browser/bookmarks", { method: "PATCH", body: JSON.stringify({ url, before_url: beforeUrl }) });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function renameFolder(folder, to) {
  const data = await call("/api/mbox/browser/bookmarks", { method: "PATCH", body: JSON.stringify({ folder, to }) });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function removeFolder(folder) {
  const data = await call(`/api/mbox/browser/bookmarks?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

// ── История ─────────────────────────────────────────────────────────────────────────────────

async function history(search = "", limit = 300) {
  const data = await call(`/api/mbox/browser/history?q=${encodeURIComponent(search)}&limit=${limit}`);
  return Array.isArray(data.history) ? data.history : [];
}

/** Один переход. Ошибку глотаем: история — удобство, ронять из-за неё навигацию нельзя. */
function recordVisit(url, title) {
  if (!enabled || !/^https?:\/\//i.test(url || "")) return;
  call("/api/mbox/browser/history", { method: "POST", body: JSON.stringify({ url, title: title || "" }) })
    .catch(() => {});
}

async function clearHistory(url = "") {
  await call(`/api/mbox/browser/history${url ? `?url=${encodeURIComponent(url)}` : ""}`, { method: "DELETE" });
}

// ── Куки ────────────────────────────────────────────────────────────────────────────────────

/**
 * Забрать куки с сервера в раздел сессии браузера.
 *
 * Делается один раз при старте, ДО первой загрузки сайта: иначе страница успеет открыться
 * неавторизованной. Сессионные куки (без expirationDate) не переносим — они привязаны к сеансу
 * браузера, на другой машине от них нет пользы, а протухший идентификатор сессии только мешает.
 */
async function restoreCookies(partition) {
  if (!enabled) return 0;
  const data = await call("/api/mbox/browser/cookies");
  const jar = session.fromPartition(partition);
  // Своя кука на этой машине всегда свежее серверной копии. Google постоянно перевыпускает куки сессии
  // (__Secure-1PSIDTS и соседи), и старая копия с сервера, поставленная поверх при каждом старте,
  // рассинхронизировала их — вход в Gmail через раз падал на «Обнаружена неполадка в настройках cookie».
  // С сервера берём только то, чего здесь нет (новая машина, чистый профиль).
  const local = new Set((await jar.cookies.get({})).map((cookie) => `${cookie.name}|${cookie.domain}|${cookie.path}`));
  let restored = 0;
  for (const cookie of data.cookies || []) {
    if (!cookie?.name || !cookie?.domain) continue;
    if (!syncable(cookie)) continue;
    if (!cookie.expirationDate) continue;
    if (cookie.expirationDate * 1000 < Date.now()) continue;
    if (local.has(`${cookie.name}|${cookie.domain}|${cookie.path || "/"}`)) continue;
    const host = cookie.domain.replace(/^\./, "");
    // Кука «только для хоста» с domain стала бы кукой всего домена (accounts.google.com → .accounts.google.com)
    // и жила бы рядом с настоящей дублем; __Host- с domain Chromium не принимает вовсе.
    const hostOnly = Boolean(cookie.hostOnly) || cookie.name.startsWith("__Host-");
    const secure = Boolean(cookie.secure) || /^__(Secure|Host)-/.test(cookie.name);
    const url = `${secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
    try {
      await jar.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value || "",
        ...(hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path || "/",
        secure,
        httpOnly: Boolean(cookie.httpOnly),
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite || "unspecified",
      });
      restored += 1;
    } catch {
      // сайт сменил домен или куку нельзя поставить извне — пропускаем, остальные не страдают
    }
  }
  return restored;
}

/**
 * Разовая чистка кук Google в разделе браузера. Старое восстановление ставило куки «только для хоста»
 * как куки всего домена (accounts.google.com → .accounts.google.com) и поверх свежих — дубли с чужими
 * значениями остались в сохранённой сессии, и новая логика их уже не трогала. Точечно удалить дубль
 * нельзя: cookies.remove(url, name) снимает и настоящую куку тоже. Поэтому один раз стираем все куки
 * Google — человек заново входит в Gmail, и дальше они живут только на этой машине.
 */
async function repairGoogleCookies(partition) {
  const flag = path.join(app.getPath("userData"), "google-cookies-reset-v1");
  if (fs.existsSync(flag)) return 0;
  const jar = session.fromPartition(partition);
  let removed = 0;
  for (const cookie of await jar.cookies.get({})) {
    if (syncable(cookie)) continue;
    const host = String(cookie.domain || "").replace(/^\./, "");
    try {
      await jar.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`, cookie.name);
      removed += 1;
    } catch { /* уже удалена вместе с соседней */ }
  }
  await jar.cookies.flushStore().catch(() => {});
  try { fs.writeFileSync(flag, new Date().toISOString()); } catch { /* повторим при следующем запуске */ }
  return removed;
}

/** Выгрузить весь набор кук на сервер. Вызывается с задержкой — куки меняются пачками. */
async function pushCookies(partition) {
  if (!enabled) return 0;
  const jar = session.fromPartition(partition);
  const all = await jar.cookies.get({});
  const keep = all.filter((cookie) => syncable(cookie) && cookie.expirationDate && cookie.expirationDate * 1000 > Date.now());
  await call("/api/mbox/browser/cookies", { method: "PUT", body: JSON.stringify({ cookies: keep }) });
  return keep.length;
}

/**
 * Следить за куками раздела и досылать их на сервер. Задержка большая специально: за один вход на
 * сайт куки меняются десятки раз, и выгружать набор на каждое изменение — пустая трата и сети, и
 * шифрования на сервере.
 */
function watchCookies(partition, delayMs = 20000) {
  const jar = session.fromPartition(partition);
  let timer = null;
  jar.cookies.on("changed", () => {
    if (!enabled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      pushCookies(partition).catch(() => {});
    }, delayMs);
  });
}

module.exports = {
  configure,
  probe,
  isOn,
  bookmarks,
  addBookmark,
  importBookmarks,
  removeBookmark,
  moveBookmark,
  renameFolder,
  removeFolder,
  history,
  recordVisit,
  clearHistory,
  restoreCookies,
  repairGoogleCookies,
  pushCookies,
  watchCookies,
  net,
};
