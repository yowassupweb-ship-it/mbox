// Пароли встроенного браузера MBOX.
//
// Главное хранилище — раздел «Пароли» на сервере MBOX (server/passwords.mjs, решение #41): там же лежат доступы к серверам и прочее,
// у каждого человека свои записи, на любом компьютере одни и те же входы. Здесь — их копия для работы без сети: один файл,
// зашифрованный safeStorage (ключ привязан к учётной записи ОС — на Windows это DPAPI, как у Chrome). Чтения синхронные
// (страница ждёт подсказку мгновенно) и идут из копии; записи сразу меняют копию и уходят на сервер очередью — без сети очередь
// дождётся связи. Копия обновляется с сервера при старте, раз в 2 минуты и после каждой своей записи.
//
// Записи хранятся по происхождению сайта (https://site.ru): подставляются на том же происхождении и, с пометкой, на поддоменах
// того же сайта — как в Chrome (вход на accounts.site.ru подходит и для site.ru).
//
// Файл v3: { version: 3, entries: [{ id, origin, url, username, password, createdAt, updatedAt, usedAt, uses }], never: [origin],
// queue: [операции для сервера], migrated: true }. Файлы v1/v2 (пароли, жившие только на этом компьютере) при первой связи
// с сервером целиком уходят туда импортом; сервер не затирает более свежий пароль старой копией.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const serverState = require("./server-state");

const FILE = "mbox-browser-vault.bin";
const REFRESH_MS = 2 * 60_000;
const STALE_MS = 60_000;
let cache = null;
let syncing = null;
let lastSync = 0;
let timer = null;

function vaultPath() {
  return path.join(app.getPath("userData"), FILE);
}

function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch { return ""; }
}

/** Сайт без поддоменов: «accounts.google.com» → «google.com», «shop.site.co.uk» → «site.co.uk». */
function siteOf(origin) {
  let host = "";
  try { host = new URL(origin).hostname; } catch { return ""; }
  if (/^[\d.]+$/.test(host) || host === "localhost" || !host.includes(".")) return host;
  const parts = host.split(".");
  const second = parts[parts.length - 2];
  const short = /^(co|com|net|org|gov|edu|ac|msk|spb)$/.test(second) && parts.length > 2;
  return parts.slice(short ? -3 : -2).join(".");
}

const normalize = (entry, fallbackTime) => ({
  id: String(entry.id || crypto.randomUUID()),
  origin: entry.origin || originOf(entry.url),
  url: String(entry.url || ""),
  username: String(entry.username || ""),
  password: String(entry.password || ""),
  createdAt: Number(entry.createdAt || fallbackTime),
  updatedAt: Number(entry.updatedAt || fallbackTime),
  usedAt: Number(entry.usedAt || 0),
  uses: Number(entry.uses || 0),
});

function load() {
  if (cache) return cache;
  cache = { version: 3, entries: [], never: [], queue: [], migrated: false };
  const file = vaultPath();
  if (!fs.existsSync(file) || !available()) return cache;
  try {
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    const now = Date.now();
    cache.entries = (Array.isArray(data.entries) ? data.entries : []).map((entry) => normalize(entry, data.savedAt || now)).filter((entry) => entry.origin && entry.password);
    cache.never = Array.isArray(data.never) ? data.never.filter((item) => typeof item === "string") : [];
    cache.queue = Array.isArray(data.queue) ? data.queue : [];
    cache.migrated = data.version === 3 && Boolean(data.migrated);
    // Старый файл: всё, что в нём было, один раз уходит на сервер.
    if (!cache.migrated && cache.entries.length + cache.never.length > 0 && !cache.queue.some((op) => op.op === "import")) {
      cache.queue.unshift({ op: "import", entries: cache.entries.map(({ url, origin, username, password, updatedAt }) => ({ url: url || origin, username, password, updatedAt })), never: [...cache.never] });
    }
  } catch {
    // Файл зашифрован другим ключом ОС (перенесли профиль) — начинаем с пустого; сервер вернёт всё при синхронизации.
  }
  return cache;
}

function persist() {
  if (!available()) return;
  const data = load();
  const file = vaultPath();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ ...data, version: 3 })));
    fs.renameSync(tmp, file);
  } catch { /* копия необязательна: сервер главный */ }
}

function enqueue(op) {
  load().queue.push({ ...op, at: Date.now() });
  persist();
  scheduleSync(800);
}

// ── Связь с сервером ─────────────────────────────────────────────────────────

const serverId = (id) => (/^\d+$/.test(String(id)) ? String(id) : "");

