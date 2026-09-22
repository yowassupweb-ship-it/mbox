const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog, clipboard } = require("electron");
const { autoUpdater } = require("electron-updater");
const localUi = require("./localUi");
const serverState = require("./server-state");
const browser = require("./browser");
const chromeImport = require("./import-chrome");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isDev = !app.isPackaged;
const repoRoot = resolveRepoRoot();
const packagedScriptRoot = path.join(process.resourcesPath || "", "scripts");
const mboxUrl = (process.env.MBOX_URL || "https://mbox.shar-os.ru").replace(/\/+$/, "");
const responderEnv = loadResponderEnv();
const updateFeedUrl = `${mboxUrl}/downloads/`;
const iconPath = path.join(__dirname, "resources", "mbox.png");
const processPatterns = {
  Codex: "codex-chat-watcher.mjs",
  Claude: "claude-inbox-watcher.mjs"
};

// Встроенный интерфейс (ui/) вместо загрузки сайта — см. localUi.js. Схему регистрируем до ready.
const useLocalUi = localUi.localUiAvailable();
if (useLocalUi) localUi.registerSchemePrivileges();

let mainWindow = null;
let tray = null;
let tracked = new Map();
let updatePromptOpen = false;
let processStatusCache = { at: 0, rows: [] };
let processStatusInFlight = null;
const PROCESS_STATUS_CACHE_MS = 2500;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (useLocalUi) {
    localUi.installLocalUi(mboxUrl);
    await localUi.prepareStorageMigration(mboxUrl);
  }
  createWindow();
  createTray();
  setMenu();
  setupAutoUpdates();
  if (process.env.MBOX_DESKTOP_SKIP_AGENT_AUTOSTART !== "1") {
    await startResponders({ reveal: false }).catch((error) => log(`autostart responders failed: ${error.message}`));
  }
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  app.isQuitting = true;
});

function resolveRepoRoot() {
  const candidates = [
    process.env.MBOX_REPO_ROOT,
    isDev ? path.resolve(__dirname, "..") : "",
    path.join(os.homedir(), "Desktop", "Mbox", "memora", "memora-graph"),
    path.join(os.homedir(), "Desktop", "MBOX", "memora", "memora-graph"),
    path.resolve(__dirname, "..")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "scripts", "start-codex-responder.cmd"))) return candidate;
  }
  return isDev ? path.resolve(__dirname, "..") : process.resourcesPath;
}

function loadResponderEnv() {
  const env = {
    MBOX_URL: mboxUrl,
    MBOX_USERNAME: "Admin",
    ...readDotEnv(path.join(repoRoot, ".env.local")),
    ...readCodexMboxEnv(),
    ...process.env
  };
  return env;
}

function readDotEnv(file) {
  const result = {};
  if (!file || !fs.existsSync(file)) return result;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return result;
}

function readCodexMboxEnv() {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  const result = {};
  if (!fs.existsSync(file)) return result;
  const text = fs.readFileSync(file, "utf8");
  const block = text.match(/\[mcp_servers\.mbox-prod\][\s\S]*?(?=\n\[|$)/);
  if (block) {
    const envLine = block[0].match(/env\s*=\s*\{([^}]+)\}/);
    if (envLine) {
      for (const pair of envLine[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
        result[pair[1]] = unescapeTomlString(pair[2]);
      }
    }
  }
  const envBlock = text.match(/\[mcp_servers\.mbox-prod\.env\][\s\S]*?(?=\n\[|$)/);
  if (envBlock) {
    for (const pair of envBlock[0].matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/gm)) {
      result[pair[1]] = unescapeTomlString(pair[2]);
    }
  }
  return result;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function unescapeTomlString(value) {
  return value.replace(/\\(["\\btnfr])/g, (_, char) => {
    const escapes = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };
    return escapes[char] || char;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Размер, положение, развёрнутость и масштаб окна переживают перезапуск: раньше окно каждый раз
// открывалось 1360×900 в центре со сброшенным масштабом.
const WINDOW_STATE = () => path.join(app.getPath("userData"), "window-state.json");
const ZOOM_STEP = 0.1;

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE(), "utf8"));
    const { screen } = require("electron");
    const bounds = { x: Number(state.x), y: Number(state.y), width: Number(state.width), height: Number(state.height) };
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return { zoom: Number(state.zoom) || 1 };
    // Монитор, на котором было окно, могли отключить — тогда не восстанавливаем координаты.
    const area = screen.getDisplayMatching(bounds).workArea;
    const visible = bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 20 && bounds.y < area.y + area.height - 80;
    return { ...(visible ? bounds : { width: bounds.width, height: bounds.height }), maximized: Boolean(state.maximized), zoom: Number(state.zoom) || 1 };
  } catch {
    return { zoom: 1 };
  }
}

let windowStateTimer = null;
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    // Для развёрнутого окна храним обычные границы, чтобы «восстановить» вернуло прежний размер.
    const bounds = maximized || mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const state = { ...bounds, maximized, zoom: Math.round(mainWindow.webContents.getZoomFactor() * 100) / 100 };
    try { fs.writeFileSync(WINDOW_STATE(), JSON.stringify(state)); } catch {}
  }, 400);
}

function setZoom(next) {
  if (!mainWindow) return;
  const factor = next === null ? 1 : Math.max(0.5, Math.min(2, Math.round((mainWindow.webContents.getZoomFactor() + next) * 100) / 100));
  mainWindow.webContents.setZoomFactor(factor);
  saveWindowState();
}

