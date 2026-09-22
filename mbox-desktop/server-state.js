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

const { net, session } = require("electron");

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
  let restored = 0;
  for (const cookie of data.cookies || []) {
    if (!cookie?.name || !cookie?.domain) continue;
    if (!cookie.expirationDate) continue;
    if (cookie.expirationDate * 1000 < Date.now()) continue;
    const host = cookie.domain.replace(/^\./, "");
    const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
    try {
      await jar.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value || "",
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
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

/** Выгрузить весь набор кук на сервер. Вызывается с задержкой — куки меняются пачками. */
async function pushCookies(partition) {
  if (!enabled) return 0;
  const jar = session.fromPartition(partition);
  const all = await jar.cookies.get({});
  const keep = all.filter((cookie) => cookie.expirationDate && cookie.expirationDate * 1000 > Date.now());
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
  history,
  recordVisit,
  clearHistory,
  restoreCookies,
  pushCookies,
  watchCookies,
  net,
};
