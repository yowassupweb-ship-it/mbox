#!/usr/bin/env node
// MBOX Agent: установка и запуск наблюдателей Claude Code и ChatGPT (Codex CLI) на любом компьютере.
// Нужен только Node 20+ и свой аккаунт MBOX (личный токен — «Настройки → Агенты на этом компьютере»).
//
//   node mbox-agent.mjs install --url https://mbox.shar-os.ru --user Аня --token mbox_…   поставить и запустить
//   node mbox-agent.mjs status                                                              что запущено
//   node mbox-agent.mjs disable codex | enable codex                                        выключить/включить агента
//   node mbox-agent.mjs update                                                              обновить файлы с сервера
//   node mbox-agent.mjs uninstall                                                           убрать автозапуск
//   node mbox-agent.mjs run                                                                 (служебное) держать наблюдателей
//
// Агент выключен, если его выключили здесь (disable) или в настройках MBOX (нет подписки): наблюдатель не запускается,
// остальной MBOX работает как обычно. Установленные файлы лежат в ~/.mbox/agent, настройки — config.json рядом.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(os.homedir(), ".mbox", "agent");
const AGENTS = {
  claude: { label: "Claude Code", watcher: "claude-inbox-watcher.mjs", cli: "claude", prefix: "Claude", install: "npm install -g @anthropic-ai/claude-code   (вход в аккаунт — кнопкой в чате MBOX)" },
  codex: { label: "ChatGPT (Codex CLI)", watcher: "codex-chat-watcher.mjs", cli: "codex", prefix: "ChatGPT", install: "npm install -g @openai/codex   (вход в аккаунт — кнопкой в чате MBOX)" },
};

const out = (message = "") => console.log(message);
const fail = (message) => { console.error(`Ошибка: ${message}`); process.exit(1); };

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; index += 1; }
    } else args._.push(item);
  }
  return args;
}

function agentDir(args) { return path.resolve(String(args.dir || process.env.MBOX_AGENT_DIR || DEFAULT_DIR)); }
const configPath = (dir) => path.join(dir, "config.json");
const readConfig = (dir) => { try { return JSON.parse(fs.readFileSync(configPath(dir), "utf8")); } catch { return null; } };
function writeConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function hasCli(name) {
  const result = spawnSync(name, ["--version"], { encoding: "utf8", shell: IS_WIN, windowsHide: true, timeout: 20_000 });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/)[0] : "";
}

async function api(config, pathname, options = {}) {
  const response = await fetch(`${config.url}${pathname}`, { ...options, headers: { authorization: `Bearer ${config.token}`, ...(options.headers || {}) } });
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function downloadKit(config, dir) {
  const manifest = await (await api(config, "/api/mbox/agent-kit")).json();
  const scripts = path.join(dir, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  let changed = 0;
  for (const file of manifest.files) {
    const target = file.name === "package.json" ? path.join(dir, file.name) : path.join(scripts, file.name);
    const current = fs.existsSync(target) ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : "";
    if (current === file.sha256) continue;
    const text = await (await api(config, `/api/mbox/agent-kit/${encodeURIComponent(file.name)}`)).text();
    fs.writeFileSync(target, text);
    changed += 1;
  }
  return { changed, hasPackage: manifest.files.some((file) => file.name === "package.json") };
}

function installDependencies(dir) {
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: dir, stdio: "inherit", shell: IS_WIN, windowsHide: true });
  return result.status === 0;
}

// ─── автозапуск ───────────────────────────────────────────────────────────────

function autostartTarget() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "MBOX Agent.vbs");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "LaunchAgents", "ru.mbox.agent.plist");
  return path.join(os.homedir(), ".config", "systemd", "user", "mbox-agent.service");
}