function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 900,
    ...(Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 980,
    minHeight: 640,
    title: "MBOX Desktop",
    icon: iconPath,
    // Не autoHideMenuBar: с ним Alt (в том числе Alt+Shift при смене раскладки) показывал меню окна —
    // окно дёргалось, фокус уходил в меню и курсор пропадал из заметки. Меню скрыто насовсем ниже,
    // его горячие клавиши (Ctrl+R, масштаб, DevTools) продолжают работать.
    autoHideMenuBar: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--mbox-server=${mboxUrl}`, `--mbox-local-ui=${useLocalUi ? "1" : "0"}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Встроенный браузер: его страницы живут поверх окна, поэтому он привязывается к окну сразу
  // после создания и умирает вместе с ним.
  browser.attach(mainWindow, (payload) => mainWindow.webContents.send("mbox-desktop:browser", payload));

  // Сквозная сессия: забираем с сервера куки сайтов (до того, как человек откроет первую вкладку),
  // и дальше досылаем изменения. Проверка доступности — она же проверка, что вход в MBOX есть.
  serverState.configure(mboxUrl);
  void serverState.probe().then(async (on) => {
    if (!on) return;
    await serverState.restoreCookies(browser.PARTITION).catch(() => {});
    serverState.watchCookies(browser.PARTITION);
  });

  mainWindow.setMenuBarVisibility(false);
  if (saved.maximized) mainWindow.maximize();
  for (const event of ["resize", "move", "maximize", "unmaximize"]) mainWindow.on(event, saveWindowState);
  mainWindow.webContents.on("did-finish-load", () => mainWindow?.webContents.setZoomFactor(saved.zoom || 1));
  // Ctrl+колесо меняет масштаб мимо меню — ловим и сохраняем тоже.
  mainWindow.webContents.on("zoom-changed", (_event, direction) => setZoom(direction === "in" ? ZOOM_STEP : -ZOOM_STEP));
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} MBOXDesktop/${app.getVersion()}`);
  mainWindow.loadURL(withDesktopFlag(useLocalUi ? `${localUi.APP_ORIGIN}/` : mboxUrl));
  // Ссылки наружу (документация, github, сайт) — в браузер, а не новым окном приложения с мостом.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const inside = useLocalUi ? url.startsWith(`${localUi.APP_ORIGIN}/`) : url.startsWith(mboxUrl);
    if (inside) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  mainWindow.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    saveWindowState();
    mainWindow.hide();
  });
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip("MBOX Desktop");
  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть MBOX", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "Запустить агентов", click: () => startResponders() },
    { label: "Остановить агентов", click: () => stopResponders() },
    { label: "Статус агентов", click: async () => showStatusDialog() },
    { type: "separator" },
    { label: "Выйти", click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "MBOX",
      submenu: [
        { label: "Обновить вебку", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.reload() },
        { label: "Открыть в браузере", click: () => shell.openExternal(mboxUrl) },
        { label: "Проверить обновления", click: () => checkForUpdates(true) },
        { type: "separator" },
        { label: "Открыть репозиторий", click: () => shell.openPath(repoRoot) },
        { type: "separator" },
        { label: "Включить автозапуск приложения", click: () => installAppAutostart() },
        { label: "Отключить автозапуск приложения", click: () => removeAppAutostart() },
        { type: "separator" },
        { label: "Выйти", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: "Агенты",
      submenu: [
        { label: "Запустить ChatGPT", click: () => startResponder("Codex") },
        { label: "Запустить Claude", click: () => startResponder("Claude") },
        { label: "Запустить обоих", click: () => startResponders() },
        { type: "separator" },
        { label: "Остановить ChatGPT", click: () => stopResponder("Codex") },
        { label: "Остановить Claude", click: () => stopResponder("Claude") },
        { label: "Остановить обоих", click: () => stopResponders() },
        { type: "separator" },
        { label: "Включить автозапуск", click: () => installResponderAutostart() },
        { label: "Отключить автозапуск", click: () => removeResponderAutostart() },
        { type: "separator" },
        { label: "Показать статус", click: () => showStatusDialog() }
      ]
    },
    {
      label: "Вид",
      submenu: [
        { role: "toggleDevTools" },
        { label: "Масштаб 100%", accelerator: "CmdOrCtrl+0", click: () => setZoom(null) },
        { label: "Крупнее", accelerator: "CmdOrCtrl+=", click: () => setZoom(ZOOM_STEP) },
        { label: "Крупнее", accelerator: "CmdOrCtrl+Plus", visible: false, click: () => setZoom(ZOOM_STEP) },
        { label: "Мельче", accelerator: "CmdOrCtrl+-", click: () => setZoom(-ZOOM_STEP) }
      ]
    }
  ]));
}

function wrapperPath(name) {
  const file = name === "Codex" ? "start-codex-responder.cmd" : "start-claude-responder.cmd";
  const repoPath = path.join(repoRoot, "scripts", file);
  const packagedPath = path.join(packagedScriptRoot, file);
  return fs.existsSync(repoPath) ? repoPath : packagedPath;
}

async function startResponders(options = {}) {
  const results = [];
  results.push(await startResponder("Codex", options));
  results.push(await startResponder("Claude", options));
  return results;
}

async function startResponder(name, { reveal = true } = {}) {
  if ((await processStatus()).some((item) => item.agent === name)) return { agent: name, status: "already-running" };
  const file = wrapperPath(name);
  if (!fs.existsSync(file)) throw new Error(`${name} wrapper not found: ${file}`);
  const workdir = fs.existsSync(path.join(repoRoot, "package.json")) ? repoRoot : path.dirname(path.dirname(file));
  const env = {
    ...process.env,
    ...responderEnv,
    MBOX_AGENT_NAME: name,
    MBOX_PROJECT: responderEnv.MBOX_PROJECT || process.env.MBOX_PROJECT || "MBOX",
    CODEX_WATCH_WORKDIR: responderEnv.CODEX_WATCH_WORKDIR || repoRoot,
    CLAUDE_WATCH_WORKDIR: responderEnv.CLAUDE_WATCH_WORKDIR || repoRoot
  };
  // Дефолтный путь установки — "...\Local\Programs\MBOX Desktop\..." — содержит пробел. shell:true
  // конкатенирует argv в одну строку БЕЗ экранирования (см. предупреждение Node про DEP0190), так что
  // невзятый в кавычки путь резался по пробелу в "MBOX Desktop" и cmd.exe получал "MBOX" как команду —
  // responder падал мгновенно с "не является внутренней командой", молча (stdio: "ignore" глушил и это).
  // Раньше responder уходил в отсоединённый процесс с выводом только в лог-файл, а CLI агентов,
  // которые он запускает, всплывали отдельными окнами консоли. Теперь вывод идёт в сессию —
  // её показывает встроенная консоль MBOX (и дублируется в лог-файл, как раньше).
  // /s /c ""путь"": cmd снимает внешнюю пару кавычек, путь с пробелом ("MBOX Desktop") остаётся целым.
  const logFile = path.join(app.getPath("userData"), "responder-logs", `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `""${file}""`], {
    cwd: workdir,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  tracked.set(name, child);
  invalidateProcessStatus();
  startSession({
    id: `agent:${name}`,
    kind: "agent",
    title: `${name} · наблюдатель`,
    command: file,
    cwd: workdir,
    child,
    reveal,
    logFile,
    onExit: (code, signal) => {
      tracked.delete(name);
      invalidateProcessStatus();
      log(`${name} responder exited code=${code ?? ""} signal=${signal ?? ""}`);
    }
  });
  log(`started ${name} responder from ${file}`);
  return { agent: name, status: "started", script: file };
}

async function stopResponders() {
  await stopResponder("Codex");
  await stopResponder("Claude");
}

async function stopResponder(name) {
  const pattern = processPatterns[name];
  markStopped(`agent:${name}`);
  const matches = (await processStatus()).filter((item) => item.agent === name);
  for (const item of matches) await killPid(item.pid);
  const child = tracked.get(name);
  if (child && !child.killed) killTree(child.pid);
  tracked.delete(name);
  invalidateProcessStatus();
  log(`stopped ${name} responder (${pattern})`);
}

function processStatus() {
  const now = Date.now();
  if (now - processStatusCache.at < PROCESS_STATUS_CACHE_MS) {
    return Promise.resolve(processStatusCache.rows);
  }
  if (processStatusInFlight) return processStatusInFlight;
  processStatusInFlight = readProcessStatus().finally(() => {
    processStatusInFlight = null;
  });
  return processStatusInFlight;
}

function readProcessStatus() {
  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match 'node' -and $_.CommandLine -match 'codex-chat-watcher|claude-inbox-watcher' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) {
        processStatusCache = { at: Date.now(), rows: [] };
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const result = rows.map((row) => ({
          pid: row.ProcessId,
          commandLine: row.CommandLine,
          agent: /codex-chat-watcher/i.test(row.CommandLine || "") ? "ChatGPT" : "Claude"
        }));
        processStatusCache = { at: Date.now(), rows: result };
        resolve(result);
      } catch {
        processStatusCache = { at: Date.now(), rows: [] };
        resolve([]);
      }
    });
  });
}

function invalidateProcessStatus() {
  processStatusCache = { at: 0, rows: [] };
}

