// Ноды: Ubuntu/Debian-серверы с Claude Code и Codex, подключённые к MBOX по SSH.
//
// Человек вводит три поля (адрес, логин, пароль). Дальше сервер MBOX сам:
//   1. снимает отпечаток ключа сервера (SSH host key) и просит подтвердить его — после этого он закреплён и проверяется
//      при каждом подключении;
//   2. один раз заходит по паролю, ставит сервис-пользователя mboxagent с НАШИМ SSH-ключом, Node.js, Claude Code, Codex
//      и наблюдателей агентов как службы systemd (server/node-agent-install.sh), выпускает ноде отдельный токен MBOX;
//   3. проверяет вход по ключу и стирает пароль: он жил только в памяти процесса на время установки;
//   4. дальше управляет нодой только по ключу от имени mboxagent (проверка, вход в Claude/Codex, обновление, удаление) —
//      root ему не нужен, службами и удалением ведают два скрипта в /usr/local/sbin по узкому правилу sudo.
// Вход в Claude и Codex человек подтверждает в интерфейсе (ссылка + код), CLI на ноде при этом работает в терминале SSH.
// Агенты ноды называются Claude-<имя> и Codex-<имя> и отвечают, когда к ним обращаются по имени (props.to).

import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { agentKitFiles } from "./accounts.mjs";

const { Client, utils } = ssh2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SCRIPT = path.join(HERE, "node-agent-install.sh");

const AGENT_USER = "mboxagent";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_NODES = 10;
const CONNECT_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOG_LIMIT = 6000;
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"; ';
const AGENTS = {
  claude: { label: "Claude Code", prefix: "Claude" },
  codex: { label: "Codex (ChatGPT)", prefix: "Codex" },
};

const secretKey = () => process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_nodes (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  host_key_sha256 TEXT NOT NULL,
  public_key TEXT NOT NULL DEFAULT '',
  private_key_ciphertext BYTEA,
  token_id BIGINT,
  status TEXT NOT NULL DEFAULT 'installing',
  step TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  agents JSONB NOT NULL DEFAULT '{}',
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);
`;

export async function ensureNodesSchema(query) {
  await query(SCHEMA_SQL);
  // Установка шла в памяти процесса: после перезапуска сервера она не продолжится.
  await query("UPDATE agent_nodes SET status = 'error', last_error = 'Установка прервана: сервер MBOX перезапускался. Удалите ноду и подключите заново.', updated_at = now() WHERE status = 'installing'");
}

// ─── защита от обращений во внутреннюю сеть сервера ──────────────────────────────────────────────────────────────

const allowLoopback = () => process.env.MBOX_NODES_ALLOW_LOOPBACK === "1";

function forbiddenAddress(address) {
  if (allowLoopback()) return false;
  const value = String(address).toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return forbiddenAddress(mapped[1]);
  return value === "::" || value === "::1" || value.startsWith("fe80:") || value.startsWith("ff");
}

/** Адрес ноды → IP, с которого можно подключаться. Закольцовку и link-local (в том числе метаданные облака) не пускаем. */
async function resolveNodeHost(host) {
  if (!HOST_RE.test(host)) throw new Error("Адрес ноды выглядит неверно: нужен IP или доменное имя");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((item) => item.address);
  if (!addresses.length) throw new Error(`Не удалось найти адрес «${host}»`);
  if (addresses.some(forbiddenAddress)) throw new Error("Этот адрес — внутренний адрес сервера MBOX, его нельзя использовать как ноду");
  return addresses[0];
}

// ─── SSH ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const hexToFingerprint = (hex) => `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;

/**
 * Подключение. fingerprint — закреплённый отпечаток ключа сервера: другой ключ — отказ до отправки пароля.
 * seenOnly — только снять отпечаток и выйти (без попытки входа).
 */
