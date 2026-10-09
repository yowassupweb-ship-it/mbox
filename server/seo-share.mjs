// Доступ к SEO Wizard без входа в MBOX: по ссылке (просмотр или управление) и по логину с паролем.
// Человек получает только SEO Wizard: внутри сервер пропускает белый список вызовов (isAllowed), всё остальное — 403.
// Настройки, ключи интеграций, платные действия и остальной MBOX недоступны ни по ссылке, ни по паролю.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "mbox_seo_session";
const SESSION_DAYS = 30;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const MODES = new Set(["view", "manage"]);

export async function ensureSeoShareSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS seo_shares (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('link', 'login')),
    mode TEXT NOT NULL CHECK (mode IN ('view', 'manage')),
    token TEXT UNIQUE,
    login TEXT UNIQUE,
    password_hash TEXT,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    use_count INT NOT NULL DEFAULT 0
  )`);
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_shares_link_mode ON seo_shares(mode) WHERE kind = 'link'");
  await query(`CREATE TABLE IF NOT EXISTS seo_share_sessions (
    token_hash TEXT PRIMARY KEY,
    share_id BIGINT NOT NULL REFERENCES seo_shares(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip TEXT NOT NULL DEFAULT ''
  )`);
}

// ─── Пароли и токены ─────────────────────────────────────────────────────────

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const newToken = (bytes = 24) => randomBytes(bytes).toString("base64url");
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

/** Пароль, который можно продиктовать: без похожих знаков (0/O, 1/l/I). */
export function generatePassword(length = 14) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// ─── Что разрешено по ссылке и паролю ────────────────────────────────────────

const READ = [
  /^dashboard$/, /^strategy$/, /^scenario$/, /^calendar$/, /^activity$/, /^health$/, /^page$/, /^history$/, /^tables$/,
  /^run\/status$/, /^package$/, /^positions\/checks$/, /^metrica\/goals$/, /^view\/[a-z0-9_]+$/, /^issues\/\d+\/detail$/,
];
// Перепроверка только открывает адреса сайта: безопасна и нужна тому, кто читает находки.
const VIEW_POST = [/^issues\/\d+\/verify$/];
const MANAGE = [
  { method: "PATCH", pattern: /^issues\/\d+$/ }, { method: "POST", pattern: /^issues\/\d+\/task$/ }, { method: "PATCH", pattern: /^urls\/\d+$/ },
  { method: "POST", pattern: /^outreach$/ }, { method: "PATCH", pattern: /^outreach\/\d+$/ }, { method: "DELETE", pattern: /^outreach\/\d+$/ },
  { method: "POST", pattern: /^changes$/ }, { method: "POST", pattern: /^run$/ }, { method: "POST", pattern: /^package$/ },
];

/**
 * Разрешён ли вызов. rest — путь после /api/mbox/seo/ без параметров. Возвращает { ok, reason }:
 * "not_allowed_in_share" — вызова нет в списке вообще (настройки, ключи, платные действия), "read_only_share" — запись при режиме просмотра.
 */
export function isAllowed(mode, method, rest) {
  const verb = String(method).toUpperCase();
  const path = String(rest || "").replace(/^\/+|\/+$/g, "");
  if (path.includes("..") || path.includes("//")) return { ok: false, reason: "not_allowed_in_share" };
  if (verb === "GET" && READ.some((pattern) => pattern.test(path))) return { ok: true };
  if (verb === "POST" && VIEW_POST.some((pattern) => pattern.test(path))) return { ok: true };
  const write = MANAGE.some((item) => item.method === verb && item.pattern.test(path));
  if (!write) return { ok: false, reason: "not_allowed_in_share" };
  return mode === "manage" ? { ok: true } : { ok: false, reason: "read_only_share" };
}

// ─── Защита входа от подбора ─────────────────────────────────────────────────

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;

/** Сколько секунд ждать до следующей попытки (0 — можно). Растёт после пяти неудач подряд с одного адреса на один логин. */
export function waitSeconds(key, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry || now - entry.last > WINDOW_MS * 4) return 0;
  if (entry.fails < 5) return 0;
  const pause = Math.min(WINDOW_MS, 2 ** (entry.fails - 5) * 30_000);
  return Math.max(0, Math.ceil((entry.last + pause - now) / 1000));
}

export function recordAttempt(key, ok, now = Date.now()) {
  if (ok) { attempts.delete(key); return; }
  const entry = attempts.get(key);
  attempts.set(key, { fails: (entry && now - entry.last <= WINDOW_MS * 4 ? entry.fails : 0) + 1, last: now });
}

export function resetAttempts() { attempts.clear(); }

// ─── Управление владельцем ───────────────────────────────────────────────────

/** Адрес, по которому человек снаружи откроет SEO Wizard: MBOX_PUBLIC_URL, иначе по заголовкам запроса (за прокси Caddy это боевой домен). */
export function publicBaseUrl(req) {
  const fixed = String(process.env.MBOX_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
  const proto = String(req.headers?.["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

const rowOut = (row) => ({ id: row.id, mode: row.mode, label: row.label, created_at: row.created_at, last_used_at: row.last_used_at, expires_at: row.expires_at, use_count: row.use_count });

/** Маршруты владельца: /api/mbox/seo/shares… (вызывается из обработчика SEO Wizard, доступного только владельцу). */
export async function handleSeoShareAdmin({ req, res, url, query, readBody, sendJson, actor = "" }) {
  const match = url.pathname.match(/^\/api\/mbox\/seo\/shares(?:\/(link|login)(?:\/([A-Za-z0-9_-]+))?)?$/);
  if (!match) return false;
  await ensureSeoShareSchema(query);
  const [, kind, id] = match;
  const reply = (status, body) => { sendJson(res, status, body); return true; };

  if (!kind && req.method === "GET") {
    const rows = (await query(
      `SELECT s.id::text, s.kind, s.mode, s.token, s.login, s.label, s.created_at::text, s.last_used_at::text, s.expires_at::text, s.use_count,
              (SELECT count(*)::int FROM seo_share_sessions x WHERE x.share_id = s.id AND x.expires_at > now()) AS sessions
         FROM seo_shares s ORDER BY s.created_at`,
    )).rows;
    const links = { view: null, manage: null };
    for (const row of rows.filter((item) => item.kind === "link")) links[row.mode] = { ...rowOut(row), token: row.token };
    return reply(200, { base_url: publicBaseUrl(req), links, logins: rows.filter((item) => item.kind === "login").map((row) => ({ ...rowOut(row), login: row.login, sessions: row.sessions })) });
  }

  if (kind === "link" && !id && req.method === "POST") {
    const body = await readBody(req);
    if (!MODES.has(body.mode)) return reply(400, { error: "invalid_mode" });
    const existing = (await query("SELECT id::text, token FROM seo_shares WHERE kind = 'link' AND mode = $1", [body.mode])).rows[0];
    if (existing && !body.regenerate) return reply(200, { link: { mode: body.mode, token: existing.token } });
    if (existing) await query("DELETE FROM seo_shares WHERE id = $1", [existing.id]);
    const token = newToken();
    await query("INSERT INTO seo_shares(kind, mode, token, created_by, label) VALUES ('link', $1, $2, $3, $4)", [body.mode, token, String(actor).slice(0, 80), body.mode === "view" ? "Ссылка на просмотр" : "Ссылка на управление"]);
    return reply(201, { link: { mode: body.mode, token } });
  }
  if (kind === "link" && id && req.method === "DELETE") {
    if (!MODES.has(id)) return reply(400, { error: "invalid_mode" });
    await query("DELETE FROM seo_shares WHERE kind = 'link' AND mode = $1", [id]);
    return reply(200, { ok: true });
  }

  if (kind === "login" && !id && req.method === "POST") {
    const body = await readBody(req);
    const login = String(body.login || "").trim().toLowerCase();
    if (!LOGIN_PATTERN.test(login)) return reply(400, { error: "invalid_login", message: "Логин: 3–40 знаков, латиница, цифры, точка, дефис и подчёркивание" });
    if (!MODES.has(body.mode)) return reply(400, { error: "invalid_mode" });
    const generated = !String(body.password || "");
    const password = generated ? generatePassword() : String(body.password);
    if (password.length < 8) return reply(400, { error: "weak_password", message: "Пароль короче 8 знаков" });
    const days = Math.max(0, Math.min(365, Number(body.days) || 0));
    try {
      const row = (await query(
        `INSERT INTO seo_shares(kind, mode, login, password_hash, label, created_by, expires_at)
         VALUES ('login', $1, $2, $3, $4, $5, CASE WHEN $6::int > 0 THEN now() + ($6::int || ' days')::interval END)
         RETURNING id::text, mode, label, created_at::text, last_used_at::text, expires_at::text, use_count`,
        [body.mode, login, await hashPassword(password), String(body.label || "").slice(0, 80), String(actor).slice(0, 80), days],
      )).rows[0];
      return reply(201, { login: { ...rowOut(row), login }, ...(generated ? { password } : {}) });
    } catch (error) {
      if (/duplicate key|unique/i.test(String(error?.message))) return reply(409, { error: "login_taken", message: "Такой логин уже есть" });
      throw error;
    }
  }
  if (kind === "login" && id && /^\d+$/.test(id) && req.method === "PATCH") {
    const body = await readBody(req);
    const sets = [];
    const values = [id];
    if (body.mode !== undefined) { if (!MODES.has(body.mode)) return reply(400, { error: "invalid_mode" }); values.push(body.mode); sets.push(`mode = $${values.length}`); }
    if (body.label !== undefined) { values.push(String(body.label).slice(0, 80)); sets.push(`label = $${values.length}`); }
    let newPassword = null;
    if (body.password !== undefined || body.regeneratePassword) {
      newPassword = body.regeneratePassword ? generatePassword() : String(body.password);
      if (newPassword.length < 8) return reply(400, { error: "weak_password", message: "Пароль короче 8 знаков" });
      values.push(await hashPassword(newPassword));
      sets.push(`password_hash = $${values.length}`);
    }
    if (!sets.length) return reply(400, { error: "nothing_to_change" });
    const row = (await query(`UPDATE seo_shares SET ${sets.join(", ")} WHERE id = $1 AND kind = 'login' RETURNING id::text`, values)).rows[0];
    if (!row) return reply(404, { error: "not_found" });
    // Смена пароля или режима закрывает уже открытые сессии: старый доступ не должен пережить решение владельца.
    if (newPassword !== null || body.mode !== undefined) await query("DELETE FROM seo_share_sessions WHERE share_id = $1", [id]);
    return reply(200, { ok: true, ...(body.regeneratePassword ? { password: newPassword } : {}) });
  }
  if (kind === "login" && id && /^\d+$/.test(id) && req.method === "DELETE") {
    await query("DELETE FROM seo_shares WHERE id = $1 AND kind = 'login'", [id]);
    return reply(200, { ok: true });
  }
  return reply(405, { error: "method_not_allowed" });
}

// ─── Публичная часть: вход и проксирование разрешённых вызовов ───────────────

function clientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.socket?.remoteAddress || "").slice(0, 64);
}

function cookieOf(req, name) {
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const secure = String(req.headers?.["x-forwarded-proto"] || "").includes("https") || Boolean(req.socket?.encrypted);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${value ? encodeURIComponent(value) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`);
}