function killPid(pid) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`], { windowsHide: true }, () => resolve());
  });
}

async function installResponderAutostart() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  for (const name of ["Codex", "Claude"]) {
    const value = `cmd.exe /d /c start "" /min "${wrapperPath(name)}"`;
    await reg(["add", key, "/v", `MBOX ${name} Responder`, "/t", "REG_SZ", "/d", value, "/f"]);
  }
  dialog.showMessageBox(mainWindow, { type: "info", message: "Автозапуск локальных агентов включён." });
}

async function removeResponderAutostart() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  await reg(["delete", key, "/v", "MBOX Codex Responder", "/f"]).catch(() => {});
  await reg(["delete", key, "/v", "MBOX Claude Responder", "/f"]).catch(() => {});
  dialog.showMessageBox(mainWindow, { type: "info", message: "Автозапуск локальных агентов отключён." });
}

async function installAppAutostart() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const value = app.isPackaged
    ? `cmd.exe /d /c start "" /min "${process.execPath}"`
    : `cmd.exe /d /c start "" /min node "${path.join(__dirname, "launch.js")}"`;
  await reg(["add", key, "/v", "MBOX Desktop", "/t", "REG_SZ", "/d", value, "/f"]);
  dialog.showMessageBox(mainWindow, { type: "info", message: "Автозапуск MBOX Desktop включён." });
}

async function removeAppAutostart() {
  await reg(["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "MBOX Desktop", "/f"]).catch(() => {});
  dialog.showMessageBox(mainWindow, { type: "info", message: "Автозапуск MBOX Desktop отключён." });
}

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function showStatusDialog() {
  const rows = await processStatus();
  const message = rows.length
    ? rows.map((row) => `${row.agent}: pid ${row.pid}`).join("\n")
    : "Локальные агенты не запущены.";
  dialog.showMessageBox(mainWindow, { type: "info", title: "Локальные агенты MBOX", message });
}

function log(message) {
  console.log(`[MBOX Desktop] ${message}`);
  mainWindow?.webContents.send("mbox-desktop:event", { type: "log", message, at: new Date().toISOString() });
}

function withDesktopFlag(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("mboxDesktop", "1");
  return url.toString();
}

function setupAutoUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: "generic", url: updateFeedUrl });
  autoUpdater.on("checking-for-update", () => updateStatus("checking", "Проверяю обновления"));
  autoUpdater.on("update-available", (info) => {
    const message = `Доступна версия ${info.version || ""}`.trim();
    updateStatus("available", message);
    // Проверка теперь периодическая — сообщаем о каждой версии один раз, а не на каждой проверке.
    if (announcedUpdateVersion === info.version) return;
    announcedUpdateVersion = info.version;
    showUpdateNotice("info", "MBOX Desktop: найдено обновление", `${message}. Скачиваю в фоне.`);
  });
  autoUpdater.on("update-not-available", () => updateStatus("current", "Установлена свежая версия"));
  autoUpdater.on("download-progress", (progress) => updateStatus("downloading", `Скачиваю обновление ${Math.round(progress.percent || 0)}%`));
  autoUpdater.on("update-downloaded", (info) => {
    updateStatus("ready", `Обновление ${info.version || ""} готово к установке`.trim());
    if (promptedUpdateVersion === info.version) return;
    promptedUpdateVersion = info.version;
    showUpdateInstallPrompt(info);
  });
  autoUpdater.on("error", (error) => {
    updateStatus("error", `Обновление: ${error.message}`);
    // Фоновые проверки без сети не должны каждые полчаса открывать окно ошибки.
    if (manualUpdateCheck) showUpdateNotice("error", "MBOX Desktop: обновление не проверилось", error.message);
  });
  if (app.isPackaged) {
    // Раньше проверка была только при запуске: приложение, открытое весь день, новую версию не видело до перезапуска.
    setTimeout(() => checkForUpdates(false), 5000);
    setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
    app.on("browser-window-focus", () => {
      if (Date.now() - lastUpdateCheckAt > UPDATE_FOCUS_CHECK_MS) checkForUpdates(false);
    });
  }
}

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_FOCUS_CHECK_MS = 10 * 60 * 1000;
let lastUpdateCheckAt = 0;
let manualUpdateCheck = false;
let announcedUpdateVersion = "";
let promptedUpdateVersion = "";

function showUpdateNotice(type, message, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  dialog.showMessageBox(mainWindow, { type, message, detail }).catch(() => {});
}

function showUpdateInstallPrompt(info) {
  if (!mainWindow || mainWindow.isDestroyed() || updatePromptOpen) return;
  updatePromptOpen = true;
  if (!mainWindow.isVisible()) mainWindow.show();
  dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Установить сейчас", "Позже"],
      defaultId: 0,
      cancelId: 1,
      message: "Обновление MBOX Desktop скачано.",
      detail: "Приложение перезапустится и установит новую версию.",
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    }).catch(() => {}).finally(() => { updatePromptOpen = false; });
}

function updateStatus(status, message) {
  log(message);
  mainWindow?.webContents.send("mbox-desktop:event", { type: "update", status, message, at: new Date().toISOString() });
}

async function checkForUpdates(manual) {
  if (!app.isPackaged) {
    const message = "Обновления доступны в установленном MBOX Desktop";
    updateStatus("dev", message);
    if (manual) dialog.showMessageBox(mainWindow, { type: "info", message });
    return { ok: false, reason: "dev" };
  }
  lastUpdateCheckAt = Date.now();
  manualUpdateCheck = manual;
  if (manual) promptedUpdateVersion = "";
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null };
  } catch (error) {
    updateStatus("error", `Не удалось проверить обновления: ${error.message}`);
    if (manual) dialog.showMessageBox(mainWindow, { type: "error", message: "Не удалось проверить обновления", detail: error.message });
    return { ok: false, error: error.message };
  }
}

ipcMain.handle("mbox-desktop:status", async () => processStatus());
ipcMain.handle("mbox-desktop:start", async (_event, name) => {
  if (name === "All") await startResponders();
  else if (name === "Codex" || name === "Claude") await startResponder(name);
  await sleep(1200);
  return processStatus();
});
ipcMain.handle("mbox-desktop:stop", async (_event, name) => {
  if (name === "All") await stopResponders();
  else if (name === "Codex" || name === "Claude") await stopResponder(name);
  return processStatus();
});
// Агент, запущенный вне приложения (автозапуск Windows, старая версия), не отдаёт вывод —
// перезапуск переносит его внутрь, в сессию консоли.
ipcMain.handle("mbox-desktop:restart-agent", async (_event, name) => {
  if (name !== "Codex" && name !== "Claude") throw new Error("Неизвестный агент");
  await stopResponder(name);
  await sleep(600);
  await startResponder(name);
  return processStatus();
});
ipcMain.handle("mbox-desktop:ssh-start", async (_event, target, cols, rows) => startSshSession(target, cols, rows));
ipcMain.handle("mbox-desktop:session-resize", async (_event, id, cols, rows) => resizeSession(String(id || ""), cols, rows));
ipcMain.handle("mbox-desktop:sessions", async () => listSessions());
ipcMain.handle("mbox-desktop:session-input", async (_event, id, input) => sendSessionInput(String(id || ""), String(input ?? "")));
ipcMain.handle("mbox-desktop:session-stop", async (_event, id) => stopSession(String(id || "")));
ipcMain.handle("mbox-desktop:session-remove", async (_event, id) => removeSession(String(id || "")));
ipcMain.handle("mbox-desktop:install-autostart", async () => installResponderAutostart());
ipcMain.handle("mbox-desktop:remove-autostart", async () => removeResponderAutostart());
ipcMain.handle("mbox-desktop:install-app-autostart", async () => installAppAutostart());
ipcMain.handle("mbox-desktop:remove-app-autostart", async () => removeAppAutostart());
ipcMain.handle("mbox-desktop:open-repo", async () => shell.openPath(repoRoot));
ipcMain.handle("mbox-desktop:open-path", async (_event, targetPath) => openAllowedPath(targetPath));
ipcMain.handle("mbox-desktop:check-updates", async () => checkForUpdates(true));

// Встроенный браузер. Страница интерфейса называет вкладку своим ключом и присылает прямоугольник,
// куда положить сайт; адрес, заголовок и кнопки «назад/вперёд» возвращаются обратно событиями.
function assertBrowserHost(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Недоступно для сайта");
}
ipcMain.handle("mbox-desktop:browser-open", async (event, key, url) => { assertBrowserHost(event); return browser.open(String(key), String(url || "")); });
ipcMain.handle("mbox-desktop:browser-bounds", async (event, key, bounds) => {
  assertBrowserHost(event);
  browser.setBounds(String(key), {
    x: Number(bounds?.x) || 0,
    y: Number(bounds?.y) || 0,
    width: Number(bounds?.width) || 0,
    height: Number(bounds?.height) || 0,
  });
  return { ok: true };
});
ipcMain.handle("mbox-desktop:browser-show", async (event, key) => { assertBrowserHost(event); browser.show(key ? String(key) : null); return { ok: true }; });
ipcMain.handle("mbox-desktop:browser-hide", async (event, key) => { assertBrowserHost(event); browser.hide(String(key)); return { ok: true }; });
ipcMain.handle("mbox-desktop:browser-close", async (event, key) => { assertBrowserHost(event); browser.close(String(key)); return { ok: true }; });
ipcMain.handle("mbox-desktop:browser-capture", async (event, key) => { assertBrowserHost(event); return browser.capture(String(key)); });
ipcMain.handle("mbox-desktop:browser-act", async (event, key, command, payload) => { assertBrowserHost(event); return browser.act(String(key), String(command), payload); });
// Закладки, история и куки живут на сервере (server/browser-state.mjs) — так они одни и те же на
// всех компьютерах. Локальный файл остаётся запасным: без сети браузер обязан работать.
ipcMain.handle("mbox-desktop:browser-bookmarks", async (event) => {
  assertBrowserHost(event);
  if (serverState.isOn()) {
    try { return await serverState.bookmarks(); } catch { /* сеть моргнула — отдаём локальные */ }
  }
  return chromeImport.getBookmarks();
});
ipcMain.handle("mbox-desktop:browser-history", async (event, search, limit) => {
  assertBrowserHost(event);
  if (!serverState.isOn()) return [];
  try { return await serverState.history(String(search || ""), Number(limit) || 300); } catch { return []; }
});
ipcMain.handle("mbox-desktop:browser-history-clear", async (event, url) => {
  assertBrowserHost(event);
  if (serverState.isOn()) await serverState.clearHistory(String(url || "")).catch(() => {});
  return { ok: true };
});
// Закладки одни на всё приложение, а панель закладок рисует каждая вкладка браузера своим списком.
// Поэтому после правки рассылаем новый список всем вкладкам сразу, а не ждём их следующего открытия.
function publishBookmarks(list) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mbox-desktop:browser", { type: "bookmarks", bookmarks: list });
  return list;
}
ipcMain.handle("mbox-desktop:browser-bookmark-add", async (event, bookmark) => {
  assertBrowserHost(event);
  // Локальную копию ведём всегда: она же список на случай потери связи с MBOX.
  const local = chromeImport.setBookmark(bookmark || {});
  if (serverState.isOn()) {
    try { return publishBookmarks(await serverState.addBookmark(bookmark || {})); } catch { /* ниже отдадим локальные */ }
  }
  return publishBookmarks(local);
});
ipcMain.handle("mbox-desktop:browser-bookmark-remove", async (event, url) => {
  assertBrowserHost(event);
  const local = chromeImport.removeBookmark(String(url || ""));
  if (serverState.isOn()) {
    try { return publishBookmarks(await serverState.removeBookmark(String(url || ""))); } catch { /* ниже отдадим локальные */ }
  }
  return publishBookmarks(local);
});
ipcMain.handle("mbox-desktop:browser-chrome-profiles", async (event) => { assertBrowserHost(event); return chromeImport.chromeProfiles(); });
ipcMain.handle("mbox-desktop:browser-import-bookmarks", async (event, profile) => {
  assertBrowserHost(event);
  const result = chromeImport.importFromChrome({ profile: String(profile || "Default"), bookmarks: true, history: false });
  const local = chromeImport.getBookmarks();
  // Импорт с этой машины тоже уезжает на сервер: на втором компьютере повторять его не придётся.
  if (serverState.isOn()) {
    try { publishBookmarks(await serverState.importBookmarks(local)); return result; } catch { /* ниже отдадим локальные */ }
  }
  publishBookmarks(local);
  return result;
});
ipcMain.handle("mbox-desktop:browser-import-passwords", async (event) => {
  assertBrowserHost(event);
  const choice = await dialog.showOpenDialog(mainWindow, { title: "Импорт паролей из Chrome", properties: ["openFile"], filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
  return chromeImport.importPasswordsCsv(choice.filePaths[0]);
});
ipcMain.handle("mbox-desktop:browser-credentials", async (event, url) => {
  assertBrowserHost(event);
  return chromeImport.credentialsFor(String(url || "")).map((entry) => ({ username: entry.username }));
});
ipcMain.handle("mbox-desktop:browser-fill-password", async (event, key, username) => {
  assertBrowserHost(event);
  return browser.fillPassword(String(key), String(username));
});
ipcMain.handle("mbox-desktop:install-update", async () => {
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

async function openAllowedPath(targetPath) {
  const requested = path.resolve(String(targetPath || ""));
  const allowedRoots = [
    repoRoot,
    path.join(os.homedir(), "Desktop", "Mbox"),
    path.join(os.homedir(), "Desktop", "MBOX")
  ].map((item) => path.resolve(item).toLowerCase());
  const normalized = requested.toLowerCase();
  const allowed = allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error("Path is outside the MBOX workspace");
  if (!fs.existsSync(requested)) throw new Error(`Path not found: ${requested}`);
  const error = await shell.openPath(requested);
  if (error) throw new Error(error);
  return { ok: true, path: requested };
}

// --- Сессии встроенной консоли ---------------------------------------------------------------
//
// Процесс, который MBOX запускает сам (агент-наблюдатель, команда инструмента), становится сессией:
// вывод буферизуется здесь и транслируется в окно, консоль MBOX показывает его во вкладке-панели.
// Ввода в процессы нет сознательно: окно грузит удалённую страницу, и stdin/«свой терминал» из неё
// превратили бы любую XSS на сайте в выполнение команд на этом компьютере.

const sessions = new Map();
const SESSION_LINE_LIMIT = 2000;

function sessionMeta(session) {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    command: session.command,
    cwd: session.cwd,
    pid: session.child?.pid ?? session.pty?.pid ?? null,
    terminal: session.kind === "ssh",
    status: session.status,
    code: session.code,
    startedAt: session.startedAt,
    endedAt: session.endedAt
  };
}

function emitSession(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("mbox-desktop:session", { at: new Date().toISOString(), ...payload });
}

function startSession({ id, kind, title, command, cwd, child, reveal = true, logFile = "", onLine, onExit }) {
  const previous = sessions.get(id);
  if (previous?.status === "running" && previous.child && previous.child !== child) killTree(previous.child.pid);
  const session = { id, kind, title, command, cwd, child, lines: [], status: "running", code: null, startedAt: Date.now(), endedAt: null };
  sessions.set(id, session);
  const logStream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  emitSession({ id, event: "started", reveal, session: sessionMeta(session) });

  function push(stream, chunk) {
    const text = decodeConsole(chunk);
    logStream?.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const clean = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      session.lines.push({ stream, line: clean });
      if (session.lines.length > SESSION_LINE_LIMIT) session.lines.shift();
      emitSession({ id, event: "output", stream, line: clean });
      onLine?.(stream, clean);
    }
  }

  child.stdout?.on("data", (chunk) => push("out", chunk));
  child.stderr?.on("data", (chunk) => push("err", chunk));
  child.on("error", (error) => {
    session.status = "failed";
    session.endedAt = Date.now();
    emitSession({ id, event: "failed", message: error.message, session: sessionMeta(session) });
    logStream?.end();
  });
  child.on("exit", (code, signal) => {
    if (sessions.get(id) !== session) return;
    // taskkill завершает процесс с кодом 4294967295 (-1) — остановку человеком показываем словом, не кодом.
    session.status = session.stopRequested ? "stopped" : "exited";
    session.code = session.stopRequested ? null : code ?? signal ?? null;
    session.endedAt = Date.now();
    emitSession({ id, event: "exited", code: session.code, session: sessionMeta(session) });
    logStream?.end();
    onExit?.(code, signal);
  });
  return session;
}

function markStopped(id) {
  const session = sessions.get(id);
  if (session?.status === "running") {
    session.stopRequested = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function listSessions() {
  return [...sessions.values()].map((session) => ({ ...sessionMeta(session), lines: session.lines.slice(-500), buffer: session.kind === "ssh" ? session.buffer : undefined }));
}

function sendSessionInput(id, input) {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return { ok: false, reason: "session is not running" };
  if (session.kind !== "ssh" || !session.pty) return { ok: false, reason: "interactive input is only enabled for SSH sessions" };
  session.pty.write(input);
  return { ok: true };
}

function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session?.pty || session.status !== "running") return { ok: false };
  const safeCols = Math.max(20, Math.min(500, Math.floor(Number(cols) || 0)));
  const safeRows = Math.max(5, Math.min(200, Math.floor(Number(rows) || 0)));
  session.cols = safeCols;
  session.rows = safeRows;
  try { session.pty.resize(safeCols, safeRows); } catch { return { ok: false }; }
  return { ok: true };
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => {});
  } catch {
    // процесс уже завершился
  }
}

async function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: "нет такой сессии" };
  if (id.startsWith("agent:")) {
    await stopResponder(id.slice(6));
    return { ok: true };
  }
  if (id.startsWith("tool:")) return stopTool(id.slice(5));
  if (session.status === "running") {
    markStopped(id);
    if (session.pty) {
      try { session.pty.kill(); } catch { killTree(session.pty.pid); }
    } else {
      if (session.kind === "ssh") {
        session.status = "stopped";
        session.endedAt = Date.now();
        emitSession({ id, event: "exited", code: null, session: sessionMeta(session) });
      } else {
        killTree(session.child?.pid);
      }
    }
  }
  return { ok: true };
}

function removeSession(id) {
  const session = sessions.get(id);
  if (!session) return { ok: true };
  if (session.status === "running") return { ok: false, reason: "сессия ещё работает — сначала остановите" };
  sessions.delete(id);
  emitSession({ id, event: "removed" });
  return { ok: true };
}

// --- Локальные рабочие папки ------------------------------------------------------------------
//
// Папку подключает человек через системный диалог — из страницы путь не принимается. Страница
// оперирует только ключом папки и относительным путём; всё, что выходит за корень, отклоняется.
// Запись запрещена в .git и в файлы, которые Windows выполняет напрямую (.exe, .cmd, .ps1 …):
// окно грузит удалённую страницу, и подмена такого файла была бы готовым запуском кода.

function normalizeSshTarget(raw) {
  const value = String(raw || "").trim();
  const cleaned = value.replace(/^ssh\s+/i, "").trim();
  // Первый символ не «-»: иначе адрес читался бы ssh как ключ командной строки.
  if (!/^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9._][A-Za-z0-9._-]*(?::[0-9]{1,5})?$/.test(cleaned)) {
    throw new Error("SSH: укажите host, user@host или user@host:port");
  }
  const [hostPart, portPart] = cleaned.split(":");
  const port = portPart ? Number(portPart) : null;
  if (portPart && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("SSH: порт должен быть от 1 до 65535");
  return { target: hostPart, port, label: cleaned };
}

// SSH идёт через псевдотерминал (node-pty, ConPTY в Windows), а не через трубы: без терминала ssh не может
// спросить пароль и ключевую фразу, а удалённая оболочка не получает TTY — ни Tab, ни vim, ни Ctrl+C.
// Страница рисует поток в xterm.js; буфер хранит хвост вывода, чтобы панель, открытая позже, увидела экран.
const SSH_BUFFER_LIMIT = 256 * 1024;
const SSH_RECONNECT_MIN_MS = 2000;
const SSH_RECONNECT_MAX_MS = 15000;

function sshJumpHost() {
  const host = responderEnv.MBOX_SSH_HOST || (() => { try { return new URL(mboxUrl).hostname; } catch { return ""; } })();
  if (!host) return "";
  return responderEnv.MBOX_SSH_JUMP || `${responderEnv.MBOX_SSH_USER || "root"}@${host}`;
}

function sshArgs(target, port) {
  const args = [
    "-tt",
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "ConnectTimeout=12"
  ];
  const jump = sshJumpHost();
  const targetHost = target.split("@").pop().toLowerCase();
  const jumpHost = jump.split("@").pop().toLowerCase();
  if (jump && targetHost !== jumpHost) args.push("-J", jump);
  if (port) args.push("-p", String(port));
  args.push(target);
  return args;
}

function appendSshData(session, data) {
  session.buffer += data;
  if (session.buffer.length > SSH_BUFFER_LIMIT) session.buffer = session.buffer.slice(-SSH_BUFFER_LIMIT);
  emitSession({ id: session.id, event: "data", data });
}

function connectSshSession(session) {
  if (session.stopRequested || sessions.get(session.id) !== session) return;
  const pty = require("node-pty");
  let term;
  try {
    term = pty.spawn("ssh.exe", sshArgs(session.target, session.port), {
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" }
    });
  } catch (error) {
    appendSshData(session, `\r\n\x1b[33m— SSH не запустился: ${error.message}. Повторю подключение. —\x1b[0m\r\n`);
    scheduleSshReconnect(session);
    return;
  }
  session.pty = term;
  session.status = "running";
  session.code = null;
  session.endedAt = null;
  term.onData((data) => {
    if (sessions.get(session.id) !== session || session.pty !== term) return;
    session.reconnectAttempts = 0;
    appendSshData(session, data);
  });
  term.onExit(({ exitCode }) => {
    if (sessions.get(session.id) !== session || session.pty !== term) return;
    session.pty = null;
    if (session.stopRequested) {
      session.status = "stopped";
      session.code = null;
      session.endedAt = Date.now();
      emitSession({ id: session.id, event: "exited", code: null, session: sessionMeta(session) });
      return;
    }
    session.code = exitCode ?? null;
    scheduleSshReconnect(session);
  });
}

function scheduleSshReconnect(session) {
  if (session.stopRequested || sessions.get(session.id) !== session) return;
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
  const delay = Math.min(SSH_RECONNECT_MAX_MS, SSH_RECONNECT_MIN_MS * session.reconnectAttempts);
  appendSshData(session, `\r\n\x1b[33m— SSH через MBOX prod разорван. Переподключение через ${Math.ceil(delay / 1000)} с… —\x1b[0m\r\n`);
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connectSshSession(session);
  }, delay);
}

function startSshSession(rawTarget, cols, rows) {
  const { target, port, label } = normalizeSshTarget(rawTarget);
  const id = `ssh:${label.toLowerCase()}`;
  const previous = sessions.get(id);
  if (previous?.status === "running") {
    emitSession({ id, event: "started", reveal: true, session: sessionMeta(previous) });
    return { ok: true, id, pid: previous.pty?.pid ?? null, target: label, reused: true };
  }
  const safeCols = Math.max(20, Math.min(500, Math.floor(Number(cols) || 100)));
  const safeRows = Math.max(5, Math.min(200, Math.floor(Number(rows) || 30)));
  const routeArgs = sshArgs(target, port);
  const session = {
    id,
    kind: "ssh",
    title: `SSH · ${label}`,
    command: `ssh ${routeArgs.join(" ")}`,
    cwd: os.homedir(),
    pty: null,
    buffer: "",
    lines: [],
    status: "running",
    code: null,
    startedAt: Date.now(),
    endedAt: null,
    target,
    port,
    cols: safeCols,
    rows: safeRows,
    reconnectAttempts: 0,
    reconnectTimer: null,
    stopRequested: false
  };
  sessions.set(id, session);
  emitSession({ id, event: "started", reveal: true, session: sessionMeta(session) });
  connectSshSession(session);
  return { ok: true, id, pid: session.pty?.pid ?? null, target: label, jump: sshJumpHost() };
}

const crypto = require("crypto");
const WORKSPACE_CONFIG = () => path.join(app.getPath("userData"), "workspaces.json");
const MAX_READ_BYTES = 5 * 1024 * 1024;
const BLOCKED_WRITE_EXT = new Set([".exe", ".dll", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".js.lnk", ".lnk", ".msi", ".scr", ".reg", ".wsf", ".wsh", ".hta", ".cpl", ".sys"]);
const HIDDEN_DIRS = new Set([".git"]);
const HEAVY_DIRS = new Set(["node_modules", ".next", "dist", "build", "target", ".venv", "__pycache__", ".cache"]);
const workspaceWatchers = new Map();

function loadWorkspaceConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_CONFIG(), "utf8"));
    if (parsed && parsed.deviceId && Array.isArray(parsed.roots)) return parsed;
  } catch {
    // первый запуск
  }
  const config = { deviceId: crypto.randomUUID(), roots: [] };
  saveWorkspaceConfig(config);
  return config;
}

function saveWorkspaceConfig(config) {
  fs.mkdirSync(path.dirname(WORKSPACE_CONFIG()), { recursive: true });
  fs.writeFileSync(WORKSPACE_CONFIG(), JSON.stringify(config, null, 2), "utf8");
}

function workspaceInfo() {
  const config = loadWorkspaceConfig();
  return {
    deviceId: config.deviceId,
    deviceName: os.hostname(),
    roots: config.roots.filter((root) => fs.existsSync(root.path)).map((root) => ({ key: root.key, name: root.name, path: root.path }))
  };
}

function rootByKey(key) {
  const root = loadWorkspaceConfig().roots.find((item) => item.key === String(key || ""));
  if (!root) throw new Error("Папка не подключена");
  return root;
}

function resolveInRoot(key, rel) {
  const root = rootByKey(key);
  const base = path.resolve(root.path);
  const target = path.resolve(base, String(rel || "").replace(/\//g, path.sep));
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Путь выходит за пределы папки");
  return { root, base, target, rel: relative.split(path.sep).join("/") };
}

function assertWritable(rel, target) {
  const parts = rel.split("/");
  if (parts.includes(".git")) throw new Error("Запись в .git запрещена");
  if (BLOCKED_WRITE_EXT.has(path.extname(target).toLowerCase())) throw new Error(`Файлы ${path.extname(target)} из MBOX не записываются — их Windows выполняет напрямую`);
}

async function addWorkspaceRoot() {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Подключить папку к MBOX", properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return workspaceInfo();
  const folder = path.resolve(result.filePaths[0]);
  const config = loadWorkspaceConfig();
  if (!config.roots.some((root) => path.resolve(root.path).toLowerCase() === folder.toLowerCase())) {
    config.roots.push({ key: crypto.randomBytes(4).toString("hex"), name: path.basename(folder) || folder, path: folder });
    saveWorkspaceConfig(config);
  }
  syncWorkspaceWatchers();
  return workspaceInfo();
}

function removeWorkspaceRoot(key) {
  const config = loadWorkspaceConfig();
  config.roots = config.roots.filter((root) => root.key !== key);
  saveWorkspaceConfig(config);
  syncWorkspaceWatchers();
  return workspaceInfo();
}

async function listWorkspaceDir(key, rel) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (HIDDEN_DIRS.has(entry.name)) continue;
    const childRel = cleanRel ? `${cleanRel}/${entry.name}` : entry.name;
    let size = 0;
    let mtime = 0;
    try {
      const stat = await fs.promises.stat(path.join(target, entry.name));
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    rows.push({ name: entry.name, path: childRel, type: entry.isDirectory() ? "dir" : "file", size, mtime, heavy: entry.isDirectory() && HEAVY_DIRS.has(entry.name) });
  }
  rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "ru", { numeric: true }) : a.type === "dir" ? -1 : 1));
  return rows;
}

async function readWorkspaceFile(key, rel) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error("Это не файл");
  if (stat.size > MAX_READ_BYTES) return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, tooLarge: true, content: "" };
  const buffer = await fs.promises.readFile(target);
  const binary = buffer.subarray(0, 8000).includes(0);
  return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, binary, content: binary ? "" : buffer.toString("utf8") };
}

// Картинки отдаются data-URL: страница грузится с сервера и не может открыть file://, а отдельный протокол
// дал бы ей доступ к диску мимо проверки корня. Здесь путь проходит тот же resolveInRoot, что и чтение текста.
const IMAGE_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif", ".svg": "image/svg+xml",
  // Шрифты — для предпросмотра HTML: @font-face из соседней папки подставляется data-URL (src/app/workbench/localPreview.ts).
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject"
};
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const DOCUMENT_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values"
};
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

async function readWorkspaceImage(key, rel) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  const mime = IMAGE_TYPES[path.extname(target).toLowerCase()];
  if (!mime) throw new Error("Это не картинка");
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error("Это не файл");
  if (stat.size > MAX_IMAGE_BYTES) return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, mime, tooLarge: true, dataUrl: "" };
  const buffer = await fs.promises.readFile(target);
  return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, mime, dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
}

async function readWorkspaceData(key, rel) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  const mime = DOCUMENT_TYPES[path.extname(target).toLowerCase()];
  if (!mime) throw new Error("Этот формат документа не поддерживается");
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error("Это не файл");
  if (stat.size > MAX_DOCUMENT_BYTES) return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, mime, tooLarge: true, base64: "" };
  const buffer = await fs.promises.readFile(target);
  return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, mime, base64: buffer.toString("base64") };
}

async function writeWorkspaceData(key, rel, base64, expectedMtime) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  assertWritable(cleanRel, target);
  if (!DOCUMENT_TYPES[path.extname(target).toLowerCase()]) throw new Error("Этот формат документа не поддерживается");
  const buffer = Buffer.from(String(base64 || ""), "base64");
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Документ слишком большой для сохранения из MBOX");
  try {
    const stat = await fs.promises.stat(target);
    if (expectedMtime && Math.abs(stat.mtimeMs - Number(expectedMtime)) > 1) {
      const error = new Error("Файл изменился на диске после открытия");
      error.code = "CONFLICT";
      throw error;
    }
  } catch (error) {
    if (error.code === "CONFLICT") throw error;
    if (error.code !== "ENOENT") throw error;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, buffer);
  const stat = await fs.promises.stat(target);
  return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs };
}

async function writeWorkspaceFile(key, rel, content, expectedMtime) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  assertWritable(cleanRel, target);
  let previous = null;
  try {
    const stat = await fs.promises.stat(target);
    if (expectedMtime && Math.abs(stat.mtimeMs - Number(expectedMtime)) > 1) {
      const error = new Error("Файл изменился на диске после открытия");
      error.code = "CONFLICT";
      throw error;
    }
    if (stat.size <= MAX_READ_BYTES) previous = await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "CONFLICT") throw error;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, String(content ?? ""), "utf8");
  const stat = await fs.promises.stat(target);
  return { path: cleanRel, size: stat.size, mtime: stat.mtimeMs, previous };
}

async function createWorkspaceEntry(key, rel, type) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  assertWritable(cleanRel, target);
  if (fs.existsSync(target)) throw new Error("Такой файл или папка уже есть");
  if (type === "dir") await fs.promises.mkdir(target, { recursive: true });
  else {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, "", "utf8");
  }
  return { path: cleanRel };
}

async function renameWorkspaceEntry(key, rel, nextRel) {
  const from = resolveInRoot(key, rel);
  const to = resolveInRoot(key, nextRel);
  assertWritable(from.rel, from.target);
  assertWritable(to.rel, to.target);
  if (fs.existsSync(to.target)) throw new Error("Такое имя уже занято");
  await fs.promises.rename(from.target, to.target);
  return { path: to.rel };
}

async function trashWorkspaceEntry(key, rel) {
  const { target, rel: cleanRel } = resolveInRoot(key, rel);
  if (!cleanRel) throw new Error("Корень папки не удаляется");
  assertWritable(cleanRel, target);
  await shell.trashItem(target);
  return { ok: true };
}

async function findWorkspaceFiles(key, queryText, limit = 60) {
  const { base } = resolveInRoot(key, "");
  const needle = String(queryText || "").toLowerCase().trim();
  if (!needle) return [];
  const found = [];
  const stack = [""];
  let visited = 0;
  while (stack.length && found.length < limit && visited < 20000) {
    const rel = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!HIDDEN_DIRS.has(entry.name) && !HEAVY_DIRS.has(entry.name)) stack.push(childRel);
      } else if (childRel.toLowerCase().includes(needle)) {
        found.push(childRel);
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}

function git(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=false", ...args], { cwd, windowsHide: true, maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || (error ? error.message : "") });
    });
  });
}

const COMMIT_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";

function parseCommits(stdout) {
  return stdout.split("\x1e").map((row) => row.trim()).filter(Boolean).map((row) => {
    const [hash, short, author, date, subject] = row.split("\x1f");
    return { hash, short, author, date, subject };
  });
}

async function workspaceGitSummary(key) {
  const { base } = resolveInRoot(key, "");
  const inside = await git(base, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return { isRepo: false };
  const [status, log, remote, top] = await Promise.all([
    git(base, ["status", "--porcelain=v1", "-b", "--untracked-files=normal"]),
    git(base, ["log", "-n", "15", `--pretty=format:${COMMIT_FORMAT}`]),
    git(base, ["remote", "get-url", "origin"]),
    git(base, ["rev-parse", "--show-toplevel"])
  ]);
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
  const branchMatch = head.match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/);
  const tracking = branchMatch?.[3] || "";
  const toplevel = top.stdout.trim().replace(/\//g, path.sep);
  // Пути в git status — от корня репозитория; если подключена его подпапка, переводим в пути папки.
  const prefix = toplevel ? path.relative(toplevel, base).split(path.sep).join("/") : "";
  const changes = lines.slice(0, 500).map((line) => {
    const code = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(" -> ")) file = file.split(" -> ")[1];
    file = file.replace(/^"|"$/g, "");
    if (prefix) file = file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : `../${file}`;
    return { path: file, index: code[0], worktree: code[1], untracked: code === "??" };
  });
  return {
    isRepo: true,
    branch: branchMatch?.[1] || "",
    upstream: branchMatch?.[2] || "",
    ahead: Number(tracking.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(tracking.match(/behind (\d+)/)?.[1] || 0),
    remote: remote.ok ? remote.stdout.trim() : "",
    changes,
    changesTotal: lines.length,
    commits: parseCommits(log.stdout),
    checkedAt: new Date().toISOString()
  };
}

async function workspaceGitFileLog(key, rel) {
  const { base, rel: cleanRel } = resolveInRoot(key, rel);
  const log = await git(base, ["log", "-n", "30", "--follow", `--pretty=format:${COMMIT_FORMAT}`, "--", cleanRel]);
  return log.ok ? parseCommits(log.stdout) : [];
}

async function workspaceGitDiff(key, rel) {
  const { base, rel: cleanRel } = resolveInRoot(key, rel);
  const diff = await git(base, ["diff", "HEAD", "--", cleanRel]);
  if (diff.ok && diff.stdout.trim()) return { diff: diff.stdout };
  const untracked = await git(base, ["ls-files", "--others", "--exclude-standard", "--", cleanRel]);
  if (untracked.stdout.trim()) return { diff: "", note: "Файл ещё не добавлен в git — сравнивать не с чем." };
  return { diff: diff.stdout, note: diff.ok ? "Изменений относительно последнего коммита нет." : diff.stderr };
}

async function workspaceGitShow(key, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(hash || ""))) throw new Error("Некорректный коммит");
  const { base } = resolveInRoot(key, "");
  const show = await git(base, ["show", "--stat", "--patch", `--pretty=format:%H%n%an <%ae>%n%aI%n%n%B`, hash]);
  if (!show.ok) throw new Error(show.stderr);
  return { text: show.stdout.length > 400000 ? `${show.stdout.slice(0, 400000)}\n… обрезано …` : show.stdout };
}

function syncWorkspaceWatchers() {
  const roots = loadWorkspaceConfig().roots;
  for (const [key, watcher] of workspaceWatchers) {
    if (!roots.some((root) => root.key === key)) {
      watcher.close();
      workspaceWatchers.delete(key);
    }
  }
  for (const root of roots) {
    if (workspaceWatchers.has(root.key) || !fs.existsSync(root.path)) continue;
    const pending = new Set();
    let timer = null;
    try {
      const watcher = fs.watch(root.path, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join("/");
        const parts = rel.split("/");
        if (parts.some((part) => HIDDEN_DIRS.has(part) || HEAVY_DIRS.has(part))) {
          // .git/index и HEAD меняются при коммите/checkout — это повод обновить git-сводку.
          if (parts[0] !== ".git" || !/^(index|HEAD)$/.test(parts[1] || "")) return;
          pending.add(".git");
        } else {
          pending.add(rel);
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = [...pending];
          pending.clear();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mbox-desktop:workspace-change", { key: root.key, paths });
        }, 400);
      });
      watcher.on("error", () => { watcher.close(); workspaceWatchers.delete(root.key); });
      workspaceWatchers.set(root.key, watcher);
    } catch (error) {
      log(`workspace watch failed for ${root.path}: ${error.message}`);
    }
  }
}

/** Свободное имя рядом: «отчёт.md» → «отчёт копия.md» → «отчёт копия 2.md». */
function uniqueTarget(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    candidate = path.join(dir, `${base} копия${index > 1 ? ` ${index}` : ""}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Не нашлось свободного имени");
}

async function transferWorkspaceEntry(fromKey, fromRel, toKey, toDirRel, move) {
  const from = resolveInRoot(fromKey, fromRel);
  const toDir = resolveInRoot(toKey, toDirRel);
  if (!from.rel) throw new Error("Корень папки не копируется");
  if (!fs.existsSync(from.target)) throw new Error("Исходный файл не найден");
  if (!fs.statSync(toDir.target).isDirectory()) throw new Error("Вставлять можно только в папку");
  const destination = uniqueTarget(toDir.target, path.basename(from.target));
  const relative = path.relative(toDir.base, destination).split(path.sep).join("/");
  assertWritable(relative, destination);
  if (move) assertWritable(from.rel, from.target);
  if (path.resolve(destination).toLowerCase().startsWith(`${path.resolve(from.target).toLowerCase()}${path.sep}`)) throw new Error("Папку нельзя вложить саму в себя");
  if (move) {
    try {
      await fs.promises.rename(from.target, destination);
    } catch {
      await fs.promises.cp(from.target, destination, { recursive: true, errorOnExist: true });
      await shell.trashItem(from.target);
    }
  } else {
    await fs.promises.cp(from.target, destination, { recursive: true, errorOnExist: true });
  }
  return { path: relative };
}

/** Файлы, скопированные в Проводнике Windows (Ctrl+C), — в папку MBOX. Берём пути из буфера обмена
 * сами: страница их не передаёт и не видит. */
async function pasteFromSystemClipboard(key, toDirRel) {
  const toDir = resolveInRoot(key, toDirRel);
  const raw = clipboard.readBuffer("FileNameW");
  const sources = raw.length ? raw.toString("ucs2").split("\0").map((item) => item.trim()).filter(Boolean) : [];
  if (!sources.length) throw new Error("В буфере обмена нет файлов — скопируйте их в Проводнике (Ctrl+C)");
  const pasted = [];
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    const destination = uniqueTarget(toDir.target, path.basename(source));
    const relative = path.relative(toDir.base, destination).split(path.sep).join("/");
    assertWritable(relative, destination);
    await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true });
    pasted.push(relative);
  }
  return { paths: pasted };
}

