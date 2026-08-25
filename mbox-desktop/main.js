const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
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

let mainWindow = null;
let tray = null;
let tracked = new Map();
let updatePromptOpen = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  createWindow();
  createTray();
  setMenu();
  setupAutoUpdates();
  await startResponders().catch((error) => log(`autostart responders failed: ${error.message}`));
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "MBOX Desktop",
    icon: iconPath,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} MBOXDesktop/${app.getVersion()}`);
  mainWindow.loadURL(withDesktopFlag(mboxUrl));
  mainWindow.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
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
        { label: "Запустить Codex", click: () => startResponder("Codex") },
        { label: "Запустить Claude", click: () => startResponder("Claude") },
        { label: "Запустить обоих", click: () => startResponders() },
        { type: "separator" },
        { label: "Остановить Codex", click: () => stopResponder("Codex") },
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
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

async function startResponders() {
  const results = [];
  results.push(await startResponder("Codex"));
  results.push(await startResponder("Claude"));
  return results;
}

async function startResponder(name) {
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
  const logFile = path.join(app.getPath("userData"), "responder-logs", `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("cmd.exe", ["/d", "/c", `"${file}"`], {
    cwd: workdir,
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env
  });
  child.unref();
  tracked.set(name, child);
  child.on("exit", (code, signal) => log(`${name} responder exited code=${code ?? ""} signal=${signal ?? ""}`));
  log(`started ${name} responder from ${file}`);
  return { agent: name, status: "started", script: file };
}

async function stopResponders() {
  await stopResponder("Codex");
  await stopResponder("Claude");
}

async function stopResponder(name) {
  const pattern = processPatterns[name];
  const matches = (await processStatus()).filter((item) => item.agent === name);
  for (const item of matches) await killPid(item.pid);
  const child = tracked.get(name);
  if (child && !child.killed) child.kill();
  tracked.delete(name);
  log(`stopped ${name} responder (${pattern})`);
}

function processStatus() {
  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match 'node' -and $_.CommandLine -match 'codex-chat-watcher|claude-inbox-watcher' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.map((row) => ({
          pid: row.ProcessId,
          commandLine: row.CommandLine,
          agent: /codex-chat-watcher/i.test(row.CommandLine || "") ? "Codex" : "Claude"
        })));
      } catch {
        resolve([]);
      }
    });
  });
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
    showUpdateNotice("info", "MBOX Desktop: найдено обновление", `${message}. Скачиваю в фоне.`);
  });
  autoUpdater.on("update-not-available", () => updateStatus("current", "Установлена свежая версия"));
  autoUpdater.on("download-progress", (progress) => updateStatus("downloading", `Скачиваю обновление ${Math.round(progress.percent || 0)}%`));
  autoUpdater.on("update-downloaded", (info) => {
    updateStatus("ready", `Обновление ${info.version || ""} готово к установке`.trim());
    showUpdateInstallPrompt(info);
  });
  autoUpdater.on("error", (error) => {
    updateStatus("error", `Обновление: ${error.message}`);
    showUpdateNotice("error", "MBOX Desktop: обновление не проверилось", error.message);
  });
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates(false), 5000);
  }
}

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
  else await startResponder(name);
  await sleep(1200);
  return processStatus();
});
ipcMain.handle("mbox-desktop:stop", async (_event, name) => {
  if (name === "All") await stopResponders();
  else await stopResponder(name);
  return processStatus();
});
ipcMain.handle("mbox-desktop:install-autostart", async () => installResponderAutostart());
ipcMain.handle("mbox-desktop:remove-autostart", async () => removeResponderAutostart());
ipcMain.handle("mbox-desktop:install-app-autostart", async () => installAppAutostart());
ipcMain.handle("mbox-desktop:remove-app-autostart", async () => removeAppAutostart());
ipcMain.handle("mbox-desktop:open-repo", async () => shell.openPath(repoRoot));
ipcMain.handle("mbox-desktop:check-updates", async () => checkForUpdates(true));
ipcMain.handle("mbox-desktop:install-update", async () => {
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});