async function shareByToken(query, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = (await query("SELECT id::text, mode, label, kind FROM seo_shares WHERE kind = 'link' AND token = $1 AND (expires_at IS NULL OR expires_at > now())", [token])).rows[0];
  return row || null;
}

async function shareBySession(query, req) {
  const cookie = cookieOf(req, SESSION_COOKIE);
  if (!cookie) return null;
  const row = (await query(
    `SELECT s.id::text, s.mode, s.label, s.kind, x.token_hash
       FROM seo_share_sessions x JOIN seo_shares s ON s.id = x.share_id
      WHERE x.token_hash = $1 AND x.expires_at > now() AND (s.expires_at IS NULL OR s.expires_at > now())`,
    [sha(cookie)],
  )).rows[0];
  if (row) await query("UPDATE seo_share_sessions SET last_seen_at = now() WHERE token_hash = $1", [row.token_hash]).catch(() => {});
  return row || null;
}

/**
 * Публичные маршруты /api/share/seo/…: вход, выход, «кто я» и проксирование вызовов SEO Wizard.
 * seoApi — обработчик SEO Wizard (передаётся снаружи, чтобы не было круговой зависимости).
 */
export async function handleSharedSeoApi({ req, res, url, query, readBody, sendJson, seoApi }) {
  if (!url.pathname.startsWith("/api/share/seo/")) return false;
  await ensureSeoShareSchema(query);
  const reply = (status, body) => { sendJson(res, status, body); return true; };
  const rest = url.pathname.slice("/api/share/seo/".length).replace(/\/+$/, "");

  if (rest === "login" && req.method === "POST") {
    const body = await readBody(req);
    const login = String(body.login || "").trim().toLowerCase();
    const key = `${clientIp(req)}|${login}`;
    const wait = waitSeconds(key);
    if (wait > 0) return reply(429, { error: "too_many_attempts", retry_after_seconds: wait });
    const share = login && LOGIN_PATTERN.test(login)
      ? (await query("SELECT id::text, mode, label, password_hash FROM seo_shares WHERE kind = 'login' AND login = $1 AND (expires_at IS NULL OR expires_at > now())", [login])).rows[0]
      : null;
    // Пароль проверяется и для несуществующего логина (против хеша-пустышки): время ответа не выдаёт, есть ли такой логин.
    const ok = await verifyPassword(String(body.password || ""), share?.password_hash || "00:00");
    recordAttempt(key, Boolean(share) && ok);
    if (!share || !ok) return reply(401, { error: "bad_credentials" });
    const session = newToken(32);
    await query("INSERT INTO seo_share_sessions(token_hash, share_id, expires_at, ip) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)", [sha(session), share.id, String(SESSION_DAYS), clientIp(req)]);
    await query("UPDATE seo_shares SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1", [share.id]);
    setSessionCookie(req, res, session, SESSION_DAYS * 86400);
    return reply(200, { ok: true, mode: share.mode, label: share.label });
  }
  if (rest === "logout" && req.method === "POST") {
    const cookie = cookieOf(req, SESSION_COOKIE);
    if (cookie) await query("DELETE FROM seo_share_sessions WHERE token_hash = $1", [sha(cookie)]);
    setSessionCookie(req, res, "", 0);
    return reply(200, { ok: true });
  }

  const match = rest.match(/^([A-Za-z0-9_-]+)(?:\/(.*))?$/);
  if (!match) return reply(404, { error: "not_found" });
  const [, auth, inner = ""] = match;
  const share = auth === "session" ? await shareBySession(query, req) : await shareByToken(query, auth);
  if (!share) return reply(auth === "session" ? 401 : 404, { error: auth === "session" ? "not_signed_in" : "link_revoked" });

  if (inner === "me") {
    if (auth !== "session") await query("UPDATE seo_shares SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1", [share.id]).catch(() => {});
    return reply(200, { mode: share.mode, label: share.label, kind: share.kind });
  }
  const verdict = isAllowed(share.mode, req.method, inner);
  if (!verdict.ok) return reply(403, { error: verdict.reason, mode: share.mode });
  const inward = new URL(url.toString());
  inward.pathname = `/api/mbox/seo/${inner}`;
  return seoApi({ req, res, url: inward, query, readBody, sendJson, allowed: true });
}