async function runOp(op) {
  const post = (url, body) => serverState.call(url, { method: "POST", body: JSON.stringify(body) });
  switch (op.op) {
    case "import": return post("/api/mbox/passwords/import", { entries: op.entries || [], never: op.never || [], source: "desktop" });
    case "save": return post("/api/mbox/passwords/save", { url: op.url, username: op.username, password: op.password });
    case "used": return serverId(op.id) ? post("/api/mbox/passwords/used", { id: op.id }) : null;
    case "never": return post("/api/mbox/passwords/never", { url: op.url });
    case "allow": return serverState.call(`/api/mbox/passwords/never?origin=${encodeURIComponent(op.origin)}`, { method: "DELETE" });
    case "update": return serverId(op.id) ? serverState.call(`/api/mbox/secrets/${op.id}`, { method: "PATCH", body: JSON.stringify(op.patch) }) : null;
    case "remove": return serverId(op.id) ? serverState.call(`/api/mbox/secrets/${op.id}`, { method: "DELETE" }).catch((error) => { if (!/404/.test(String(error))) throw error; }) : null;
    default: return null;
  }
}

/** Отправить очередь и забрать свежую копию. Без связи — тихо выходим: чтения работают по копии. */
async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!(await serverState.ensureOn())) return false;
    const data = load();
    while (data.queue.length) {
      const op = data.queue[0];
      try { await runOp(op); }
      catch (error) {
        // Сервер отказал по существу (400) — операцию не повторяем вечно; сеть или 5xx — ждём следующей попытки.
        if (!/-> 4\d\d/.test(String(error))) return false;
      }
      if (op.op === "import") data.migrated = true;
      data.queue.shift();
      persist();
    }
    data.migrated = true;
    const vault = await serverState.call("/api/mbox/passwords/vault");
    const now = Date.now();
    data.entries = (vault.entries || []).map((entry) => normalize(entry, now)).filter((entry) => entry.origin && entry.password);
    data.never = Array.isArray(vault.never) ? vault.never : [];
    persist();
    lastSync = Date.now();
    return true;
  })().catch(() => false).finally(() => { syncing = null; });
  return syncing;
}

function scheduleSync(delay = 0) {
  clearTimeout(timer);
  timer = setTimeout(() => { void sync().finally(() => scheduleSync(REFRESH_MS)); }, delay);
  timer.unref?.();
}

/** Запуск синхронизации: из main.js, когда сервер MBOX известен. */
function start() {
  load();
  scheduleSync(0);
}

/** Копия давно не обновлялась — подтянуть в фоне, отвечая пока по ней. */
function freshen() {
  if (Date.now() - lastSync > STALE_MS) scheduleSync(0);
}

// ── Чтение ───────────────────────────────────────────────────────────────────

/** Без паролей — для списков в интерфейсе. */
function publicEntry(entry, origin = "") {
  return {
    id: entry.id,
    origin: entry.origin,
    host: (() => { try { return new URL(entry.origin).host; } catch { return entry.origin; } })(),
    username: entry.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    usedAt: entry.usedAt,
    uses: entry.uses,
    // Запись с другого поддомена того же сайта: Chrome показывает её под чертой с адресом.
    other: Boolean(origin) && entry.origin !== origin,
  };
}

/** Подходящие записи для страницы: сначала точное происхождение, потом поддомены того же сайта; внутри — по использованию. */
function matching(pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return [];
  const site = siteOf(origin);
  const secure = origin.startsWith("https:");
  return load().entries
    .filter((entry) => entry.origin === origin || (secure && entry.origin.startsWith("https:") && siteOf(entry.origin) === site))
    .sort((a, b) => Number(b.origin === origin) - Number(a.origin === origin) || (b.usedAt || b.updatedAt) - (a.usedAt || a.updatedAt));
}

function list() {
  freshen();
  return load().entries.map((entry) => publicEntry(entry)).sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
}

function forPage(pageUrl) {
  freshen();
  const origin = originOf(pageUrl);
  return matching(pageUrl).map((entry) => publicEntry(entry, origin));
}

/** Сам пароль — только тому, кто уже проверил, что страница того же сайта (или интерфейсу MBOX). */
function secret(id) {
  const entry = load().entries.find((item) => item.id === id);
  return entry ? { username: entry.username, password: entry.password, origin: entry.origin } : null;
}

function secretForPage(id, pageUrl) {
  const entry = matching(pageUrl).find((item) => item.id === id);
  return entry ? { username: entry.username, password: entry.password } : null;
}

/**
 * Что делать с отправленной формой входа: "none" — такая запись уже есть, "save" — новая, "update" — у этого логина
 * другой пароль, "never" — для сайта сохранение выключено.
 */
