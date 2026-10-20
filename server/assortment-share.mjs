// Доступ к «Ассортименту» без входа в MBOX: по ссылке или по логину с паролем (как у SEO Wizard, server/seo-share.mjs).
// У каждой ссылки и логина два выбора: режим (просмотр или управление) и чат с агентом (есть или нет).
// «Только инструмент» — человек видит отчёт и пользуется им; «инструмент + чат» — рядом ещё чат с агентом, который
// умеет только инструменты ассортимента (assortment-chat.mjs). Всё остальное в MBOX недоступно: сервер пропускает белый список вызовов.
import { createHash, randomBytes } from "node:crypto";
import {
  generatePassword, hashPassword, newToken, publicBaseUrl, recordAttempt, verifyPassword, waitSeconds,
} from "./seo-share.mjs";

export const SESSION_COOKIE = "mbox_assortment_session";
const SESSION_DAYS = 30;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const MODES = new Set(["view", "manage"]);
// Кто отвечает в чате: Джарвис (изолированный, только инструменты ассортимента), облачные Claude и GPT (Codex) на сервере.
export const CHAT_AGENTS = { jarvis: "Джарвис", claude: "Claude", codex: "GPT" };
const agentOf = (value) => (Object.hasOwn(CHAT_AGENTS, value) ? value : "jarvis");
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