/** Обратно в Проводник: файл кладётся в буфер как файл (CF_HDROP через FileNameW), вставляется Ctrl+V. */
function copyToSystemClipboard(key, rel) {
  const { target } = resolveInRoot(key, rel);
  if (!fs.existsSync(target)) throw new Error("Файл не найден");
  clipboard.writeBuffer("FileNameW", Buffer.from(`${target}\0`, "ucs2"));
  return { ok: true };
}

function openWorkspaceEntry(key, rel) {
  const { target } = resolveInRoot(key, rel);
  shell.showItemInFolder(target);
  return { ok: true };
}

ipcMain.handle("mbox-desktop:ws-info", async () => { syncWorkspaceWatchers(); return workspaceInfo(); });
ipcMain.handle("mbox-desktop:ws-add", async () => addWorkspaceRoot());
ipcMain.handle("mbox-desktop:ws-remove", async (_event, key) => removeWorkspaceRoot(String(key || "")));
ipcMain.handle("mbox-desktop:ws-list", async (_event, key, rel) => listWorkspaceDir(key, rel));
ipcMain.handle("mbox-desktop:ws-read", async (_event, key, rel) => readWorkspaceFile(key, rel));
// Разовый перенос localStorage со старого адреса сайта во встроенный интерфейс (см. localUi.js).
ipcMain.on("mbox-desktop:take-storage-migration", (event) => {
  const trusted = useLocalUi && event.senderFrame?.url?.startsWith(`${localUi.APP_ORIGIN}/`);
  event.returnValue = trusted ? localUi.takePendingStorage() : null;
});
ipcMain.handle("mbox-desktop:ws-read-image", async (_event, key, rel) => readWorkspaceImage(key, rel));
ipcMain.handle("mbox-desktop:ws-read-data", async (_event, key, rel) => readWorkspaceData(key, rel));
ipcMain.handle("mbox-desktop:ws-write", async (_event, key, rel, content, expectedMtime) => writeWorkspaceFile(key, rel, content, expectedMtime));
ipcMain.handle("mbox-desktop:ws-write-data", async (_event, key, rel, base64, expectedMtime) => writeWorkspaceData(key, rel, base64, expectedMtime));
ipcMain.handle("mbox-desktop:ws-create", async (_event, key, rel, type) => createWorkspaceEntry(key, rel, type));
ipcMain.handle("mbox-desktop:ws-rename", async (_event, key, rel, nextRel) => renameWorkspaceEntry(key, rel, nextRel));
ipcMain.handle("mbox-desktop:ws-trash", async (_event, key, rel) => trashWorkspaceEntry(key, rel));
ipcMain.handle("mbox-desktop:ws-find", async (_event, key, queryText) => findWorkspaceFiles(key, queryText));
ipcMain.handle("mbox-desktop:ws-reveal", async (_event, key, rel) => openWorkspaceEntry(key, rel));
ipcMain.handle("mbox-desktop:ws-transfer", async (_event, fromKey, fromRel, toKey, toDirRel, move) => transferWorkspaceEntry(fromKey, fromRel, toKey, toDirRel, Boolean(move)));
ipcMain.handle("mbox-desktop:ws-paste-system", async (_event, key, toDirRel) => pasteFromSystemClipboard(key, toDirRel));
ipcMain.handle("mbox-desktop:ws-copy-system", async (_event, key, rel) => copyToSystemClipboard(key, rel));
ipcMain.handle("mbox-desktop:ws-open-default", async (_event, key, rel) => {
  const { target } = resolveInRoot(key, rel);
  // Открыть .exe/.cmd «программой по умолчанию» — значит запустить его: из страницы так нельзя.
  if (BLOCKED_WRITE_EXT.has(path.extname(target).toLowerCase())) throw new Error("Исполняемые файлы из MBOX не открываются — используйте «Показать в проводнике»");
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { ok: true };
});
ipcMain.handle("mbox-desktop:ws-git", async (_event, key) => workspaceGitSummary(key));
ipcMain.handle("mbox-desktop:ws-git-log", async (_event, key, rel) => workspaceGitFileLog(key, rel));
ipcMain.handle("mbox-desktop:ws-git-diff", async (_event, key, rel) => workspaceGitDiff(key, rel));
ipcMain.handle("mbox-desktop:ws-git-show", async (_event, key, hash) => workspaceGitShow(key, hash));

