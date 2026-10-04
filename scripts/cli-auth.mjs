// Проверка и вход в локальные CLI агентов (Claude Code, Codex): используется службой mbox-agent и MBOX Desktop.
// Входит сам CLI: он открывает браузер на этом компьютере и принимает ответ на локальный адрес. Пароли и токены сюда не попадают.
import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";

export const CLI_FAMILIES = {
  claude: { cli: "claude", label: "Claude Code", status: ["auth", "status"], login: ["auth", "login"], logout: ["auth", "logout"] },
  codex: { cli: "codex", label: "ChatGPT (Codex CLI)", status: ["login", "status"], login: ["login"], logout: ["logout"] },
};

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
const stripAnsi = (text) => String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function run(command, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) }); } };
    let child;
    try { child = spawn(command, args, { shell: IS_WIN, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { resolve({ code: -1, stdout: "", stderr: "" }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* уже завершён */ } finish(-2); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** { installed, logged_in, account }: logged_in = null, если определить не удалось (тогда агента не блокируем). */
export async function checkCli(family) {
  const spec = CLI_FAMILIES[family];
  if (!spec) return { installed: false, logged_in: null, account: "" };
  const version = await run(spec.cli, ["--version"]);
  if (version.code !== 0) return { installed: false, logged_in: null, account: "" };
  const status = await run(spec.cli, spec.status);
  const text = `${status.stdout}\n${status.stderr}`.trim();
  if (status.code === -2) return { installed: true, logged_in: null, account: "" };
  if (family === "claude") {
    try {
      const parsed = JSON.parse(status.stdout);
      return { installed: true, logged_in: Boolean(parsed.loggedIn), account: String(parsed.email || parsed.orgName || parsed.authMethod || "") };
    } catch { /* старая версия без JSON — смотрим на код выхода */ }
  }
  const loggedIn = status.code === 0 && !/not logged in|please log in|unauthenticated/i.test(text);
  return { installed: true, logged_in: loggedIn, account: loggedIn ? (text.split(/\r?\n/).find(Boolean) || "").slice(0, 120) : "" };
}

/**
 * Запускает вход: CLI сам открывает браузер. onUpdate получает { state: running|done|failed, url?, message? }.
 * Возвращает { cancel }.
 */
export function startLogin(family, onUpdate) {
  const spec = CLI_FAMILIES[family];
  let child;
  let finished = false;
  const done = (update) => { if (!finished) { finished = true; clearTimeout(timer); onUpdate(update); } };
  try { child = spawn(spec.cli, spec.login, { shell: IS_WIN, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { done({ state: "failed", message: String(error.message || error) }); return { cancel() {} }; }
  let seen = "";
  let url = "";
  const onData = (chunk) => {
    seen = `${seen}${stripAnsi(chunk)}`.slice(-4000);
    const found = !url && seen.match(URL_PATTERN);
    if (found) { url = found[0]; onUpdate({ state: "running", url }); }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const timer = setTimeout(() => { try { child.kill(); } catch { /* уже завершён */ } done({ state: "failed", message: "Время ожидания входа вышло. Нажмите «Войти» ещё раз." }); }, LOGIN_TIMEOUT_MS);
  child.on("error", () => done({ state: "failed", message: `Команда ${spec.cli} не запустилась. Проверьте, что ${spec.label} установлен.` }));
  child.on("close", async () => {
    const result = await checkCli(family);
    done(result.logged_in ? { state: "done", message: result.account } : { state: "failed", message: "Вход не завершён. Нажмите «Войти» и подтвердите вход в браузере." });
  });
  onUpdate({ state: "running", url: "" });
  return { cancel() { try { child.kill(); } catch { /* уже завершён */ } done({ state: "failed", message: "Вход отменён." }); } };
}

export async function logoutCli(family) {
  const spec = CLI_FAMILIES[family];
  await run(spec.cli, spec.logout, 30_000);
  return checkCli(family);
}