function installAutostart(dir) {
  const script = path.join(dir, "scripts", "mbox-agent.mjs");
  const target = autostartTarget();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (IS_WIN) {
    const command = `"${process.execPath}" "${script}" run --dir "${dir}"`.replace(/"/g, '""');
    fs.writeFileSync(target, `CreateObject("WScript.Shell").Run "${command}", 0, False\r\n`);
    return target;
  }
  if (process.platform === "darwin") {
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ru.mbox.agent</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string><string>run</string><string>--dir</string><string>${dir}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${path.join(dir, "agent.log")}</string><key>StandardErrorPath</key><string>${path.join(dir, "agent.log")}</string>
</dict></plist>
`);
    spawnSync("launchctl", ["unload", target], { stdio: "ignore" });
    spawnSync("launchctl", ["load", "-w", target], { stdio: "ignore" });
    return target;
  }
  fs.writeFileSync(target, `[Unit]
Description=MBOX Agent (Claude Code / ChatGPT watchers)

[Service]
ExecStart=${process.execPath} ${script} run --dir ${dir}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);
  const enabled = spawnSync("systemctl", ["--user", "enable", "--now", "mbox-agent.service"], { stdio: "ignore" });
  return enabled.status === 0 ? target : "";
}

function removeAutostart() {
  const target = autostartTarget();
  if (process.platform === "darwin") spawnSync("launchctl", ["unload", target], { stdio: "ignore" });
  if (process.platform === "linux") spawnSync("systemctl", ["--user", "disable", "--now", "mbox-agent.service"], { stdio: "ignore" });
  try { fs.rmSync(target); return true; } catch { return false; }
}

// ─── служебный процесс ────────────────────────────────────────────────────────

const pidPath = (dir) => path.join(dir, "agent.pid");
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function runningPid(dir) {
  try { const pid = Number(fs.readFileSync(pidPath(dir), "utf8")); return pid && isAlive(pid) ? pid : 0; } catch { return 0; }
}

function stopTree(child) {
  if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGTERM");
}

async function serverPrefs(config) {
  try { return await (await api(config, "/api/mbox/account/agents")).json().then((data) => data.agents || {}); } catch (error) {
    return error.status === 401 ? { _unauthorized: true } : null; // сеть недоступна — остаёмся как были
  }
}

async function supervise(dir) {
  // Подключаем лениво: установщик запускается из одного файла, остальной набор приезжает уже после него.
  const { checkCli, startLogin, logoutCli } = await import("./cli-auth.mjs");
  const existing = runningPid(dir);
  if (existing && existing !== process.pid) { out(`Уже запущен (pid ${existing}).`); return; }
  fs.writeFileSync(pidPath(dir), String(process.pid));
  const log = fs.createWriteStream(path.join(dir, "agent.log"), { flags: "a" });
  const say = (message) => log.write(`${new Date().toISOString()} ${message}\n`);
  const children = new Map();
  const backoff = new Map();
  const cliPresent = new Map();
  // Что известно про вход в CLI: служба присылает это в MBOX, а интерфейс показывает кнопку «Войти».
  const cliState = new Map();
  const logins = new Map();
  let lastPrefs = {};
  say(`MBOX Agent: старт, pid ${process.pid}`);

  const stopAll = () => { for (const child of children.values()) stopTree(child); try { fs.rmSync(pidPath(dir)); } catch { /* уже нет */ } };
  process.on("SIGTERM", () => { stopAll(); process.exit(0); });
  process.on("SIGINT", () => { stopAll(); process.exit(0); });
  process.on("exit", () => { for (const child of children.values()) stopTree(child); });

  const tick = async () => {
    const config = readConfig(dir);
    if (!config) return;
    const prefs = (await serverPrefs(config)) ?? lastPrefs;
    lastPrefs = prefs;
    for (const [family, info] of Object.entries(AGENTS)) {
      const wanted = config.agents?.[family]?.enabled !== false && prefs?.[family]?.enabled !== false && !prefs?._unauthorized;
      const child = children.get(family);
      if (!wanted) {
        if (child) { say(`${info.label}: выключен — останавливаю`); stopTree(child); children.delete(family); }
        continue;
      }
      if (child) continue;
      if ((backoff.get(family) || 0) > Date.now()) continue;
      let cli = cliPresent.get(family);
      if (!cli || cli.until < Date.now()) {
        cli = { ok: Boolean(hasCli(info.cli)), until: Date.now() + (cli?.ok ? 10 * 60_000 : 60_000) };
        cliPresent.set(family, cli);
        if (!cli.ok) say(`${info.label}: команда ${info.cli} не найдена — пропускаю (установите: ${info.install})`);
      }
      if (!cli.ok) continue;
      if (cliState.get(family)?.logged_in === false) continue; // ждём вход: без него наблюдатель только падал бы на каждом сообщении
      const workdir = config.workdir || path.join(os.homedir(), "MBOX-agent");
      fs.mkdirSync(workdir, { recursive: true });
      const name = config.names?.[family] || `${info.prefix}-${config.user}`.replace(/\s+/g, "-");
      const env = {
        ...process.env,
        MBOX_URL: config.url,
        MBOX_USERNAME: config.user,
        MBOX_TOKEN: config.token,
        MBOX_AGENT_NAME: name,
        ...(config.project ? { MBOX_PROJECT: config.project } : {}),
        CLAUDE_WATCH_WORKDIR: workdir,
        CODEX_WATCH_WORKDIR: workdir,
      };
      const started = Date.now();
      const next = spawn(process.execPath, [path.join(dir, "scripts", info.watcher)], { cwd: workdir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      next.stdout.on("data", (chunk) => log.write(`[${family}] ${chunk}`));
      next.stderr.on("data", (chunk) => log.write(`[${family}] ${chunk}`));
      next.on("close", (code) => {
        if (children.get(family) === next) children.delete(family);
        const lived = Date.now() - started;
        const wait = lived > 5 * 60_000 ? 5_000 : Math.min((backoff.get(`${family}:step`) || 5_000) * 2, 5 * 60_000);
        backoff.set(`${family}:step`, wait);
        backoff.set(family, Date.now() + wait);
        say(`${info.label}: завершился (код ${code}), перезапуск через ${Math.round(wait / 1000)} с`);
      });
      children.set(family, next);
      say(`${info.label}: запущен как ${name} (pid ${next.pid})`);
    }
  };

  // Раз в 5 секунд: отдаём в MBOX состояние входа и забираем запросы «войти/выйти» из интерфейса.
  let lastCheck = 0;
  const cliTick = async () => {
    const config = readConfig(dir);
    if (!config) return;
    const stale = Date.now() - lastCheck > 60_000;
    for (const family of Object.keys(AGENTS)) {
      if (logins.has(family)) continue;
      if (stale || !cliState.has(family)) {
        const result = await checkCli(family);
        cliState.set(family, { ...(cliState.get(family) || {}), ...result });
      }
    }
    if (stale) lastCheck = Date.now();
    const report = Object.fromEntries([...cliState].map(([family, state]) => [family, state]));
    let answer;
    try { answer = await (await api(config, "/api/mbox/account/agents/cli", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(report) })).json(); } catch { return; }
    // Итог входа отдан интерфейсу — дальше он не нужен.
    for (const [family, state] of cliState) if (state.login && ["done", "failed"].includes(state.login.state)) cliState.set(family, { ...state, login: null });
    for (const [family, action] of Object.entries(answer.requests || {})) {
      if (!AGENTS[family]) continue;
      if (action === "login" && !logins.has(family)) {
        say(`${AGENTS[family].label}: запрошен вход, открываю браузер`);
        cliState.set(family, { ...(cliState.get(family) || {}), login: { state: "running", url: "", message: "" } });
        const handle = startLogin(family, (update) => {
          const previous = cliState.get(family) || {};
          if (update.state === "done" || update.state === "failed") {
            logins.delete(family);
            cliState.set(family, { ...previous, login: update, ...(update.state === "done" ? { logged_in: true, account: update.message || previous.account || "" } : {}) });
            say(`${AGENTS[family].label}: вход ${update.state === "done" ? "выполнен" : "не выполнен"}`);
          } else cliState.set(family, { ...previous, login: update });
        });
        logins.set(family, handle);
      } else if (action === "logout") {
        logins.get(family)?.cancel();
        const result = await logoutCli(family);
        cliState.set(family, { ...(cliState.get(family) || {}), ...result, login: null });
        say(`${AGENTS[family].label}: выход из аккаунта`);
      }
    }
  };

  void (async () => {
    for (;;) {
      try { await cliTick(); } catch (error) { say(`сбой проверки входа: ${error.message}`); }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  })();

  for (;;) {
    try { await tick(); } catch (error) { say(`сбой цикла: ${error.message}`); }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

// ─── команды ──────────────────────────────────────────────────────────────────

async function install(args) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) fail(`нужен Node 20 или новее, сейчас ${process.versions.node}. Скачайте с https://nodejs.org`);
  const url = String(args.url || process.env.MBOX_URL || "").replace(/\/+$/, "");
  const user = String(args.user || process.env.MBOX_USERNAME || "");
  const token = String(args.token || process.env.MBOX_TOKEN || "");
  if (!url || !user || !token) fail("укажите --url, --user и --token (личный токен берётся в MBOX: Настройки → Агенты на этом компьютере).");
  const dir = agentDir(args);
  const config = {
    url, user, token,
    project: args.project ? String(args.project) : undefined,
    workdir: args.workdir ? path.resolve(String(args.workdir)) : path.join(os.homedir(), "MBOX-agent"),
    agents: { claude: { enabled: args.only ? args.only === "claude" : true }, codex: { enabled: args.only ? args.only === "codex" : true } },
  };

  out(`MBOX Agent → ${url}, аккаунт ${user}`);
  try {
    const me = await (await api(config, "/api/mbox/auth/me")).json();
    if (!me.user) fail("сервер не принял токен. Создайте новый в настройках MBOX.");
  } catch (error) {
    fail(error.status === 401 ? "сервер не принял токен. Создайте новый в настройках MBOX." : `не достучался до ${url}: ${error.message}`);
  }
  out("  вход в MBOX: ок");

  for (const [family, info] of Object.entries(AGENTS)) {
    const version = hasCli(info.cli);
    if (version) out(`  ${info.label}: найден (${version})`);
    else out(`  ${info.label}: не найден — пропущу, пока не поставите: ${info.install}\n    Нет подписки — выключите: node mbox-agent.mjs disable ${family}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  writeConfig(dir, config);
  out("  скачиваю файлы…");
  const kit = await downloadKit(config, dir).catch((error) => fail(`не скачались файлы: ${error.message}`));
  // Сам установщик тоже ложится в scripts/ — оттуда его запускает автозапуск.
  const selfTarget = path.join(dir, "scripts", "mbox-agent.mjs");
  if (path.resolve(fileURLToPath(import.meta.url)) !== path.resolve(selfTarget)) fs.copyFileSync(fileURLToPath(import.meta.url), selfTarget);
  if (kit.hasPackage) {
    out("  ставлю зависимости (MCP-инструменты MBOX для агентов)…");
    if (!installDependencies(dir)) out("  ! npm install не удался — агенты будут работать без MCP-инструментов MBOX. Повторите: node mbox-agent.mjs update");
  }

  if (!args["no-autostart"]) {
    const placed = installAutostart(dir);
    out(placed ? `  автозапуск: ${placed}` : "  автозапуск не настроен (нет systemd --user) — запускайте: node mbox-agent.mjs run");
  }
  if (!args["no-start"]) {
    if (runningPid(dir)) out("  уже запущен");
    else {
      const child = spawn(process.execPath, [selfTarget, "run", "--dir", dir], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      out(`  запущен (pid ${child.pid})`);
    }
  }
  out("\nГотово. Проверка: node " + JSON.stringify(selfTarget) + " status");
  out("Агентов можно выключить в настройках MBOX или командой: node mbox-agent.mjs disable claude|codex");
}

async function status(args) {
  const dir = agentDir(args);
  const config = readConfig(dir);
  if (!config) fail(`не установлено (нет ${configPath(dir)}). Запустите install.`);
  const pid = runningPid(dir);
  out(`Сервер: ${config.url}, аккаунт ${config.user}`);
  out(`Служба: ${pid ? `работает (pid ${pid})` : "не запущена — node mbox-agent.mjs run"}`);
  const prefs = await serverPrefs(config);
  for (const [family, info] of Object.entries(AGENTS)) {
    const local = config.agents?.[family]?.enabled !== false;
    const remote = prefs?.[family]?.enabled !== false;
    const cli = hasCli(info.cli);
    let login = "";
    if (cli) {
      try { const { checkCli } = await import("./cli-auth.mjs"); const state = await checkCli(family); login = state.logged_in === true ? "; вход выполнен" : state.logged_in === false ? `; НЕ выполнен вход — откройте чат в MBOX и нажмите «Войти», либо запустите ${info.cli} в терминале` : ""; } catch { /* набор ещё не скачан */ }
    }
    out(`  ${info.label}: ${local && remote ? "включён" : "выключен"}${!local ? " (здесь)" : ""}${!remote ? " (в настройках MBOX)" : ""}; CLI ${cli ? "найден" : "не найден"}${login}`);
  }
  out(`Журнал: ${path.join(dir, "agent.log")}`);
}

function toggle(args, enabled) {
  const dir = agentDir(args);
  const config = readConfig(dir);
  if (!config) fail("не установлено.");
  const family = String(args._[1] || "").toLowerCase().replace("chatgpt", "codex").replace(/^claude.*/, "claude");
  if (!AGENTS[family]) fail("укажите агента: claude или codex.");
  config.agents = { ...(config.agents || {}), [family]: { ...(config.agents?.[family] || {}), enabled } };
  writeConfig(dir, config);
  out(`${AGENTS[family].label}: ${enabled ? "включён" : "выключен"} (применится в течение 10 секунд).`);
}

async function update(args) {
  const dir = agentDir(args);
  const config = readConfig(dir);
  if (!config) fail("не установлено.");
  const kit = await downloadKit(config, dir).catch((error) => fail(`не скачались файлы: ${error.message}`));
  out(kit.changed ? `Обновлено файлов: ${kit.changed}. Перезапуск службы…` : "Файлы уже свежие.");
  if (kit.changed) {
    if (kit.hasPackage) installDependencies(dir);
    const pid = runningPid(dir);
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* уже нет */ } }
    const child = spawn(process.execPath, [path.join(dir, "scripts", "mbox-agent.mjs"), "run", "--dir", dir], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
}

function uninstall(args) {
  const dir = agentDir(args);
  const pid = runningPid(dir);
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* уже нет */ } }
  out(removeAutostart() ? "Автозапуск убран." : "Автозапуска не было.");
  out(`Файлы остались в ${dir} (удалите папку вручную, если не нужны).`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";
try {
  if (command === "install") await install(args);
  else if (command === "run") await supervise(agentDir(args));
  else if (command === "status") await status(args);
  else if (command === "enable") toggle(args, true);
  else if (command === "disable") toggle(args, false);
  else if (command === "update") await update(args);
  else if (command === "uninstall") uninstall(args);
  else out(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 12).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
} catch (error) {
  fail(error.message);
}
void HERE;