app.on("before-quit", () => {
  for (const watcher of workspaceWatchers.values()) watcher.close();
  workspaceWatchers.clear();
});

// --- Запуск инструментов из MBOX -------------------------------------------------------------
//
// Окно грузит УДАЛЁННУЮ страницу (mbox.shar-os.ru), и preload-мост доступен ей напрямую. Поэтому
// из интерфейса приходит только пара идентификаторов: какой инструмент и какая его команда.
// Саму команду главный процесс берёт из каталога, который сам же и запрашивает у MBOX по HTTPS,
// и сверяет побайтово. Каталог из renderer'а не принимается ни при каких условиях.

const runningTools = new Map();
const TOOL_OUTPUT_LIMIT = 400;
const LOCAL_TOOL_CATALOG = [
  {
    id: "tour-feed",
    name: "Сформировать фид",
    path: path.join(os.homedir(), "Desktop", "Фиды"),
    commands: [
      { label: "Сформировать фид", command: "python merge_feeds.py \"01.06\"", runnable: true },
      { label: "Открыть папку", command: "explorer .", runnable: true }
    ]
  },
  {
    id: "obscura",
    name: "Obscura",
    path: path.join(os.homedir(), "Desktop", "Mbox", "obscura"),
    commands: [
      { label: "Сборка с render", command: "cargo build --release -p obscura-cli --bins --features render", env: { CARGO_INCREMENTAL: "0", CARGO_BUILD_JOBS: "2" }, runnable: true },
      { label: "Сервер CDP", command: "target\\release\\obscura.exe serve --port 9222", runnable: true, long_running: true },
      { label: "MCP stdio", command: "target\\release\\obscura.exe mcp", runnable: false },
      { label: "MCP HTTP", command: "target\\release\\obscura.exe mcp --http --port 3000", runnable: true, long_running: true }
    ]
  },
  {
    id: "figma",
    name: "Figma MCP",
    path: path.join(os.homedir(), "Desktop", "Mbox"),
    commands: [
      { label: "Открыть Figma", command: "start \"\" \"figma://\"", runnable: true },
      { label: "Проверить desktop MCP", command: "powershell -NoProfile -Command \"try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3845/mcp -TimeoutSec 3).StatusCode } catch { $_.Exception.Message }\"", runnable: true },
      { label: "Codex remote MCP", command: "codex mcp add figma --url https://mcp.figma.com/mcp", runnable: true },
      { label: "Claude desktop MCP", command: "claude mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp", runnable: true }
    ]
  },
  {
    id: "playwright-mcp",
    name: "Playwright MCP",
    path: repoRoot,
    commands: [
      { label: "MCP HTTP", command: "npx @playwright/mcp --browser chrome --host 127.0.0.1 --port 9310 --caps vision,pdf", runnable: true, long_running: true },
      { label: "MCP stdio", command: "npx @playwright/mcp --browser chrome --caps vision,pdf", runnable: false },
      { label: "Установить Chromium", command: "npx playwright install chromium", env: { PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000" }, runnable: true }
    ]
  },
  {
    id: "chrome-devtools-mcp",
    name: "Chrome DevTools MCP",
    path: repoRoot,
    commands: [
      { label: "MCP stable Chrome", command: "npx chrome-devtools-mcp --channel stable --viewport 1440x900", runnable: true, long_running: true },
      { label: "MCP slim", command: "npx chrome-devtools-mcp --channel stable --slim --viewport 1440x900", runnable: true, long_running: true },
      { label: "Chrome debug 9222", command: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"%TEMP%\\mbox-chrome-debug\"", runnable: true, long_running: true },
      { label: "Подключиться к 9222", command: "npx chrome-devtools-mcp --browserUrl http://127.0.0.1:9222", runnable: true, long_running: true }
    ]
  },
  {
    id: "browserbase-stagehand",
    name: "Browserbase + Stagehand",
    path: repoRoot,
    commands: [
      { label: "MCP HTTP", command: "npx @browserbasehq/mcp --browserbaseApiKey %BROWSERBASE_API_KEY% --browserbaseProjectId %BROWSERBASE_PROJECT_ID% --host 127.0.0.1 --port 9320 --browserWidth 1440 --browserHeight 900", runnable: true, long_running: true },
      { label: "Stagehand check", command: "node -e \"import('@browserbasehq/stagehand').then(() => console.log('Stagehand OK'))\"", runnable: true }
    ]
  }
];

function toolWorkdirAllowed(dir) {
  const allowedRoots = [
    repoRoot,
    path.join(os.homedir(), "Desktop", "Mbox"),
    path.join(os.homedir(), "Desktop", "MBOX"),
    path.join(os.homedir(), "Desktop", "Фиды")
  ].map((item) => path.resolve(item).toLowerCase());
  const normalized = path.resolve(dir).toLowerCase();
  return allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
}

// Свои сообщения («Системе не удается найти указанный путь.») cmd.exe пишет в OEM-кодировке
// даже когда вывод идёт в канал, и chcp на это не влияет — проверено. Сами инструменты
// (cargo и прочие) пишут UTF-8. Поэтому сначала строгий UTF-8, а на непрошедших байтах cp866.
function decodeConsole(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("cp866").decode(buffer);
    } catch {
      return buffer.toString("latin1");
    }
  }
}

