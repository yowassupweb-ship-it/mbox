// Импорт данных из Google Chrome во встроенный браузер MBOX: закладки и пароли.
//
// Всё импортируется только с явного действия человека и остаётся на его машине:
//  - закладки  — файл `Bookmarks` Chrome, это обычный JSON, читаем как есть;
//  - пароли    — НЕ расшифровываем хранилище Chrome (DPAPI). Человек сам экспортирует пароли из
//                Chrome в CSV (chrome://password-manager/passwords → «Экспорт», под паролем ОС),
//                а MBOX кладёт их в локальный vault, зашифрованный safeStorage (ключ привязан к ОС
//                и пользователю). Плейнтекст паролей не отдаётся ни на сервер, ни модели. Так решено
//                в архитектуре браузера (MBOX decision #24 / memory #2190).

const fs = require("fs");
const os = require("node:os");
const path = require("node:path");
const { app, safeStorage } = require("electron");

function chromeUserDataDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Google", "Chrome", "User Data");
}

/** Профиль Chrome по имени папки (Default, «Profile 1» …). По умолчанию — Default. */
function chromeProfileDir(profile = "Default") {
  if (!/^(Default|Profile \d+)$/.test(profile)) throw new Error("Недопустимый профиль Chrome");
  return path.join(chromeUserDataDir(), profile);
}

/**
 * Где Chrome держит закладки профиля.
 *
 * Раньше искали единственный файл `Bookmarks` — так было, пока закладки жили только локально.
 * Chrome с включённой синхронизацией аккаунта кладёт их в `AccountBookmarks`, и у такого профиля
 * файла `Bookmarks` может не быть вовсе: профиль считался «без закладок» и пропадал из списка,
 * а человек видел «Профили не найдены» при установленном Chrome с сотней закладок.
 * Структура у файлов одинаковая (roots: bookmark_bar / other / synced), поэтому читаем оба.
 */
function bookmarkFiles(profileDir) {
  return ["Bookmarks", "AccountBookmarks"]
    .map((name) => path.join(profileDir, name))
    .filter((file) => fs.existsSync(file));
}

function chromeProfiles() {
  const root = chromeUserDataDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
    .filter((entry) => bookmarkFiles(path.join(root, entry.name)).length > 0)
    .map((entry) => entry.name);
}

// ── Закладки ────────────────────────────────────────────────────────────────────────────────

function collectBookmarks(node, trail, out, source, isRoot = false) {
  if (!node) return;
  if (node.type === "url" && /^https?:\/\//i.test(node.url || "")) {
    out.push({ title: node.name || node.url, url: node.url, folder: trail.join(" / "), source });
  } else if (node.type === "folder" && Array.isArray(node.children)) {
    const next = isRoot || !node.name ? trail : [...trail, node.name];
    for (const child of node.children) collectBookmarks(child, next, out, source);
  }
}

function importBookmarks(profile = "Default") {
  const files = bookmarkFiles(chromeProfileDir(profile));
  if (!files.length) return { ok: false, error: "У Chrome нет файла закладок для этого профиля" };
  const out = [];
  // Локальные и аккаунтные закладки могут лежать рядом и частично совпадать — берём оба файла
  // и отсеиваем повторы по адресу, иначе одна и та же страница попала бы в список дважды.
  const seen = new Set();
  for (const file of files) {
    let roots;
    try {
      roots = JSON.parse(fs.readFileSync(file, "utf8")).roots || {};
    } catch {
      continue; // один битый файл не должен ронять импорт из второго
    }
    const found = [];
    for (const key of ["bookmark_bar", "other", "synced"]) collectBookmarks(roots[key], [], found, key, true);
    for (const item of found) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
  }
  if (!out.length) return { ok: false, error: "В закладках Chrome этого профиля ничего нет" };
  return { ok: true, items: out };
}

// ── Пароли: импорт из CSV, экспортированного самим Chrome ──────────────────────────────────────

/** CSV Chrome: кавычки, запятые и переносы строк внутри полей. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); if (row.some((cell) => cell.trim())) rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

/**
 * Импорт паролей из CSV, который человек экспортировал в Chrome. Chrome отдаёт колонки
 * name,url,username,password,note. Кладём в локальный vault, зашифрованный safeStorage (ключ ОС).
 * Возвращаем только количество записей — пароли наружу не выходят.
 */
function importPasswordsCsv(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return { ok: false, error: "CSV-файл не найден" };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "Шифрованное хранилище ОС недоступно — пароли не сохранены" };
  const text = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(text);
  if (!rows.length) return { ok: false, error: "CSV пустой" };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iUrl = col("url");
  const iUser = col("username");
  const iPass = col("password");
  if (iUrl < 0 || iUser < 0 || iPass < 0) return { ok: false, error: "Это не CSV экспорта паролей Chrome (нет колонок url/username/password)" };
  const entries = [];
  for (const cells of rows.slice(1)) {
    if (!cells[iUrl] && !cells[iUser]) continue;
    entries.push({ url: cells[iUrl] || "", username: cells[iUser] || "", password: cells[iPass] || "" });
  }
  const vault = path.join(app.getPath("userData"), "mbox-browser-vault.bin");
  const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, savedAt: Date.now(), entries }));
  fs.writeFileSync(vault, encrypted);
  return { ok: true, count: entries.length };
}