export async function ensureAssortmentShareSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS assortment_shares (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('link', 'login')),
    mode TEXT NOT NULL CHECK (mode IN ('view', 'manage')),
    chat BOOLEAN NOT NULL DEFAULT false,
    chat_agent TEXT NOT NULL DEFAULT 'jarvis',
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
  await query("ALTER TABLE assortment_shares ADD COLUMN IF NOT EXISTS chat_agent TEXT NOT NULL DEFAULT 'jarvis'");
  await query("DROP INDEX IF EXISTS idx_assortment_shares_link");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_assortment_shares_link_agent ON assortment_shares(mode, chat, chat_agent) WHERE kind = 'link'");
  await query(`CREATE TABLE IF NOT EXISTS assortment_share_sessions (
    token_hash TEXT PRIMARY KEY,
    share_id BIGINT NOT NULL REFERENCES assortment_shares(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip TEXT NOT NULL DEFAULT ''
  )`);
  await query(`CREATE TABLE IF NOT EXISTS assortment_chat_messages (
    id BIGSERIAL PRIMARY KEY,
    share_id BIGINT NOT NULL REFERENCES assortment_shares(id) ON DELETE CASCADE,
    thread TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    tools JSONB NOT NULL DEFAULT '[]',
    ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query("ALTER TABLE assortment_chat_messages ADD COLUMN IF NOT EXISTS ref TEXT");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_assortment_chat_ref ON assortment_chat_messages(share_id, ref) WHERE role = 'assistant' AND ref IS NOT NULL");
  await query("CREATE INDEX IF NOT EXISTS idx_assortment_chat_thread ON assortment_chat_messages(share_id, thread, id)");
}

// ─── Что разрешено по ссылке и паролю ────────────────────────────────────────

const READ_GET = [/^status$/, /^report$/];
const MANAGE_POST = [/^feedback$/];

/**
 * Разрешён ли вызов. rest — путь после /api/share/assortment/<доступ>/. share: { mode, chat }.
 * "not_allowed_in_share" — вызова нет в списке, "read_only_share" — запись при режиме просмотра, "chat_disabled" — у ссылки нет чата.
 */
export function isAllowed(share, method, rest) {
  const verb = String(method).toUpperCase();
  const path = String(rest || "").replace(/^\/+|\/+$/g, "");
  if (path.includes("..") || path.includes("//")) return { ok: false, reason: "not_allowed_in_share" };
  if (verb === "GET" && READ_GET.some((p) => p.test(path))) return { ok: true };
  if (verb === "POST" && path === "tool") return { ok: true }; // какие именно инструменты — решает уровень доступа внутри
  if (/^chat(\/.*)?$/.test(path) && ["GET", "POST", "DELETE"].includes(verb)) return share.chat ? { ok: true } : { ok: false, reason: "chat_disabled" };
  if (verb === "POST" && MANAGE_POST.some((p) => p.test(path))) return share.mode === "manage" ? { ok: true } : { ok: false, reason: "read_only_share" };
  return { ok: false, reason: "not_allowed_in_share" };
}
export const accessOf = (share) => (share.mode === "manage" ? "manage" : "read");

// ─── Управление владельцем ───────────────────────────────────────────────────

const rowOut = (row) => ({ id: row.id, mode: row.mode, chat: row.chat, chat_agent: row.chat_agent, label: row.label, created_at: row.created_at, last_used_at: row.last_used_at, expires_at: row.expires_at, use_count: row.use_count });
const labelOf = (mode, chat, agent = "jarvis") => `${mode === "view" ? "Просмотр" : "Управление"}${chat ? ` + чат (${CHAT_AGENTS[agent]})` : ", без чата"}`;

/** Маршруты владельца: /api/mbox/assortment/shares… */
export async function handleAssortmentShareAdmin({ req, res, url, query, readBody, sendJson, actor = "" }) {
  const match = url.pathname.match(/^\/api\/mbox\/assortment\/shares(?:\/(link|login)(?:\/([A-Za-z0-9_-]+))?)?$/);
  if (!match) return false;
  await ensureAssortmentShareSchema(query);
  const [, kind, id] = match;
  const reply = (status, body) => { sendJson(res, status, body); return true; };

  if (!kind && req.method === "GET") {
    const rows = (await query(
      `SELECT s.id::text, s.kind, s.mode, s.chat, s.chat_agent, s.token, s.login, s.label, s.created_at::text, s.last_used_at::text, s.expires_at::text, s.use_count,
              (SELECT count(*)::int FROM assortment_share_sessions x WHERE x.share_id = s.id AND x.expires_at > now()) AS sessions,
              (SELECT count(*)::int FROM assortment_chat_messages m WHERE m.share_id = s.id AND m.role = 'user') AS chat_messages
         FROM assortment_shares s ORDER BY s.created_at`,
    )).rows;
    return reply(200, {
      base_url: publicBaseUrl(req),
      links: rows.filter((r) => r.kind === "link").map((r) => ({ ...rowOut(r), token: r.token, chat_messages: r.chat_messages })),
      logins: rows.filter((r) => r.kind === "login").map((r) => ({ ...rowOut(r), login: r.login, sessions: r.sessions, chat_messages: r.chat_messages })),
    });
  }

  if (kind === "link" && !id && req.method === "POST") {
    const body = await readBody(req);
    if (!MODES.has(body.mode)) return reply(400, { error: "invalid_mode" });
    const chat = body.chat === true;
    const agent = chat ? agentOf(body.agent) : "jarvis";
    const existing = (await query("SELECT id::text, token FROM assortment_shares WHERE kind = 'link' AND mode = $1 AND chat = $2 AND chat_agent = $3", [body.mode, chat, agent])).rows[0];
    if (existing && !body.regenerate) return reply(200, { link: { mode: body.mode, chat, chat_agent: agent, token: existing.token } });
    if (existing) await query("DELETE FROM assortment_shares WHERE id = $1", [existing.id]);
    const token = newToken();
    await query("INSERT INTO assortment_shares(kind, mode, chat, chat_agent, token, created_by, label) VALUES ('link', $1, $2, $3, $4, $5, $6)", [body.mode, chat, agent, token, String(actor).slice(0, 80), labelOf(body.mode, chat, agent)]);
    return reply(201, { link: { mode: body.mode, chat, chat_agent: agent, token } });
  }
  if (kind === "link" && id && /^\d+$/.test(id) && req.method === "DELETE") {
    await query("DELETE FROM assortment_shares WHERE id = $1 AND kind = 'link'", [id]);
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
        `INSERT INTO assortment_shares(kind, mode, chat, chat_agent, login, password_hash, label, created_by, expires_at)
         VALUES ('login', $1, $2, $8, $3, $4, $5, $6, CASE WHEN $7::int > 0 THEN now() + ($7::int || ' days')::interval END)
         RETURNING id::text, mode, chat, chat_agent, label, created_at::text, last_used_at::text, expires_at::text, use_count`,
        [body.mode, body.chat === true, login, await hashPassword(password), String(body.label || "").slice(0, 80), String(actor).slice(0, 80), days, body.chat === true ? agentOf(body.agent) : "jarvis"],
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
    if (body.chat !== undefined) { values.push(body.chat === true); sets.push(`chat = $${values.length}`); }
    if (body.agent !== undefined) { values.push(agentOf(body.agent)); sets.push(`chat_agent = $${values.length}`); }
    if (body.label !== undefined) { values.push(String(body.label).slice(0, 80)); sets.push(`label = $${values.length}`); }
    let newPassword = null;
    if (body.password !== undefined || body.regeneratePassword) {
      newPassword = body.regeneratePassword ? generatePassword() : String(body.password);
      if (newPassword.length < 8) return reply(400, { error: "weak_password", message: "Пароль короче 8 знаков" });
      values.push(await hashPassword(newPassword));
      sets.push(`password_hash = $${values.length}`);
    }
    if (!sets.length) return reply(400, { error: "nothing_to_change" });
    const row = (await query(`UPDATE assortment_shares SET ${sets.join(", ")} WHERE id = $1 AND kind = 'login' RETURNING id::text`, values)).rows[0];
    if (!row) return reply(404, { error: "not_found" });
    // Смена пароля, режима или чата закрывает открытые сессии: старый доступ не должен пережить решение владельца.
    if (newPassword !== null || body.mode !== undefined || body.chat !== undefined || body.agent !== undefined) await query("DELETE FROM assortment_share_sessions WHERE share_id = $1", [id]);
    return reply(200, { ok: true, ...(body.regeneratePassword ? { password: newPassword } : {}) });
  }
  if (kind === "login" && id && /^\d+$/.test(id) && req.method === "DELETE") {
    await query("DELETE FROM assortment_shares WHERE id = $1 AND kind = 'login'", [id]);
    return reply(200, { ok: true });
  }
  return reply(405, { error: "method_not_allowed" });
}

// ─── Публичная часть ─────────────────────────────────────────────────────────

const clientIp = (req) => (String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "").slice(0, 64);
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
  return (await query("SELECT id::text, mode, chat, chat_agent, label, kind FROM assortment_shares WHERE kind = 'link' AND token = $1 AND (expires_at IS NULL OR expires_at > now())", [token])).rows[0] || null;
}
async function shareBySession(query, req) {
  const cookie = cookieOf(req, SESSION_COOKIE);
  if (!cookie) return null;
  const row = (await query(
    `SELECT s.id::text, s.mode, s.chat, s.chat_agent, s.label, s.kind, x.token_hash
       FROM assortment_share_sessions x JOIN assortment_shares s ON s.id = x.share_id
      WHERE x.token_hash = $1 AND x.expires_at > now() AND (s.expires_at IS NULL OR s.expires_at > now())`,
    [sha(cookie)],
  )).rows[0];
  if (row) await query("UPDATE assortment_share_sessions SET last_seen_at = now() WHERE token_hash = $1", [row.token_hash]).catch(() => {});
  return row || null;
}

/**
 * Публичные маршруты /api/share/assortment/…: вход, выход, «кто я» и проксирование разрешённых вызовов.
 * api — обработчик ассортимента, chat — обработчик чата (передаются снаружи, чтобы не было круговых зависимостей).
 */
export async function handleSharedAssortmentApi({ req, res, url, query, readBody, sendJson, api, chat }) {
  const prefix = "/api/share/assortment/";
  if (!url.pathname.startsWith(prefix)) return false;
  await ensureAssortmentShareSchema(query);
  const reply = (status, body) => { sendJson(res, status, body); return true; };
  const rest = url.pathname.slice(prefix.length).replace(/\/+$/, "");

  if (rest === "login" && req.method === "POST") {
    const body = await readBody(req);
    const login = String(body.login || "").trim().toLowerCase();
    const key = `assortment|${clientIp(req)}|${login}`;
    const wait = waitSeconds(key);
    if (wait > 0) return reply(429, { error: "too_many_attempts", retry_after_seconds: wait });
    const share = login && LOGIN_PATTERN.test(login)
      ? (await query("SELECT id::text, mode, chat, chat_agent, label, password_hash FROM assortment_shares WHERE kind = 'login' AND login = $1 AND (expires_at IS NULL OR expires_at > now())", [login])).rows[0]
      : null;
    // Пароль проверяется и для несуществующего логина: время ответа не выдаёт, есть ли такой логин.
    const ok = await verifyPassword(String(body.password || ""), share?.password_hash || "00:00");
    recordAttempt(key, Boolean(share) && ok);
    if (!share || !ok) return reply(401, { error: "bad_credentials" });
    const session = newToken(32);
    await query("INSERT INTO assortment_share_sessions(token_hash, share_id, expires_at, ip) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)", [sha(session), share.id, String(SESSION_DAYS), clientIp(req)]);
    await query("UPDATE assortment_shares SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1", [share.id]);
    setSessionCookie(req, res, session, SESSION_DAYS * 86400);
    return reply(200, { ok: true, mode: share.mode, chat: share.chat, chat_agent: share.chat_agent, label: share.label });
  }
  if (rest === "logout" && req.method === "POST") {
    const cookie = cookieOf(req, SESSION_COOKIE);
    if (cookie) await query("DELETE FROM assortment_share_sessions WHERE token_hash = $1", [sha(cookie)]);
    setSessionCookie(req, res, "", 0);
    return reply(200, { ok: true });
  }

  const match = rest.match(/^([A-Za-z0-9_-]+)(?:\/(.*))?$/);
  if (!match) return reply(404, { error: "not_found" });
  const [, auth, inner = ""] = match;
  const share = auth === "session" ? await shareBySession(query, req) : await shareByToken(query, auth);
  if (!share) return reply(auth === "session" ? 401 : 404, { error: auth === "session" ? "not_signed_in" : "link_revoked" });

  if (inner === "me") {
    if (auth !== "session") await query("UPDATE assortment_shares SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1", [share.id]).catch(() => {});
    return reply(200, { mode: share.mode, chat: share.chat, chat_agent: share.chat_agent, label: share.label, kind: share.kind });
  }
  const verdict = isAllowed(share, req.method, inner);
  if (!verdict.ok) return reply(403, { error: verdict.reason, mode: share.mode, chat: share.chat });

  const clean = inner.replace(/^\/+|\/+$/g, "");
  const access = accessOf(share);
  const base = `/api/share/assortment/${auth}`;
  if (clean === "chat" || clean.startsWith("chat/")) {
    return chat({ req, res, url, query, readBody, sendJson, share, access, route: clean.slice(4).replace(/^\//, "") });
  }
  const inward = new URL(url.toString());
  inward.pathname = `/api/mbox/assortment/${clean}`;
  return api({ req, res, url: inward, query, readBody, sendJson, allowed: true, access, actor: `по ссылке: ${share.label || share.kind}`,
    runtime: { readOnly: access === "read", feedbackUrl: `${base}/feedback`, badge: share.mode === "view" ? "Режим просмотра" : "Режим управления" } });
}

export const newThreadId = () => randomBytes(12).toString("base64url");
