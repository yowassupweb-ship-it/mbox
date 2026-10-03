// Загрузки встроенного браузера.
//
// Раньше браузер отменял любую загрузку (will-download → preventDefault): файл нельзя было ни скачать,
// ни сохранить картинку. Теперь файл ложится в папку «Загрузки» под безопасным именем, а интерфейс
// получает события с ходом загрузки и действиями над ней (пауза, отмена, открыть, показать в папке).
// Файл, который система выполняет напрямую (.exe, .cmd, .ps1 …), скачать можно, но открыть из MBOX нельзя —
// только показать в папке: запуск чужого файла из страницы — это запуск кода с сайта.

const fs = require("node:fs");
const path = require("node:path");
const { app, shell } = require("electron");

const RISKY_EXT = new Set([
  ".exe", ".dll", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".lnk", ".msi", ".scr", ".reg",
  ".wsf", ".wsh", ".hta", ".cpl", ".sys", ".jar", ".jse", ".chm", ".apk", ".dmg", ".pkg", ".sh", ".appimage", ".deb", ".rpm",
]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LIST = 60;
const MAX_NAME = 150;

const records = new Map();
const items = new Map();
const saveAsUrls = new Map();
let seq = 0;
let emit = () => {};

/** Имя файла без путей и символов, которые Windows не принимает; пустое имя заменяется на «download». */
function safeFileName(input) {
  let name = String(input || "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  if (name.length > MAX_NAME) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  if (!name) return "download";
  const stem = name.replace(/\.[^.]*$/, "");
  return RESERVED.test(stem) ? `_${name}` : name;
}

/** Свободное имя в папке: «файл.pdf» → «файл (1).pdf» → «файл (2).pdf». */
function uniquePath(dir, name, exists = fs.existsSync) {
  const first = path.join(dir, name);
  // В production fs получает системный путь. Нормализация нужна для адаптеров/тестов,
  // где путь хранится URL-образно, и не меняет проверку настоящей файловой системы.
  const taken = (candidate) => exists(candidate) || exists(candidate.replace(/\\/g, "/"));
  if (!taken(first)) return first;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!taken(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

function isRisky(name) {
  return RISKY_EXT.has(path.extname(String(name || "")).toLowerCase());
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.host : "";
  } catch {
    return "";
  }
}

// Адрес целиком наружу не отдаём: в нём бывают токены доступа. Интерфейсу хватает хоста.
function publicRecord(record) {
  const { id, name, host, path: filePath, received, total, state, paused, risky, startedAt, endedAt, error } = record;
  return { id, name, host, path: filePath, received, total, state, paused, risky, startedAt, endedAt, ...(error ? { error } : {}) };
}

function publish(record) {
  emit({ type: "download", download: publicRecord(record) });
}

function trim() {
  if (records.size <= MAX_LIST) return;
  for (const [id, record] of records) {
    if (records.size <= MAX_LIST) break;
    if (record.state !== "progressing") records.delete(id);
  }
}

/** Следующая загрузка этого адреса спросит, куда сохранить («Сохранить как…»), а не уйдёт в «Загрузки». */
function expectSaveAs(url) {
  saveAsUrls.set(String(url), Date.now() + 30_000);
}

function takeSaveAs(url) {
  const until = saveAsUrls.get(url);
  saveAsUrls.delete(url);
  for (const [key, expires] of saveAsUrls) if (expires < Date.now()) saveAsUrls.delete(key);
  return Boolean(until && until >= Date.now());
}

function attach(browserSession, sendToUi) {
  emit = sendToUi;
  browserSession.on("will-download", (_event, item) => {
    const url = item.getURL();
    const id = ++seq;
    const name = safeFileName(item.getFilename());
    const record = {
      id, name, host: hostOf(url), path: "", received: 0, total: item.getTotalBytes(), state: "progressing",
      paused: false, risky: isRisky(name), startedAt: Date.now(), endedAt: 0,
    };
    if (takeSaveAs(url)) item.setSaveDialogOptions({ title: "Сохранить как", defaultPath: path.join(app.getPath("downloads"), name) });
    else {
      record.path = uniquePath(app.getPath("downloads"), name);
      record.name = path.basename(record.path);
      item.setSavePath(record.path);
    }
    records.set(id, record);
    items.set(id, item);
    trim();
    publish(record);

    let last = 0;
    item.on("updated", (_e, state) => {
      record.state = state === "interrupted" ? "interrupted" : "progressing";
      record.paused = item.isPaused();
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      const saved = item.getSavePath();
      if (saved && saved !== record.path) {
        record.path = saved;
        record.name = path.basename(saved);
        record.risky = isRisky(record.name);
      }
      const now = Date.now();
      if (state === "progressing" && now - last < 250) return;
      last = now;
      publish(record);
    });
    item.once("done", (_e, state) => {
      record.state = state;
      record.paused = false;
      record.endedAt = Date.now();
      record.received = state === "completed" ? item.getReceivedBytes() : record.received;
      const saved = item.getSavePath();
      if (saved) { record.path = saved; record.name = path.basename(saved); record.risky = isRisky(record.name); }
      if (state === "interrupted") record.error = "Загрузка прервана";
      items.delete(id);
      publish(record);
    });
  });
}

/** Файл, который сохранили без загрузки (страница целиком, PDF), — тоже в список: его можно открыть и показать в папке. */
function addSaved(filePath) {
  const id = ++seq;
  const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
  const record = {
    id, name: path.basename(filePath), host: "", path: filePath, received: size, total: size, state: "completed",
    paused: false, risky: isRisky(filePath), startedAt: Date.now(), endedAt: Date.now(),
  };
  records.set(id, record);
  trim();
  publish(record);
  return publicRecord(record);
}

function list() {
  return [...records.values()].map(publicRecord).reverse();
}

async function act(id, action) {
  const record = records.get(Number(id));
  if (!record) return { ok: false, error: "Загрузка уже убрана из списка" };
  const item = items.get(record.id);
  if (action === "pause") { item?.pause(); record.paused = true; publish(record); return { ok: true }; }
  if (action === "resume") { if (item?.canResume()) item.resume(); record.paused = false; publish(record); return { ok: true }; }
  if (action === "cancel") { item?.cancel(); return { ok: true }; }
  if (action === "remove") {
    if (record.state === "progressing") return { ok: false, error: "Сначала отмените загрузку" };
    records.delete(record.id);
    emit({ type: "download", download: { ...publicRecord(record), state: "removed" } });
    return { ok: true };
  }
  if (action === "reveal") {
    if (!record.path || !fs.existsSync(record.path)) return { ok: false, error: "Файл перемещён или удалён" };
    shell.showItemInFolder(record.path);
    return { ok: true };
  }
  if (action === "open") {
    if (record.state !== "completed") return { ok: false, error: "Загрузка ещё не завершена" };
    if (record.risky) return { ok: false, error: "Исполняемые файлы из MBOX не открываются — используйте «Показать в папке»" };
    if (!record.path || !fs.existsSync(record.path)) return { ok: false, error: "Файл перемещён или удалён" };
    const error = await shell.openPath(record.path);
    return error ? { ok: false, error } : { ok: true };
  }
  return { ok: false, error: `Неизвестное действие: ${action}` };
}

function clearFinished() {
  for (const [id, record] of records) {
    if (record.state === "progressing") continue;
    records.delete(id);
    emit({ type: "download", download: { ...publicRecord(record), state: "removed" } });
  }
  return { ok: true };
}

async function openFolder() {
  const error = await shell.openPath(app.getPath("downloads"));
  return error ? { ok: false, error } : { ok: true };
}

module.exports = { attach, addSaved, list, act, clearFinished, openFolder, expectSaveAs, safeFileName, uniquePath, isRisky };