/** Сколько паролей уже лежит в локальном vault (для интерфейса; сами пароли не отдаём). */
function vaultInfo() {
  const vault = path.join(app.getPath("userData"), "mbox-browser-vault.bin");
  if (!fs.existsSync(vault) || !safeStorage.isEncryptionAvailable()) return { count: 0 };
  try {
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(vault)));
    return { count: Array.isArray(data.entries) ? data.entries.length : 0, savedAt: data.savedAt || 0 };
  } catch {
    return { count: 0 };
  }
}

function credentialsFor(pageUrl) {
  let origin;
  try { const url = new URL(pageUrl); if (url.protocol !== "https:") return []; origin = url.origin; } catch { return []; }
  const vault = path.join(app.getPath("userData"), "mbox-browser-vault.bin");
  if (!fs.existsSync(vault) || !safeStorage.isEncryptionAvailable()) return [];
  try {
    const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(vault)));
    return (Array.isArray(data.entries) ? data.entries : []).filter((entry) => {
      try { return new URL(entry.url).origin === origin; } catch { return false; }
    });
  } catch { return []; }
}

// ── Сохранение импортированного во встроенный браузер ────────────────────────────────────────

function browserDataDir() {
  const dir = path.join(app.getPath("userData"), "mbox-browser-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(browserDataDir(), name), JSON.stringify(data));
}

function readJson(name, fallback) {
  const file = path.join(browserDataDir(), name);
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function getBookmarks() {
  const data = readJson("bookmarks.json", { items: [] });
  return Array.isArray(data.items) ? data.items.filter((item) => /^https?:\/\//i.test(item.url || "")) : [];
}

function setBookmark({ title, url }) {
  const valid = new URL(String(url || ""));
  if (!["https:", "http:"].includes(valid.protocol)) throw new Error("Можно сохранить только веб-страницу");
  const items = getBookmarks().filter((item) => item.url !== valid.href);
  items.unshift({ title: String(title || valid.hostname).slice(0, 120), url: valid.href, folder: "", source: "bookmark_bar" });
  writeJson("bookmarks.json", { savedAt: Date.now(), items });
  return items;
}

/**
 * Перетащили закладку на место другой — меняем порядок. Порядок хранения и есть порядок показа
 * в панели, отдельного поля для него нет: список короткий, массив — честное представление.
 * beforeUrl пустой — закладка уходит в конец.
 */
function moveBookmark(url, beforeUrl) {
  const items = getBookmarks();
  const from = items.findIndex((item) => item.url === url);
  if (from < 0) return items;
  const [moved] = items.splice(from, 1);
  const to = beforeUrl ? items.findIndex((item) => item.url === beforeUrl) : -1;
  items.splice(to < 0 ? items.length : to, 0, moved);
  writeJson("bookmarks.json", { savedAt: Date.now(), items });
  return items;
}

function removeBookmark(url) {
  const items = getBookmarks().filter((item) => item.url !== url);
  writeJson("bookmarks.json", { savedAt: Date.now(), items });
  return items;
}

/**
 * Полный импорт из Chrome по кнопке. what — какие части импортировать. Для паролей нужен csvPath
 * (человек выбирает файл, экспортированный из Chrome). Возвращает счётчики и понятные ошибки по частям.
 */
function importFromChrome({ profile = "Default", bookmarks = true, passwordsCsv = "" } = {}) {
  const result = { ok: true, bookmarks: null, passwords: null };
  if (bookmarks) {
    const res = importBookmarks(profile);
    if (res.ok) {
      const local = getBookmarks().filter((item) => item.source === "bookmark_bar" && !item.imported);
      const seen = new Set(local.map((item) => item.url));
      const imported = res.items.filter((item) => !seen.has(item.url)).map((item) => ({ ...item, imported: true }));
      writeJson("bookmarks.json", { savedAt: Date.now(), items: [...local, ...imported] });
      result.bookmarks = { count: imported.length };
    }
    else result.bookmarks = { error: res.error };
  }
  if (passwordsCsv) {
    const res = importPasswordsCsv(passwordsCsv);
    result.passwords = res.ok ? { count: res.count } : { error: res.error };
  }
  return result;
}

module.exports = {
  chromeUserDataDir,
  chromeProfiles,
  importFromChrome,
  importBookmarks,
  importPasswordsCsv,
  vaultInfo,
  getBookmarks,
  setBookmark,
  removeBookmark,
  moveBookmark,
  credentialsFor,
};