async function fetchToolCatalog() {
  try {
    const response = await fetch(`${mboxUrl}/api/mbox/tools`);
  if (!response.ok) throw new Error(`Каталог инструментов недоступен: ${response.status}`);
    const data = await response.json();
    if (Array.isArray(data.tools) && data.tools.length) return data.tools;
  } catch (error) {
    log(`tool catalog API unavailable, using desktop catalog: ${error.message}`);
  }
  return LOCAL_TOOL_CATALOG;
}

function emitTool(payload) {
  mainWindow?.webContents.send("mbox-desktop:tool", { at: new Date().toISOString(), ...payload });
}

function externalUrlFromStartCommand(command) {
  const match = String(command || "").trim().match(/^start\s+""\s+"([a-z][a-z0-9+.-]*:\/\/[^"]*)"$/i);
  return match ? match[1] : "";
}

async function runTool(toolId, commandLabel) {
  const key = String(toolId || "");
  if (runningTools.has(key)) throw new Error("Этот инструмент уже запущен — сначала остановите его");

  const tools = await fetchToolCatalog();
  const tool = tools.find((item) => item.id === key);
  if (!tool) throw new Error(`Инструмент «${key}» не найден в каталоге MBOX`);
  const entry = (tool.commands || []).find((item) => item.label === commandLabel);
  if (!entry) throw new Error(`Команда «${commandLabel}» не описана у инструмента «${tool.name}»`);
  if (entry.runnable === false) throw new Error(`Команда «${commandLabel}» помечена как незапускаемая (нужен stdio-режим)`);

  const workdir = path.resolve(String(tool.path || ""));
  if (!toolWorkdirAllowed(workdir)) throw new Error("Каталог инструмента вне рабочей папки MBOX");
  if (!fs.existsSync(workdir)) throw new Error(`Каталог инструмента не найден: ${workdir}`);

  const externalUrl = externalUrlFromStartCommand(entry.command);
  if (externalUrl) {
    emitTool({ tool: key, event: "started", label: commandLabel, command: entry.command, cwd: workdir });
    await shell.openExternal(externalUrl);
    emitTool({ tool: key, event: "exited", code: 0, signal: null, ms: 0 });
    return { ok: true, command: entry.command, cwd: workdir };
  }

  // Раньше команда уходила видимому cmd.exe /k — отдельное окно вне приложения, вывод MBOX не видел.
  // Теперь без окна, с перехватом вывода: он идёт во встроенную консоль (сессия tool:<id>) и на
  // страницу инструмента. /s /c "команда": cmd снимает только внешние кавычки, кавычки внутри целы.
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${entry.command}"`], {
    cwd: workdir,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(entry.env || {}) }
  });

  const state = { child, lines: [], label: commandLabel, toolId: key, startedAt: Date.now() };
  runningTools.set(key, state);
  emitTool({ tool: key, event: "started", label: commandLabel, command: entry.command, cwd: workdir, pid: child.pid });
  startSession({
    id: `tool:${key}`,
    kind: "tool",
    title: `${tool.name} · ${commandLabel}`,
    command: entry.command,
    cwd: workdir,
    child,
    onLine: (stream, line) => {
      state.lines.push({ stream, line });
      if (state.lines.length > TOOL_OUTPUT_LIMIT) state.lines.shift();
      emitTool({ tool: key, event: "output", stream, line });
    },
    onExit: (code, signal) => {
      runningTools.delete(key);
      emitTool({ tool: key, event: "exited", code, signal, ms: Date.now() - state.startedAt });
    }
  });
  child.on("error", (error) => {
    runningTools.delete(key);
    emitTool({ tool: key, event: "failed", message: error.message });
  });

  return { ok: true, pid: child.pid, command: entry.command, cwd: workdir };
}

function stopTool(toolId) {
  const state = runningTools.get(String(toolId || ""));
  if (!state) return { ok: false, reason: "не запущен" };
  // Дерево процессов: cargo/obscura порождают детей, один kill по pid оставил бы их висеть.
  markStopped(`tool:${toolId}`);
  killTree(state.child.pid);
  return { ok: true };
}

function toolStatus() {
  return [...runningTools.entries()].map(([toolId, state]) => ({
    tool: toolId,
    label: state.label,
    pid: state.child.pid,
    ms: Date.now() - state.startedAt,
    lines: state.lines.slice(-80)
  }));
}

ipcMain.handle("mbox-desktop:run-tool", async (_event, toolId, commandLabel) => runTool(toolId, commandLabel));
ipcMain.handle("mbox-desktop:stop-tool", async (_event, toolId) => stopTool(toolId));
ipcMain.handle("mbox-desktop:tool-status", async () => toolStatus());

app.on("before-quit", () => {
  for (const toolId of [...runningTools.keys()]) stopTool(toolId);
  for (const session of sessions.values()) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.status === "running" && session.kind === "agent") killTree(session.child?.pid);
    if (session.status === "running" && session.pty) {
      try { session.pty.kill(); } catch {}
    }
  }
});
