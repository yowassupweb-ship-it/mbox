// Пароли встроенного браузера MBOX.
//
// Хранятся только на этом компьютере, в одном файле, зашифрованном safeStorage (ключ привязан к учётной записи ОС —
// на Windows это DPAPI, как у Chrome). На сервер MBOX и агентам пароли не уходят. Записи сохраняются по происхождению
// сайта (https://site.ru): подставляются на том же происхождении и, с пометкой, на поддоменах того же сайта — как в Chrome
// (вход на accounts.site.ru подходит и для site.ru).
//
// Формат файла v2: { version: 2, entries: [{ id, origin, url, username, password, createdAt, updatedAt, usedAt, uses }],
// never: [origin] }. Файл v1 (импорт CSV из Chrome: { entries: [{ url, username, password }] }) читается и при первой
// записи переписывается в v2.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");

const FILE = "mbox-browser-vault.bin";
let cache = null;

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

function load() {
  if (cache) return cache;
  cache = { version: 2, entries: [], never: [] };
  const file = vaultPath();
  if (!fs.existsSync(file) || !available()) return cache;
  try {
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    const now = Date.now();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    cache.entries = entries.map((entry) => ({
      id: entry.id || crypto.randomUUID(),
      origin: entry.origin || originOf(entry.url),
      url: String(entry.url || ""),
      username: String(entry.username || ""),
      password: String(entry.password || ""),
      createdAt: Number(entry.createdAt || data.savedAt || now),
      updatedAt: Number(entry.updatedAt || data.savedAt || now),
      usedAt: Number(entry.usedAt || 0),
      uses: Number(entry.uses || 0),
    })).filter((entry) => entry.origin && entry.password);
    cache.never = Array.isArray(data.never) ? data.never.filter((item) => typeof item === "string") : [];
  } catch {
    // Файл зашифрован другим ключом ОС (перенесли профиль) — начинаем с пустого, старый файл не трогаем до записи.
  }
  return cache;
}

function persist() {
  if (!available()) throw new Error("Шифрованное хранилище ОС недоступно — пароли не сохранены");
  const data = load();
  const file = vaultPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)));
  fs.renameSync(tmp, file);
}

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
  return load().entries.map((entry) => publicEntry(entry)).sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
}

function forPage(pageUrl) {
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

function markUsed(id) {
  const entry = load().entries.find((item) => item.id === id);
  if (!entry) return;
  entry.usedAt = Date.now();
  entry.uses += 1;
  try { persist(); } catch { /* отметка необязательна */ }
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

function save({ url, username, password }) {
  const origin = originOf(url);
  if (!origin || !password) return { ok: false, error: "Нечего сохранять" };
  const data = load();
  const now = Date.now();
  const existing = data.entries.find((entry) => entry.origin === origin && entry.username === String(username || ""));
  if (existing) {
    existing.password = String(password);
    existing.updatedAt = now;
    existing.usedAt = now;
  } else {
    data.entries.push({ id: crypto.randomUUID(), origin, url: String(url).split(/[?#]/)[0], username: String(username || ""), password: String(password), createdAt: now, updatedAt: now, usedAt: now, uses: 1 });
  }
  data.never = data.never.filter((item) => item !== origin);
  persist();
  return { ok: true };
}

function update(id, patch) {
  const data = load();
  const entry = data.entries.find((item) => item.id === id);
  if (!entry) return { ok: false, error: "Запись не найдена" };
  if (typeof patch?.username === "string") {
    const username = patch.username.trim();
    if (data.entries.some((item) => item !== entry && item.origin === entry.origin && item.username === username)) return { ok: false, error: "Для этого сайта такой логин уже сохранён" };
    entry.username = username;
  }
  if (typeof patch?.password === "string") {
    if (!patch.password) return { ok: false, error: "Пароль не может быть пустым" };
    entry.password = patch.password;
  }
  entry.updatedAt = Date.now();
  persist();
  return { ok: true };
}

function remove(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((item) => item.id !== id);
  if (data.entries.length !== before) persist();
  return { ok: true };
}

function never(url) {
  const origin = originOf(url) || String(url || "");
  const data = load();
  if (origin && !data.never.includes(origin)) { data.never.push(origin); persist(); }
  return { ok: true };
}

function neverList() {
  return [...load().never].sort();
}

function allow(origin) {
  const data = load();
  data.never = data.never.filter((item) => item !== origin);
  persist();
  return { ok: true };
}

/** Импорт из CSV Chrome: дополняет хранилище (раньше файл перезаписывался целиком и сохранённое пропадало). */
function importEntries(rows) {
  const data = load();
  let added = 0;
  let updated = 0;
  const now = Date.now();
  for (const row of rows) {
    const origin = originOf(row.url);
    if (!origin || !row.password) continue;
    const existing = data.entries.find((entry) => entry.origin === origin && entry.username === String(row.username || ""));
    if (existing) {
      if (existing.password !== row.password) { existing.password = String(row.password); existing.updatedAt = now; updated += 1; }
      continue;
    }
    data.entries.push({ id: crypto.randomUUID(), origin, url: String(row.url), username: String(row.username || ""), password: String(row.password), createdAt: now, updatedAt: now, usedAt: 0, uses: 0 });
    added += 1;
  }
  persist();
  return { ok: true, count: added + updated, added, updated, total: data.entries.length };
}

function count() {
  return load().entries.length;
}

module.exports = { available, originOf, list, forPage, secret, secretForPage, markUsed, classify, save, update, remove, never, neverList, allow, importEntries, count };