function connectSsh({ host, port, username, password, privateKey, fingerprint, seenOnly = false }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = "";
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    conn.on("ready", () => done(resolve, { conn, fingerprint: seen }));
    conn.on("error", (error) => {
      if (seenOnly && seen) return done(resolve, { conn: null, fingerprint: seen });
      const message = String(error?.message || error);
      if (/authentication methods failed|All configured authentication/i.test(message)) return done(reject, Object.assign(new Error("Неверный логин или пароль"), { code: "auth" }));
      if (/ECONNREFUSED/.test(message)) return done(reject, new Error("Нода отказала в подключении: SSH не запущен или порт закрыт"));
      if (/ETIMEDOUT|Timed out|timeout/i.test(message)) return done(reject, new Error("Нода не отвечает: проверьте адрес, порт и файрвол"));
      if (/ENOTFOUND|EAI_AGAIN/.test(message)) return done(reject, new Error("Не удалось найти адрес ноды"));
      if (/Host denied|verification failed|Handshake failed/i.test(message) && fingerprint) return done(reject, Object.assign(new Error("Ключ сервера изменился: это не та нода, которую вы подтверждали. Подключение остановлено."), { code: "hostkey" }));
      return done(reject, new Error(`SSH: ${message}`));
    });
    conn.on("close", () => (seenOnly && seen ? done(resolve, { conn: null, fingerprint: seen }) : done(reject, new Error("Соединение закрыто до входа"))));
    try {
      conn.connect({
        host, port, username, password, privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 10_000,
        hostHash: "sha256",
        hostVerifier: (hash, callback) => {
          seen = hexToFingerprint(hash);
          if (seenOnly) return callback(false);
          callback(fingerprint ? seen === fingerprint : true);
        },
      });
    } catch (error) {
      done(reject, error);
    }
  });
}

/** Выполняет команду, отдаёт { code, out } (stdout и stderr вместе). stdin — строка, которую нужно подать на вход. */
function execOnce(conn, command, { stdin = null, pty = false, onLine = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, pty ? { pty: { term: "xterm-256color", cols: 1000, rows: 40 } } : {}, (error, stream) => {
      if (error) return reject(error);
      let out = "";
      let pending = "";
      let timer = null;
      const feed = (chunk) => {
        const text = chunk.toString("utf8");
        out += text;
        if (out.length > 200_000) out = out.slice(-100_000);
        if (!onLine) return;
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      };
      stream.on("data", feed);
      stream.stderr?.on("data", feed);
      stream.on("close", (code) => { if (timer) clearTimeout(timer); if (onLine && pending) onLine(pending); resolve({ code: code ?? 0, out }); });
      if (timeoutMs) timer = setTimeout(() => { try { stream.close(); } catch { /* уже закрыт */ } }, timeoutMs);
      if (stdin !== null) stream.end(stdin); else if (!pty) stream.end();
    });
  });
}

function sftpOpen(conn) {
  return new Promise((resolve, reject) => conn.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))));
}
const sftpWrite = (sftp, remote, data, mode = 0o644) => new Promise((resolve, reject) => sftp.writeFile(remote, data, { mode }, (error) => (error ? reject(error) : resolve())));
const sftpMkdir = (sftp, remote) => new Promise((resolve) => sftp.mkdir(remote, { mode: 0o700 }, () => resolve()));

const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const stripAnsi = (text) => String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");

/** Секреты в журнал не попадают: пароль, токены MBOX и Claude. */
function redactor(...secrets) {
  const list = secrets.filter((item) => item && String(item).length >= 4).map(String);
  return (text) => {
    let value = String(text);
    for (const secret of list) value = value.split(secret).join("***");
    return value.replace(/mbox_[A-Za-z0-9_-]{20,}/g, "mbox_***").replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***");
  };
}

// ─── состояние и журнал ───────────────────────────────────────────────────────────────────────────────────────────

const busy = new Set(); // ноды, с которыми сейчас идёт установка или обновление
const logins = new Map(); // `${id}:${agent}` → сессия входа в CLI (только в памяти)
const attempts = new Map(); // ограничение частоты: ключ → [время…]

function tooOften(key, limit, windowMs) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < windowMs);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > limit;
}