function classify(pageUrl, username, password) {
  const origin = originOf(pageUrl);
  if (!origin || !password) return { action: "none" };
  const data = load();
  if (data.never.includes(origin)) return { action: "never" };
  const same = data.entries.filter((entry) => entry.origin === origin);
  const exact = same.find((entry) => entry.username === username);
  if (exact) return exact.password === password ? { action: "none", id: exact.id } : { action: "update", id: exact.id };
  // Логина не нашли, но пароль совпал с единственной записью без логина — это та же запись.
  const anonymous = same.find((entry) => !entry.username && entry.password === password);
  if (anonymous) return { action: "none", id: anonymous.id };
  return { action: "save" };
}

function neverList() {
  return [...load().never].sort();
}

function count() {
  return load().entries.length;
}

// ── Запись: сразу в копию, на сервер — очередью ─────────────────────────────

function markUsed(id) {
  const entry = load().entries.find((item) => item.id === id);
  if (!entry) return;
  entry.usedAt = Date.now();
  entry.uses += 1;
  enqueue({ op: "used", id });
}

function save({ url, username, password }) {
  const origin = originOf(url);
  if (!origin || !password) return { ok: false, error: "Нечего сохранять" };
  const data = load();
  const now = Date.now();
  const user = String(username || "");
  const existing = data.entries.find((entry) => entry.origin === origin && entry.username === user);
  if (existing) {
    existing.password = String(password);
    existing.updatedAt = now;
    existing.usedAt = now;
  } else {
    data.entries.push({ id: crypto.randomUUID(), origin, url: String(url).split(/[?#]/)[0], username: user, password: String(password), createdAt: now, updatedAt: now, usedAt: now, uses: 1 });
  }
  data.never = data.never.filter((item) => item !== origin);
  enqueue({ op: "save", url: String(url).split(/[?#]/)[0], username: user, password: String(password) });
  return { ok: true };
}

function update(id, patch) {
  const data = load();
  const entry = data.entries.find((item) => item.id === id);
  if (!entry) return { ok: false, error: "Запись не найдена" };
  const change = {};
  if (typeof patch?.username === "string") {
    const username = patch.username.trim();
    if (data.entries.some((item) => item !== entry && item.origin === entry.origin && item.username === username)) return { ok: false, error: "Для этого сайта такой логин уже сохранён" };
    entry.username = username;
    change.login = username;
  }
  if (typeof patch?.password === "string") {
    if (!patch.password) return { ok: false, error: "Пароль не может быть пустым" };
    entry.password = patch.password;
    change.password = patch.password;
  }
  entry.updatedAt = Date.now();
  // Запись ещё не дошла до сервера (нет числового id) — отправим её целиком, как новую.
  enqueue(serverId(id) ? { op: "update", id, patch: change } : { op: "save", url: entry.url || entry.origin, username: entry.username, password: entry.password });
  return { ok: true };
}

function remove(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((item) => item.id !== id);
  if (data.entries.length !== before) enqueue({ op: "remove", id });
  return { ok: true };
}

function never(url) {
  const origin = originOf(url) || String(url || "");
  const data = load();
  if (origin && !data.never.includes(origin)) { data.never.push(origin); enqueue({ op: "never", url: origin }); }
  return { ok: true };
}

function allow(origin) {
  const data = load();
  data.never = data.never.filter((item) => item !== origin);
  enqueue({ op: "allow", origin });
  return { ok: true };
}

/** Импорт из CSV Chrome: дополняет хранилище на сервере; в копию попадёт после синхронизации. */
function importEntries(rows) {
  const entries = rows.filter((row) => originOf(row.url) && row.password).map((row) => ({ url: String(row.url), username: String(row.username || ""), password: String(row.password) }));
  const data = load();
  const now = Date.now();
  let added = 0;
  let updated = 0;
  for (const row of entries) {
    const origin = originOf(row.url);
    const existing = data.entries.find((entry) => entry.origin === origin && entry.username === row.username);
    if (existing) { if (existing.password !== row.password) { existing.password = row.password; existing.updatedAt = now; updated += 1; } continue; }
    data.entries.push({ id: crypto.randomUUID(), origin, url: row.url, username: row.username, password: row.password, createdAt: now, updatedAt: now, usedAt: 0, uses: 0 });
    added += 1;
  }
  enqueue({ op: "import", entries, never: [] });
  return { ok: true, count: added + updated, added, updated, total: data.entries.length };
}

module.exports = { available, originOf, list, forPage, secret, secretForPage, markUsed, classify, save, update, remove, never, neverList, allow, importEntries, count, start, sync };
