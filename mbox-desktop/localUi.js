// Встроенный интерфейс MBOX Desktop.
//
// Раньше окно открывало сайт (https://mbox.shar-os.ru), и мост к диску, агентам и SSH получала страница,
// присланная сервером: взлом или подмена прода означали доступ к компьютеру. Теперь собранный интерфейс
// лежит внутри приложения (папка ui/, собирается scripts/build-desktop-ui.mjs) и грузится с mbox://app/.
//  - /api/* и /downloads/* главный процесс переправляет на сервер с cookie сессии из общего хранилища;
//  - вебсокет страница открывает прямо на сервер, cookie к нему добавляем здесь (SameSite=Lax его бы не отдал);
//  - localStorage у mbox://app свой — при первом запуске переносим раскладку, вкладки и черновики со старого адреса.
// MBOX_UI=remote (или отсутствие ui/) — старый режим: окно грузит MBOX_URL, так удобно разрабатывать с HMR.

const { app, protocol, session, net } = require("electron");
const fs = require("fs");
const path = require("path");

const SCHEME = "mbox";
const HOST = "app";
const UI_ROOT = path.join(__dirname, "ui");
const APP_ORIGIN = `${SCHEME}://${HOST}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json"
};

// Заголовки ответа, которые после net.fetch врут: тело уже распаковано и длина другая.
const DROP_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "set-cookie"];

function localUiAvailable() {
  return process.env.MBOX_UI !== "remote" && fs.existsSync(path.join(UI_ROOT, "index.html"));
}

/** Вызывать до app.whenReady: схема должна быть «стандартной», иначе нет localStorage, fetch и относительных путей. */
function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true }
  }]);
}

function serveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  const target = path.normalize(path.join(UI_ROOT, rel));
  if (target !== UI_ROOT && !target.startsWith(UI_ROOT + path.sep)) return new Response("forbidden", { status: 403 });
  let file = target;
  let stat = null;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || stat.isDirectory()) {
    // Адреса интерфейса без расширения (/?tab=…, /tools) — это одна страница приложения.
    if (path.extname(rel)) return new Response("not found", { status: 404 });
    file = path.join(UI_ROOT, "index.html");
  }
  const headers = { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" };
  // Хешированные бандлы неизменны, index.html — всегда свежий после обновления приложения.
  headers["cache-control"] = /[\\/]assets[\\/].+-[\w-]{8}\.(js|css)$/.test(file) ? "max-age=31536000, immutable" : "no-cache";
  return new Response(fs.readFileSync(file), { status: 200, headers });
}

async function proxy(request, url, serverUrl) {
  const target = `${serverUrl}${url.pathname}${url.search}`;
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    // Origin/Referer со схемой mbox:// серверу ни к чему, cookie подставит сетевой стек сессии.
    if (!["origin", "referer", "host", "cookie", "connection"].includes(key.toLowerCase())) headers.set(key, value);
  });
  const init = { method: request.method, headers, credentials: "include", bypassCustomProtocolHandlers: true, redirect: "follow" };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }
  let response;
  try {
    response = await session.defaultSession.fetch(target, init);
  } catch (error) {
    return new Response(JSON.stringify({ error: `server_unreachable: ${error.message}` }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const outHeaders = new Headers();
  response.headers.forEach((value, key) => { if (!DROP_RESPONSE_HEADERS.includes(key.toLowerCase())) outHeaders.set(key, value); });
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers: outHeaders });
}

/** Обработчик mbox://app и cookie для вебсокета. Вызывать после app.whenReady, до создания окна. */
function installLocalUi(serverUrl) {
  session.defaultSession.protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("not found", { status: 404 });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/downloads/")) return proxy(request, url, serverUrl);
    return serveFile(url.pathname);
  });

  const server = new URL(serverUrl);
  const wsProtocol = server.protocol === "https:" ? "wss:" : "ws:";
  const wsPattern = `${wsProtocol}//${server.host}/api/mbox/realtime*`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [wsPattern] }, (details, callback) => {
    session.defaultSession.cookies.get({ url: serverUrl })
      .then((cookies) => {
        const requestHeaders = { ...details.requestHeaders };
        if (cookies.length) requestHeaders.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        callback({ requestHeaders });
      })
      .catch(() => callback({ requestHeaders: details.requestHeaders }));
  });
}

// --- Перенос localStorage со старого адреса ------------------------------------------------------

const MIGRATION_FLAG = () => path.join(app.getPath("userData"), "local-ui-storage-migrated.json");
let pendingStorage = null;

/**
 * Один раз читаем localStorage сайта (тот же профиль Electron) в скрытом окне и отдаём его preload-у
 * встроенной страницы до запуска её скриптов. Нет сети или сайт не открылся — попробуем при следующем запуске.
 */
async function prepareStorageMigration(serverUrl) {
  if (fs.existsSync(MIGRATION_FLAG())) return;
  const { BrowserWindow } = require("electron");
  const hidden = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    const loaded = hidden.loadURL(`${serverUrl}/manifest.webmanifest`);
    await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
    const entries = await hidden.webContents.executeJavaScript(
      "(() => { const out = {}; for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); out[key] = localStorage.getItem(key); } return out; })()",
      true
    );
    pendingStorage = entries && typeof entries === "object" ? entries : {};
  } catch {
    pendingStorage = null;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function takePendingStorage() {
  const entries = pendingStorage;
  pendingStorage = null;
  if (entries) {
    try { fs.writeFileSync(MIGRATION_FLAG(), JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(entries).length })); } catch {}
  }
  return entries;
}

module.exports = { APP_ORIGIN, localUiAvailable, registerSchemePrivileges, installLocalUi, prepareStorageMigration, takePendingStorage, net };