async function patchNode(query, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((key, index) => `${key} = $${index + 2}`);
  const value = (item) => (item !== null && typeof item === "object" && !(item instanceof Date) ? JSON.stringify(item) : item);
  await query(`UPDATE agent_nodes SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [id, ...keys.map((key) => value(fields[key]))]);
}

async function appendLog(query, id, text, step = null) {
  const line = String(text).replace(/\s+$/, "");
  if (!line && !step) return;
  await query(
    `UPDATE agent_nodes SET log = RIGHT(log || $2, ${LOG_LIMIT}), step = COALESCE($3, step), updated_at = now() WHERE id = $1`,
    [id, line ? `${line}\n` : "", step],
  );
}

const agentNames = (nodeName) => ({ claude: `Claude-${nodeName}`, codex: `Codex-${nodeName}` });

async function publicNode(query, row) {
  const names = agentNames(row.name);
  const online = (await query(
    "SELECT agent_name FROM agent_presence WHERE owner_user_id = $1 AND agent_name = ANY($2::text[]) AND last_seen > now() - interval '2 minutes'",
    [row.owner_user_id, Object.values(names)],
  ).catch(() => ({ rows: [] }))).rows.map((item) => item.agent_name);
  const agents = {};
  for (const family of Object.keys(AGENTS)) {
    const known = row.agents?.[family] || {};
    const session = logins.get(`${row.id}:${family}`);
    agents[family] = {
      name: names[family],
      installed: known.installed === true,
      logged_in: known.logged_in === true,
      account: known.account || "",
      service: known.service || "",
      online: online.includes(names[family]),
      login: session ? { state: session.state, url: session.url, user_code: session.userCode, message: session.message } : null,
    };
  }
  return {
    id: String(row.id), name: row.name, host: row.host, port: row.port, ssh_user: row.ssh_user, fingerprint: row.host_key_sha256,
    status: row.status, step: row.step, log: row.log, last_error: row.last_error, agents,
    checked_at: row.checked_at, created_at: row.created_at,
  };
}

const privateKeyOf = async (query, id) => (await query("SELECT pgp_sym_decrypt(private_key_ciphertext, $2) AS key FROM agent_nodes WHERE id = $1", [id, secretKey()])).rows[0]?.key || "";

/** Подключение к ноде по нашему ключу от имени mboxagent (отпечаток закреплён). */
async function connectNode(query, row) {
  const privateKey = await privateKeyOf(query, row.id);
  if (!privateKey) throw new Error("У ноды нет сохранённого ключа: удалите и подключите её заново");
  const ip = await resolveNodeHost(row.host);
  return connectSsh({ host: ip, port: row.port, username: AGENT_USER, privateKey, fingerprint: row.host_key_sha256 });
}

// ─── проверка состояния ───────────────────────────────────────────────────────────────────────────────────────

/** Что на ноде: установлены ли Claude/Codex, выполнен ли вход, работают ли службы. */
async function inspectNode(conn) {
  const run = (command) => execOnce(conn, PATH_PREFIX + command, { timeoutMs: 40_000 });
  const claudeRaw = await run('if command -v claude >/dev/null 2>&1; then claude auth status 2>&1 | head -c 1500; echo "__rc=${PIPESTATUS[0]}"; else echo __missing__; fi');
  const codexRaw = await run('if command -v codex >/dev/null 2>&1; then codex login status 2>&1 | head -c 800; echo "__rc=${PIPESTATUS[0]}"; else echo __missing__; fi');
  const services = await run("sudo -n /usr/local/sbin/mbox-node-ctl status all 2>&1");

  const claudeText = stripAnsi(claudeRaw.out);
  const codexText = stripAnsi(codexRaw.out);
  const result = { claude: { installed: !/__missing__/.test(claudeText), logged_in: false, account: "" }, codex: { installed: !/__missing__/.test(codexText), logged_in: false, account: "" } };
  if (result.claude.installed) {
    try {
      const json = JSON.parse(claudeText.slice(claudeText.indexOf("{"), claudeText.lastIndexOf("}") + 1));
      result.claude.logged_in = Boolean(json.loggedIn);
      result.claude.account = String(json.email || json.orgName || json.authMethod || "");
    } catch {
      result.claude.logged_in = /__rc=0/.test(claudeText) && !/not logged in|please log in|unauthenticated/i.test(claudeText);
    }
  }
  if (result.codex.installed) {
    result.codex.logged_in = /__rc=0/.test(codexText) && !/not logged in|please log in|unauthenticated/i.test(codexText);
    result.codex.account = result.codex.logged_in ? codexText.split("\n").find((line) => line.trim() && !line.startsWith("__rc")).trim().slice(0, 120) : "";
  }
  for (const line of stripAnsi(services.out).split("\n")) {
    const match = line.match(/^mbox-node-(claude|codex)\.service (\S+) (\S+)/);
    if (match) result[match[1]].service = match[2] === "active" ? "active" : match[2];
  }
  return result;
}

async function refreshNode(query, row) {
  const { conn } = await connectNode(query, row);
  try {
    const agents = await inspectNode(conn);
    await patchNode(query, row.id, { agents, checked_at: new Date(), last_error: "" });
    return agents;
  } finally {
    conn.end();
  }
}

// ─── установка ─────────────────────────────────────────────────────────────────────────────────────────────────

function installEnvFile({ nodeName, origin, token, publicKey }) {
  const values = { NODE_NAME: nodeName, MBOX_URL: origin, MBOX_TOKEN: token, SSH_PUBKEY: publicKey, MBOX_PROJECT: process.env.MBOX_PROJECT || "MBOX" };
  for (const [key, value] of Object.entries(values)) if (/['\n\r]/.test(String(value))) throw new Error(`Недопустимое значение ${key}`);
  return `${Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n")}\n`;
}

/** Кладёт набор агента и скрипт установки на ноду. Возвращает каталог на ноде. */
async function uploadKit(conn, extra = {}) {
  const made = await execOnce(conn, "umask 077; mktemp -d /tmp/mbox-node.XXXXXX");
  const dir = stripAnsi(made.out).trim().split("\n").pop();
  if (made.code !== 0 || !/^\/tmp\/mbox-node\.[A-Za-z0-9]+$/.test(dir)) throw new Error("Не удалось создать временный каталог на ноде");
  const sftp = await sftpOpen(conn);
  try {
    await sftpMkdir(sftp, `${dir}/kit`);
    await sftpMkdir(sftp, `${dir}/kit/scripts`);
    for (const [name, text] of agentKitFiles()) {
      const target = name === "package.json" ? `${dir}/kit/package.json` : `${dir}/kit/scripts/${name}`;
      await sftpWrite(sftp, target, text.replace(/\r\n/g, "\n"), 0o644);
    }
    const script = fs.readFileSync(INSTALL_SCRIPT, "utf8").replace(/\r\n/g, "\n");
    await sftpWrite(sftp, `${dir}/install.sh`, script, 0o700);
    for (const [name, text] of Object.entries(extra)) await sftpWrite(sftp, `${dir}/${name}`, text, 0o600);
  } finally {
    sftp.end();
  }
  return dir;
}

async function revokeToken(query, node) {
  if (node.token_id) await query("DELETE FROM account_tokens WHERE id = $1 AND user_id = $2", [node.token_id, node.owner_user_id]).catch(() => undefined);
}

async function issueToken(query, userId, nodeName) {
  const token = `mbox_${randomBytes(32).toString("base64url")}`;
  const row = (await query(
    "INSERT INTO account_tokens(user_id, token_hash, label) VALUES ($1, $2, $3) RETURNING id::text",
    [userId, createHash("sha256").update(token).digest("hex"), `Нода ${nodeName}`],
  )).rows[0];
  return { token, tokenId: row.id };
}

/**
 * Полная установка. password живёт только в этом замыкании и стирается в finally.
 * Ход пишется в agent_nodes.step/log — интерфейс опрашивает список нод.
 */
async function runInstall({ query, node, password, origin }) {
  let secret = password;
  let token = "";
  let redact = redactor(secret);
  const say = (text, step = null) => appendLog(query, node.id, redact(text), step).catch(() => undefined);
  let passwordConn = null;
  try {
    const ip = await resolveNodeHost(node.host);
    await say("", "Подключение по паролю");
    const login = await connectSsh({ host: ip, port: node.port, username: node.ssh_user, password: secret, fingerprint: node.host_key_sha256 });
    passwordConn = login.conn;

    const idRes = await execOnce(passwordConn, "id -u");
    const isRoot = stripAnsi(idRes.out).trim() === "0";
    let prefix = "";
    let stdin = null;
    if (!isRoot) {
      const nopass = await execOnce(passwordConn, "sudo -n true 2>&1");
      if (nopass.code === 0) prefix = "sudo -n ";
      else {
        const probe = await execOnce(passwordConn, "sudo -S -p '' true 2>&1", { stdin: `${secret}\n` });
        if (probe.code !== 0) throw new Error(`У пользователя ${node.ssh_user} нет прав sudo: подключите ноду под root или под пользователем с sudo`);
        prefix = "sudo -S -p '' ";
        stdin = `${secret}\n`;
      }
    }

    // Отдельный токен MBOX для этой ноды (отзывается при удалении) и наш ключ.
    const issued = await issueToken(query, node.owner_user_id, node.name);
    token = issued.token;
    await patchNode(query, node.id, { token_id: issued.tokenId });
    const publicKey = (await query("SELECT public_key FROM agent_nodes WHERE id = $1", [node.id])).rows[0].public_key;

    await say("", "Загрузка файлов на ноду");
    const dir = await uploadKit(passwordConn, { env: installEnvFile({ nodeName: node.name, origin, token, publicKey }) });
    redact = redactor(secret, token);

    await say("", "Установка на ноде");
    let failure = "";
    const result = await execOnce(passwordConn, `${prefix}bash ${dir}/install.sh ${dir}/env ${dir}/kit 2>&1`, {
      stdin,
      timeoutMs: 25 * 60_000,
      onLine: (rawLine) => {
        const line = stripAnsi(rawLine);
        const stepMatch = line.match(/^##STEP (.+)$/);
        const failMatch = line.match(/^##FAIL (.+)$/);
        if (stepMatch) void appendLog(query, node.id, redact(`▸ ${stepMatch[1]}`), stepMatch[1]);
        else if (failMatch) failure = failMatch[1];
        else if (line.trim() && !line.startsWith("##")) void appendLog(query, node.id, redact(line.slice(0, 300)));
      },
    });
    await execOnce(passwordConn, `rm -rf ${dir}`).catch(() => undefined);
    if (result.code !== 0 || !/##DONE/.test(result.out)) {
      const tail = stripAnsi(result.out).split("\n").filter((line) => line.trim() && !line.startsWith("##")).slice(-3).join(" ").slice(0, 300);
      throw new Error(failure || `Установка на ноде завершилась с ошибкой (код ${result.code}). ${redact(tail)}`);
    }

    // Проверка входа по ключу — только после неё пароль больше не нужен.
    await say("", "Проверка входа по ключу");
    passwordConn.end();
    passwordConn = null;
    const row = (await query("SELECT * FROM agent_nodes WHERE id = $1", [node.id])).rows[0];
    let keyConn;
    try {
      keyConn = (await connectNode(query, row)).conn;
    } catch (error) {
      throw new Error(`Установка прошла, но вход по ключу не получился (${error.message}). Проверьте, что sshd пускает пользователя ${AGENT_USER} (AllowUsers) и разрешает вход по ключу.`);
    }
    secret = null; // пароль больше не нужен
    try {
      const agents = await inspectNode(keyConn);
      await patchNode(query, node.id, { agents, status: "ready", step: "Готово", last_error: "", checked_at: new Date() });
      await say("Нода подключена. Осталось войти в Claude и Codex.");
    } finally {
      keyConn.end();
    }
  } catch (error) {
    await revokeTokenOnFailure(query, node);
    await patchNode(query, node.id, { status: "error", last_error: redact(String(error.message || error)).slice(0, 600), step: "Ошибка" }).catch(() => undefined);
    await say(`Ошибка: ${error.message || error}`);
  } finally {
    secret = null;
    try { passwordConn?.end(); } catch { /* уже закрыто */ }
    busy.delete(String(node.id));
  }
}

// Если установка упала до конца, токен для этой ноды не нужен: пересоздаётся при повторной попытке.
async function revokeTokenOnFailure(query, node) {
  const row = (await query("SELECT token_id, owner_user_id FROM agent_nodes WHERE id = $1", [node.id]).catch(() => ({ rows: [] }))).rows[0];
  if (row?.token_id) {
    await revokeToken(query, row);
    await patchNode(query, node.id, { token_id: null }).catch(() => undefined);
  }
}

// ─── обновление и вход в CLI ─────────────────────────────────────────────────────────────────────────────────

/** Обновление: свежий набор агента с сервера MBOX, npm install, перезапуск служб. Права root не нужны. */
async function runUpdate({ query, row }) {
  const say = (text, step = null) => appendLog(query, row.id, text, step).catch(() => undefined);
  let conn;
  try {
    await say("", "Подключение к ноде");
    conn = (await connectNode(query, row)).conn;
    await say("", "Обновление набора агента");
    const sftp = await sftpOpen(conn);
    try {
      for (const [name, text] of agentKitFiles()) {
        const target = name === "package.json" ? `/home/${AGENT_USER}/mbox-agent/package.json` : `/home/${AGENT_USER}/mbox-agent/scripts/${name}`;
        await sftpWrite(sftp, target, text.replace(/\r\n/g, "\n"), 0o644);
      }
    } finally {
      sftp.end();
    }
    const npm = await execOnce(conn, `${PATH_PREFIX}cd ~/mbox-agent && npm install --omit=dev --no-audit --no-fund --silent 2>&1 | tail -3`, { timeoutMs: 10 * 60_000 });
    if (npm.code !== 0) await say(`npm: ${stripAnsi(npm.out).slice(-200)}`);
    await say("", "Перезапуск служб");
    await execOnce(conn, "sudo -n /usr/local/sbin/mbox-node-ctl restart all 2>&1");
    const agents = await inspectNode(conn);
    await patchNode(query, row.id, { agents, status: "ready", step: "Готово", last_error: "", checked_at: new Date() });
    await say("Обновлено.");
  } catch (error) {
    await patchNode(query, row.id, { status: "error", last_error: String(error.message || error).slice(0, 600), step: "Ошибка" }).catch(() => undefined);
    await say(`Ошибка: ${error.message || error}`);
  } finally {
    try { conn?.end(); } catch { /* уже закрыто */ }
    busy.delete(String(row.id));
  }
}

const CLI_URL = /https:\/\/[^\s"'<>\x1b]+/;
const USER_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/;

/**
 * Вход в Claude Code или Codex на ноде. CLI работает в терминале SSH под mboxagent; ссылку и код показывает интерфейс,
 * человек подтверждает вход у себя в браузере. Claude просит вставить код обратно (sendLoginCode), Codex завершается сам.
 */
async function startLogin({ query, row, agent }) {
  const key = `${row.id}:${agent}`;
  const existing = logins.get(key);
  if (existing && ["starting", "waiting", "verifying"].includes(existing.state)) return existing;
  const session = { state: "starting", url: "", userCode: "", message: "", buffer: "", stream: null, conn: null, startedAt: Date.now(), timer: null };
  logins.set(key, session);
  const finish = async (state, message) => {
    if (session.closing) return;
    session.closing = true;
    clearTimeout(session.timer);
    try { session.stream?.close(); } catch { /* уже закрыт */ }
    try { session.conn?.end(); } catch { /* уже закрыт */ }
    // Подтверждённый вход: пока служба не запущена и состояние не обновлено, интерфейс видит «проверяю» и продолжает опрос.
    if (state === "done") {
      session.state = "verifying";
      session.message = "Запускаю агента на ноде";
      try {
        const fresh = (await query("SELECT * FROM agent_nodes WHERE id = $1", [row.id])).rows[0];
        const { conn } = await connectNode(query, fresh);
        try {
          await execOnce(conn, `sudo -n /usr/local/sbin/mbox-node-ctl enable ${agent} 2>&1`);
          const agents = await inspectNode(conn);
          await patchNode(query, row.id, { agents, checked_at: new Date(), last_error: "" });
        } finally { conn.end(); }
      } catch (error) {
        message = `Вход выполнен, но запустить службу не удалось: ${error.message}`;
      }
    }
    session.state = state;
    session.message = message;
    setTimeout(() => { if (logins.get(key) === session) logins.delete(key); }, 60_000).unref?.();
  };
  session.finish = finish;
  session.timer = setTimeout(() => void finish("failed", "Время входа вышло (10 минут). Нажмите «Войти» ещё раз."), LOGIN_TIMEOUT_MS);
  session.timer.unref?.();

  try {
    const { conn } = await connectNode(query, row);
    session.conn = conn;
    const command = agent === "claude" ? "claude auth login" : "codex login --device-auth";
    const check = async () => {
      if (session.closing) return;
      session.state = "verifying";
      const agents = await inspectNode(conn).catch(() => null);
      if (agents?.[agent]?.logged_in) await finish("done", agents[agent].account || "Вход выполнен");
      else await finish("failed", "Вход не завершён. Нажмите «Войти» ещё раз и подтвердите вход в браузере.");
    };
    conn.exec(`${PATH_PREFIX}export BROWSER=true; ${command}`, { pty: { term: "xterm-256color", cols: 1000, rows: 40 } }, (error, stream) => {
      if (error) return void finish("failed", `Не удалось запустить вход: ${error.message}`);
      session.stream = stream;
      stream.on("data", (chunk) => {
        session.buffer = `${session.buffer}${stripAnsi(chunk.toString("utf8"))}`.slice(-6000);
        if (!session.url) {
          const found = session.buffer.match(CLI_URL);
          if (found) { session.url = found[0].replace(/[).,]+$/, ""); if (session.state === "starting") session.state = "waiting"; }
        }
        if (agent === "codex" && !session.userCode) {
          const code = session.buffer.match(USER_CODE);
          if (code) session.userCode = code[1];
        }
      });
      stream.on("close", () => { if (!session.closing) void check(); });
    });
  } catch (error) {
    await finish("failed", String(error.message || error));
  }
  return session;
}

function sendLoginCode(row, agent, code) {
  const session = logins.get(`${row.id}:${agent}`);
  if (!session || session.state !== "waiting" || !session.stream) return false;
  session.stream.write(`${String(code).trim()}\r`);
  return true;
}

function cancelLogin(row, agent) {
  const session = logins.get(`${row.id}:${agent}`);
  if (session?.finish) void session.finish("failed", "Вход отменён.");
  return Boolean(session);
}

// ─── удаление ─────────────────────────────────────────────────────────────────────────────────────────────────

async function removeNode(query, row) {
  let note = "";
  try {
    const { conn } = await connectNode(query, row);
    try {
      const result = await execOnce(conn, "sudo -n /usr/local/sbin/mbox-node-uninstall 2>&1", { timeoutMs: 60_000 });
      if (result.code !== 0) note = "Со стороны ноды удалить не вышло — службы можно остановить вручную.";
    } finally { conn.end(); }
  } catch (error) {
    note = `Нода недоступна (${error.message}): службы на ней остались, но токен MBOX отозван, и агенты работать не смогут.`;
  }
  for (const agent of Object.keys(AGENTS)) cancelLogin(row, agent);
  await revokeToken(query, row);
  await query("DELETE FROM agent_nodes WHERE id = $1", [row.id]);
  return note;
}

// ─── API ───────────────────────────────────────────────────────────────────────────────────────────────────────

const defaultName = (host) => String(host).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "node";

/**
 * Ноды (только владелец инстанса):
 *   GET    /api/mbox/nodes                      — список нод
 *   POST   /api/mbox/nodes/probe                — {host, port}: отпечаток ключа сервера для подтверждения
 *   POST   /api/mbox/nodes                      — {host, port?, ssh_user, password, fingerprint, name?}: установка (в фоне)
 *   POST   /api/mbox/nodes/:id/check            — перепроверить состояние
 *   POST   /api/mbox/nodes/:id/update           — обновить набор агента и перезапустить службы
 *   POST   /api/mbox/nodes/:id/restart          — перезапустить службы
 *   POST   /api/mbox/nodes/:id/login            — {agent: claude|codex}: начать вход в CLI
 *   POST   /api/mbox/nodes/:id/login/code       — {agent, code}: код, который показал Claude после входа в браузере
 *   DELETE /api/mbox/nodes/:id/login?agent=     — отменить вход
 *   DELETE /api/mbox/nodes/:id                  — снять агентов с ноды и забыть её
 */
export async function handleNodesApi({ req, res, url, query, readBody, sendJson, user, owner, origin }) {
  if (!url.pathname.startsWith("/api/mbox/nodes")) return false;
  if (!owner) { sendJson(res, 403, { error: "Ноды подключает владелец MBOX" }); return true; }
  const userId = String(user.id);
  const fail = (status, error) => { sendJson(res, status, { error }); return true; };
  const list = async () => {
    const rows = (await query("SELECT * FROM agent_nodes WHERE owner_user_id = $1 ORDER BY id", [userId])).rows;
    return { nodes: await Promise.all(rows.map((row) => publicNode(query, row))) };
  };

  if (url.pathname === "/api/mbox/nodes" && req.method === "GET") {
    sendJson(res, 200, await list());
    return true;
  }

  if (url.pathname === "/api/mbox/nodes/probe" && req.method === "POST") {
    if (tooOften(`probe:${userId}`, 12, 60_000)) return fail(429, "Слишком много проверок подряд — подождите минуту");
    const body = await readBody(req);
    const host = String(body.host || "").trim();
    const port = Number(body.port) || 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(400, "Порт должен быть числом от 1 до 65535");
    try {
      const ip = await resolveNodeHost(host);
      const { fingerprint } = await connectSsh({ host: ip, port, username: "mbox-probe", seenOnly: true });
      sendJson(res, 200, { host, port, ip, fingerprint });
    } catch (error) {
      return fail(400, String(error.message || error));
    }
    return true;
  }

  if (url.pathname === "/api/mbox/nodes" && req.method === "POST") {
    if (tooOften(`install:${userId}`, 6, 10 * 60_000)) return fail(429, "Слишком много попыток подключения — подождите несколько минут");
    const body = await readBody(req);
    const host = String(body.host || "").trim();
    const port = Number(body.port) || 22;
    const sshUser = String(body.ssh_user || "root").trim();
    const password = String(body.password || "");
    const fingerprint = String(body.fingerprint || "").trim();
    const name = String(body.name || "").trim().toLowerCase() || defaultName(host);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(400, "Порт должен быть числом от 1 до 65535");
    if (!USER_RE.test(sshUser)) return fail(400, "Логин выглядит неверно");
    if (!password) return fail(400, "Введите пароль: он нужен только для первой установки и нигде не сохраняется");
    if (!FINGERPRINT_RE.test(fingerprint)) return fail(400, "Сначала подтвердите отпечаток ключа сервера");
    if (!NAME_RE.test(name)) return fail(400, "Название: 2–24 символа, строчные латинские буквы, цифры и дефис");
    const count = (await query("SELECT count(*)::int AS n FROM agent_nodes WHERE owner_user_id = $1", [userId])).rows[0].n;
    if (count >= MAX_NODES) return fail(409, `Нод может быть не больше ${MAX_NODES}`);
    if ((await query("SELECT 1 FROM agent_nodes WHERE owner_user_id = $1 AND name = $2", [userId, name])).rows.length) return fail(409, `Нода «${name}» уже есть: выберите другое название или удалите прежнюю`);
    try { await resolveNodeHost(host); } catch (error) { return fail(400, String(error.message || error)); }

    const pair = utils.generateKeyPairSync("ed25519", { comment: `mbox-node-${name}` });
    const row = (await query(
      `INSERT INTO agent_nodes(owner_user_id, name, host, port, ssh_user, host_key_sha256, public_key, private_key_ciphertext, status, step)
       VALUES ($1, $2, $3, $4, $5, $6, $7, pgp_sym_encrypt($8, $9), 'installing', 'Подключение')
       RETURNING *`,
      [userId, name, host, port, sshUser, fingerprint, pair.public.trim(), pair.private, secretKey()],
    )).rows[0];
    busy.add(String(row.id));
    void runInstall({ query, node: row, password, origin });
    sendJson(res, 201, { node: await publicNode(query, row) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/mbox\/nodes\/(\d+)(?:\/(login\/code|login|check|update|restart))?$/);
  if (!match) return false;
  const row = (await query("SELECT * FROM agent_nodes WHERE id = $1 AND owner_user_id = $2", [match[1], userId])).rows[0];
  if (!row) return fail(404, "Нода не найдена");
  const action = match[2] || "";
  const sendNode = async (status = 200) => {
    const fresh = (await query("SELECT * FROM agent_nodes WHERE id = $1", [row.id])).rows[0];
    sendJson(res, status, { node: fresh ? await publicNode(query, fresh) : null });
    return true;
  };

  if (!action && req.method === "DELETE") {
    if (busy.has(String(row.id))) return fail(409, "Сейчас идёт установка или обновление этой ноды — дождитесь конца");
    const note = await removeNode(query, row);
    sendJson(res, 200, { ...(await list()), note });
    return true;
  }

  if (action === "check" && req.method === "POST") {
    if (row.status === "installing") return fail(409, "Идёт установка");
    try { await refreshNode(query, row); } catch (error) {
      await patchNode(query, row.id, { last_error: String(error.message || error).slice(0, 600) });
    }
    return sendNode();
  }

  if (action === "update" && req.method === "POST") {
    if (busy.has(String(row.id)) || row.status === "installing") return fail(409, "Нода занята");
    busy.add(String(row.id));
    await patchNode(query, row.id, { status: "installing", step: "Обновление" });
    void runUpdate({ query, row });
    return sendNode();
  }

  if (action === "restart" && req.method === "POST") {
    try {
      const { conn } = await connectNode(query, row);
      try { await execOnce(conn, "sudo -n /usr/local/sbin/mbox-node-ctl restart all 2>&1"); const agents = await inspectNode(conn); await patchNode(query, row.id, { agents, checked_at: new Date(), last_error: "" }); } finally { conn.end(); }
    } catch (error) { await patchNode(query, row.id, { last_error: String(error.message || error).slice(0, 600) }); }
    return sendNode();
  }

  if (action === "login" || action === "login/code") {
    const body = req.method === "DELETE" ? {} : await readBody(req);
    const agent = String(body.agent || url.searchParams.get("agent") || "");
    if (!AGENTS[agent]) return fail(400, "agent: claude или codex");
    if (row.status !== "ready") return fail(409, "Нода ещё не готова");
    if (action === "login" && req.method === "POST") {
      if (tooOften(`login:${row.id}`, 10, 10 * 60_000)) return fail(429, "Слишком много попыток входа — подождите");
      await startLogin({ query, row, agent });
      return sendNode();
    }
    if (action === "login/code" && req.method === "POST") {
      const code = String(body.code || "").trim();
      if (!code || code.length > 600) return fail(400, "Вставьте код, который показала страница входа");
      if (!sendLoginCode(row, agent, code)) return fail(409, "Вход не ждёт код: нажмите «Войти» ещё раз");
      return sendNode();
    }
    if (action === "login" && req.method === "DELETE") {
      cancelLogin(row, agent);
      return sendNode();
    }
  }
  return false;
}

export { agentNames, NAME_RE as NODE_NAME_RE };
