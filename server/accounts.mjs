import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const ROOT_PACKAGE = path.resolve(SCRIPTS_DIR, "..", "package.json");
// Набор файлов, с которым наблюдатели работают на чужом компьютере: только встроенные модули Node, кроме MCP-сервера.
const AGENT_KIT = ["mbox-agent.mjs", "claude-inbox-watcher.mjs", "codex-chat-watcher.mjs", "sync-skills.mjs", "inbox-wake.mjs", "model-catalog.mjs", "chat-threads.mjs", "mbox-mcp-server.mjs", "cli-auth.mjs"];
const AGENT_FAMILIES = ["claude", "codex"];

function agentKitPackage() {
  let deps = {};
  try {
    const root = JSON.parse(fs.readFileSync(ROOT_PACKAGE, "utf8"));
    for (const name of ["@modelcontextprotocol/sdk", "zod"]) if (root.dependencies?.[name]) deps[name] = root.dependencies[name];
  } catch { deps = {}; }
  return JSON.stringify({ name: "mbox-agent", private: true, type: "module", dependencies: deps }, null, 2);
}

function agentKitFile(name) {
  if (name === "package.json") return agentKitPackage();
  if (!AGENT_KIT.includes(name)) return null;
  try { return fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8"); } catch { return null; }
}

export async function ensureAccountsSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS project_memberships (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('member', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_project_memberships_user ON project_memberships(user_id, project_id)");
  // Свой Джарвис у аккаунта — по желанию владельца: выключен — вопросы участника Джарвис не будят.
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS jarvis_enabled BOOLEAN NOT NULL DEFAULT true");
  // Когда сессией пользовались: при входе вытесняются давно не используемые, а не самые старые —
  // иначе каждый вход агента по паролю (MCP, наблюдатели) выбивал человека из браузера.
  await query("ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ");
  // Какие локальные агенты человек включил у себя: нет подписки на Claude Code или ChatGPT — выключает здесь, и наблюдатели не запускаются.
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_prefs JSONB NOT NULL DEFAULT '{}'");
  // Вход в локальные Claude Code / Codex: состояние присылает служба на компьютере человека, запросы «войти/выйти» ставит интерфейс.
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_cli JSONB NOT NULL DEFAULT '{}'");
  await query(`CREATE TABLE IF NOT EXISTS account_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT 'VS Code',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, created_at DESC)");
  await query(`CREATE TABLE IF NOT EXISTS account_invites (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_ids BIGINT[] NOT NULL DEFAULT '{}',
    uses_remaining INTEGER NOT NULL DEFAULT 20,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_account_invites_token ON account_invites(token_hash)");
  await query("ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT ''");
  // Джарвис по приглашению выдаётся осознанно: по умолчанию друг приходит без него (свои агенты работают как обычно).
  await query("ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS jarvis_enabled BOOLEAN NOT NULL DEFAULT false");
  await query("ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ");
  await query("ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS uses_total INTEGER NOT NULL DEFAULT 0");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username))").catch(() => {});
}

/**
 * Свежая установка (в том числе у друга на своём сервере): владелец из сида имеет пароль по умолчанию. Если заданы
 * MBOX_ADMIN_USERNAME и MBOX_ADMIN_PASSWORD, превращаем его в настоящего владельца. Уже сменённый пароль не трогаем.
 */
export async function ensureInitialOwner(query, env = process.env) {
  const username = String(env.MBOX_ADMIN_USERNAME || "").trim();
  const password = String(env.MBOX_ADMIN_PASSWORD || "");
  if (credentialsError(username, password)) return false;
  const seeded = await query("SELECT id::text FROM users WHERE role = 'owner' AND password_hash = crypt($1, password_hash) ORDER BY id LIMIT 1", [DEFAULT_OWNER_PASSWORD]);
  if (!seeded.rows[0]) return false;
  const email = String(env.MBOX_ADMIN_EMAIL || "").trim() || `${username.toLowerCase().replace(/\s+/g, ".")}@mbox.local`;
  await query("UPDATE users SET username = $2, email = $3, password_hash = crypt($4, gen_salt('bf')) WHERE id = $1", [seeded.rows[0].id, username, email, password]);
  console.log(`MBOX: владелец ${username} создан из MBOX_ADMIN_USERNAME`);
  return true;
}

const USERNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{1,31}$/u;
const DEFAULT_OWNER_PASSWORD = "change-me-before-use";
const inviteHash = (token) => createHash("sha256").update(String(token || "")).digest("hex");

/** Проверка имени и пароля нового аккаунта: возвращает код ошибки или пустую строку. */
function credentialsError(username, password) {
  if (!USERNAME_PATTERN.test(username)) return "invalid_username";
  if (password.length < 8) return "password_too_short";
  if (password.length > 200) return "password_too_long";
  return "";
}

async function usernameTaken(query, username, email) {
  const found = await query("SELECT 1 FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2) LIMIT 1", [username, email]);
  return Boolean(found.rows[0]);
}

async function inviteByToken(query, token) {
  if (!/^mbox_invite_[A-Za-z0-9_-]{32,}$/.test(String(token || ""))) return null;
  const result = await query(
    `SELECT i.id::text, i.project_ids::text[] AS project_ids, i.uses_remaining, i.expires_at::text, i.jarvis_enabled, i.label,
            u.username AS created_by,
            COALESCE(jsonb_agg(jsonb_build_object('id', p.id::text, 'name', p.name) ORDER BY p.name)
              FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS projects
     FROM account_invites i
     JOIN users u ON u.id = i.created_by
     LEFT JOIN projects p ON p.id = ANY(i.project_ids)
     WHERE i.token_hash = $1 AND i.uses_remaining > 0 AND i.expires_at > now() AND i.revoked_at IS NULL
     GROUP BY i.id, u.username`,
    [inviteHash(token)],
  );
  return result.rows[0] || null;
}

/** Публичные ручки приглашения: посмотреть, куда зовут, и создать свой аккаунт. Без входа. */
export async function handlePublicInvite({ req, res, url, query, readBody, sendJson, startSession }) {
  const match = url.pathname.match(/^\/api\/mbox\/invites\/(mbox_invite_[A-Za-z0-9_-]+)$/);
  if (!match) return false;
  const invite = await inviteByToken(query, match[1]);
  if (!invite) { sendJson(res, 404, { error: "invite_not_found" }); return true; }
  if (req.method === "GET") {
    sendJson(res, 200, { invite: { created_by: invite.created_by, expires_at: invite.expires_at, projects: invite.projects, jarvis_enabled: invite.jarvis_enabled, label: invite.label } });
    return true;
  }
  if (req.method !== "POST") return false;
  const body = await readBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const email = String(body.email || "").trim() || `${username.toLowerCase().replace(/\s+/g, ".")}@mbox.local`;
  const invalid = credentialsError(username, password);
  if (invalid) { sendJson(res, 400, { error: invalid }); return true; }
  if (await usernameTaken(query, username, email)) { sendJson(res, 409, { error: "account_already_exists" }); return true; }
  // Место по приглашению занимаем до создания аккаунта и атомарно: параллельные регистрации не превысят лимит.
  const claimed = await query(
    `UPDATE account_invites SET uses_remaining = uses_remaining - 1, uses_total = uses_total + 1, last_used_at = now()
     WHERE id = $1 AND uses_remaining > 0 AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
    [invite.id],
  );
  if (!claimed.rows[0]) { sendJson(res, 404, { error: "invite_not_found" }); return true; }
  const created = await query(
    `INSERT INTO users(email, username, password_hash, role, jarvis_enabled)
     VALUES ($1, $2, crypt($3, gen_salt('bf')), 'member', $4)
     RETURNING id::text, email, username, role`,
    [email, username, password, invite.jarvis_enabled === true],
  ).catch((error) => ({ error }));
  if (created.error) {
    await query("UPDATE account_invites SET uses_remaining = uses_remaining + 1, uses_total = uses_total - 1 WHERE id = $1", [invite.id]);
    sendJson(res, 409, { error: "account_already_exists" });
    return true;
  }
  const userId = created.rows[0].id;
  await replaceMemberships(query, userId, invite.project_ids);
  await startSession(req, res, userId);
  sendJson(res, 201, { user: created.rows[0] });
  return true;
}

const ownerOnly = (user, sendJson, res) => {
  if (user?.role === "owner") return true;
  sendJson(res, 403, { error: "owner_required" });
  return false;
};

function looksLikePasswordHash(value) {
  return /^(pbkdf2_sha256|bcrypt|scrypt|argon2|sha256|sha512)\$/i.test(String(value || ""));
}

async function accountRows(query) {
  return (await query(
    `SELECT u.id::text, u.email, u.username, u.role, COALESCE((to_jsonb(u)->>'jarvis_enabled')::boolean, true) AS jarvis_enabled, u.created_at::text,
            COALESCE(jsonb_agg(jsonb_build_object('project_id', p.id::text, 'project_name', p.name, 'role', pm.role)
              ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS projects
     FROM users u
     LEFT JOIN project_memberships pm ON pm.user_id = u.id
     LEFT JOIN projects p ON p.id = pm.project_id
     GROUP BY u.id
     ORDER BY CASE WHEN u.role = 'owner' THEN 0 ELSE 1 END, lower(u.username)` ,
  )).rows;
}

async function replaceMemberships(query, userId, projectIds) {
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map(String).filter((id) => /^\d+$/.test(id)))];
  await query("DELETE FROM project_memberships WHERE user_id = $1 AND NOT (project_id = ANY($2::bigint[]))", [userId, ids]);
  for (const projectId of ids) {
    await query(
      `INSERT INTO project_memberships(project_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projectId, userId],
    );
  }
}

function agentPrefsView(raw) {
  const prefs = raw && typeof raw === "object" ? raw : {};
  return Object.fromEntries(AGENT_FAMILIES.map((family) => [family, { enabled: prefs[family]?.enabled !== false }]));
}

const CLI_ONLINE_MS = 90_000;

function cliView(raw) {
  const stored = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const family of AGENT_FAMILIES) {
    const item = stored[family] && typeof stored[family] === "object" ? stored[family] : {};
    const checked = item.checked_at ? Date.parse(item.checked_at) : 0;
    out[family] = {
      installed: typeof item.installed === "boolean" ? item.installed : null,
      logged_in: typeof item.logged_in === "boolean" ? item.logged_in : null,
      account: typeof item.account === "string" ? item.account : "",
      login: item.login && typeof item.login === "object" ? item.login : null,
      pending: stored.requests?.[family] || null,
      online: Boolean(checked) && Date.now() - checked < CLI_ONLINE_MS,
      checked_at: item.checked_at || null,
    };
  }
  return out;
}

function cleanCliReport(body) {
  const clip = (value, length) => (typeof value === "string" ? value.slice(0, length) : "");
  const report = {};
  for (const family of AGENT_FAMILIES) {
    const item = body?.[family];
    if (!item || typeof item !== "object") continue;
    const login = item.login && typeof item.login === "object" ? item.login : null;
    const url = clip(login?.url, 2000);
    report[family] = {
      installed: typeof item.installed === "boolean" ? item.installed : null,
      logged_in: typeof item.logged_in === "boolean" ? item.logged_in : null,
      account: clip(item.account, 200),
      login: login ? { state: clip(login.state, 20), url: /^https:\/\//.test(url) ? url : "", message: clip(login.message, 300), updated_at: new Date().toISOString() } : null,
      checked_at: new Date().toISOString(),
    };
  }
  return report;
}

export async function handleAccountsApi({ req, res, url, query, readBody, sendJson, user, publicOrigin }) {
  // Какие агенты включены у этого аккаунта (наблюдатели и интерфейс опрашивают это).
  if (url.pathname === "/api/mbox/account/agents" && req.method === "GET") {
    const row = (await query("SELECT agent_prefs FROM users WHERE id = $1", [user.id])).rows[0];
    const cli = (await query("SELECT agent_cli FROM users WHERE id = $1", [user.id])).rows[0]?.agent_cli;
    sendJson(res, 200, { agents: agentPrefsView(row?.agent_prefs), cli: cliView(cli) });
    return true;
  }
  // Служба на компьютере присылает, установлены ли CLI и выполнен ли вход, и забирает запросы «войти/выйти».
  if (url.pathname === "/api/mbox/account/agents/cli" && req.method === "PUT") {
    const report = cleanCliReport(await readBody(req));
    const row = (await query("SELECT agent_cli FROM users WHERE id = $1", [user.id])).rows[0];
    const stored = row?.agent_cli && typeof row.agent_cli === "object" ? row.agent_cli : {};
    const requests = { ...(stored.requests || {}) };
    const next = { ...stored, ...report, requests: {} };
    await query("UPDATE users SET agent_cli = $2::jsonb WHERE id = $1", [user.id, JSON.stringify(next)]);
    sendJson(res, 200, { requests });
    return true;
  }
  const cliAction = url.pathname.match(/^\/api\/mbox\/account\/agents\/(claude|codex)\/(login|logout)$/);
  if (cliAction && req.method === "POST") {
    const [, family, action] = cliAction;
    const row = (await query("SELECT agent_cli FROM users WHERE id = $1", [user.id])).rows[0];
    const stored = row?.agent_cli && typeof row.agent_cli === "object" ? row.agent_cli : {};
    const next = {
      ...stored,
      requests: { ...(stored.requests || {}), [family]: action },
      [family]: { ...(stored[family] || {}), login: action === "login" ? { state: "requested", url: "", message: "", updated_at: new Date().toISOString() } : null },
    };
    await query("UPDATE users SET agent_cli = $2::jsonb WHERE id = $1", [user.id, JSON.stringify(next)]);
    sendJson(res, 202, { cli: cliView(next) });
    return true;
  }
  if (url.pathname === "/api/mbox/account/agents" && (req.method === "PUT" || req.method === "PATCH")) {
    const body = await readBody(req);
    const row = (await query("SELECT agent_prefs FROM users WHERE id = $1", [user.id])).rows[0];
    const next = { ...(row?.agent_prefs && typeof row.agent_prefs === "object" ? row.agent_prefs : {}) };
    for (const family of AGENT_FAMILIES) {
      const value = body?.[family];
      const enabled = typeof value === "boolean" ? value : typeof value?.enabled === "boolean" ? value.enabled : undefined;
      if (enabled !== undefined) next[family] = { ...(next[family] || {}), enabled };
    }
    await query("UPDATE users SET agent_prefs = $2::jsonb WHERE id = $1", [user.id, JSON.stringify(next)]);
    sendJson(res, 200, { agents: agentPrefsView(next) });
    return true;
  }
  // Установка наблюдателей на чужом компьютере: файлы набора отдаются залогиненному (cookie или личный токен).
  const kitMatch = url.pathname.match(/^\/api\/mbox\/agent-kit(?:\/([A-Za-z0-9._-]+))?$/);
  if (kitMatch && req.method === "GET") {
    if (!kitMatch[1]) {
      const files = ["package.json", ...AGENT_KIT].map((name) => {
        const text = agentKitFile(name);
        return text === null ? null : { name, size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
      }).filter(Boolean);
      sendJson(res, 200, { files });
      return true;
    }
    const text = agentKitFile(kitMatch[1]);
    if (text === null) { sendJson(res, 404, { error: "not_found" }); return true; }
    res.writeHead(200, { "content-type": kitMatch[1].endsWith(".json") ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
    return true;
  }
  if (url.pathname === "/api/mbox/account/tokens" && req.method === "GET") {
    const result = await query(
      "SELECT id::text, label, created_at::text, last_used_at::text FROM account_tokens WHERE user_id = $1 ORDER BY created_at DESC",
      [user.id],
    );
    sendJson(res, 200, { tokens: result.rows });
    return true;
  }
  if (url.pathname === "/api/mbox/account/tokens" && req.method === "POST") {
    const body = await readBody(req);
    const token = `mbox_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = await query(
      `INSERT INTO account_tokens(user_id, token_hash, label)
       VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'VS Code'))
       RETURNING id::text, label, created_at::text`,
      [user.id, tokenHash, String(body.label || "VS Code").trim()],
    );
    sendJson(res, 201, { token, credential: result.rows[0] });
    return true;
  }
  const tokenMatch = url.pathname.match(/^\/api\/mbox\/account\/tokens\/(\d+)$/);
  if (tokenMatch && req.method === "DELETE") {
    const result = await query("DELETE FROM account_tokens WHERE id = $1 AND user_id = $2 RETURNING id::text", [tokenMatch[1], user.id]);
    sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { ok: true } : { error: "not_found" });
    return true;
  }
  // Справочник людей MBOX: нужен, чтобы выдать документ поимённо. Только логины, без почты и прав.
  if (url.pathname === "/api/mbox/directory" && req.method === "GET") {
    const rows = (await query("SELECT id::text, username FROM users ORDER BY lower(username)")).rows;
    sendJson(res, 200, { users: rows.map((row) => ({ ...row, self: row.id === String(user.id) })) });
    return true;
  }
  if (url.pathname === "/api/mbox/account/password" && req.method === "POST") {
    const body = await readBody(req);
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    if (next.length < 8) { sendJson(res, 400, { error: "password_too_short" }); return true; }
    if (next.length > 200) { sendJson(res, 400, { error: "password_too_long" }); return true; }
    const ok = await query("SELECT 1 FROM users WHERE id = $1 AND password_hash = crypt($2, password_hash)", [user.id, current]);
    if (!ok.rows[0]) { sendJson(res, 403, { error: "wrong_current_password" }); return true; }
    await query("UPDATE users SET password_hash = crypt($2, gen_salt('bf')) WHERE id = $1", [user.id, next]);
    // Остальные сессии аккаунта закрываем: пароль меняют, в том числе если его кто-то узнал. Текущая остаётся.
    const keep = String(req.headers.cookie || "").match(/(?:^|;\s*)mbox_session=([^;]+)/)?.[1];
    const keepHash = keep ? createHash("sha256").update(decodeURIComponent(keep)).digest("hex") : "";
    await query("DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, keepHash]);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/mbox/account/security" && req.method === "GET") {
    const row = (await query("SELECT password_hash = crypt($2, password_hash) AS default_password FROM users WHERE id = $1", [user.id, DEFAULT_OWNER_PASSWORD])).rows[0];
    sendJson(res, 200, { default_password: Boolean(row?.default_password) });
    return true;
  }
  if (url.pathname === "/api/mbox/admin/invites" && req.method === "GET") {
    if (!ownerOnly(user, sendJson, res)) return true;
    const rows = (await query(
      `SELECT i.id::text, i.label, i.jarvis_enabled, i.uses_remaining, i.uses_total, i.expires_at::text, i.created_at::text, i.last_used_at::text, i.revoked_at::text,
              COALESCE(jsonb_agg(jsonb_build_object('id', p.id::text, 'name', p.name) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS projects,
              (i.revoked_at IS NULL AND i.uses_remaining > 0 AND i.expires_at > now()) AS active
       FROM account_invites i LEFT JOIN projects p ON p.id = ANY(i.project_ids)
       WHERE i.created_at > now() - interval '60 days'
       GROUP BY i.id ORDER BY i.created_at DESC LIMIT 50`,
    )).rows;
    sendJson(res, 200, { invites: rows });
    return true;
  }
  if (url.pathname === "/api/mbox/admin/invites" && req.method === "POST") {
    if (!ownerOnly(user, sendJson, res)) return true;
    const body = await readBody(req);
    const requested = Array.isArray(body.project_ids) ? body.project_ids.map(String).filter((id) => /^\d+$/.test(id)) : [];
    const known = requested.length ? (await query("SELECT id::text FROM projects WHERE id = ANY($1::bigint[])", [requested])).rows.map((row) => row.id) : [];
    // Приглашение без проектов допустимо: человек получает пустой MBOX и своих агентов, чужое не видит.
    const uses = Math.min(Math.max(Number(body.uses) || 1, 1), 50);
    const days = Math.min(Math.max(Number(body.expires_days) || 7, 1), 60);
    const token = `mbox_invite_${randomBytes(32).toString("base64url")}`;
    const created = await query(
      `INSERT INTO account_invites(token_hash, created_by, project_ids, uses_remaining, expires_at, label, jarvis_enabled)
       VALUES ($1, $2, $3::bigint[], $4, now() + make_interval(days => $5), $6, $7)
       RETURNING id::text, expires_at::text`,
      [inviteHash(token), user.id, known, uses, days, String(body.label || "").trim().slice(0, 80), body.jarvis_enabled === true],
    );
    sendJson(res, 201, { invite: { ...created.rows[0], url: `${publicOrigin(req)}/invite/${token}`, project_ids: known, uses_remaining: uses, jarvis_enabled: body.jarvis_enabled === true } });
    return true;
  }
  const inviteMatch = url.pathname.match(/^\/api\/mbox\/admin\/invites\/(\d+)$/);
  if (inviteMatch && req.method === "DELETE") {
    if (!ownerOnly(user, sendJson, res)) return true;
    const revoked = await query("UPDATE account_invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id::text", [inviteMatch[1]]);
    sendJson(res, revoked.rows[0] ? 200 : 404, revoked.rows[0] ? { ok: true } : { error: "not_found" });
    return true;
  }
  if (url.pathname === "/api/mbox/admin/users" && req.method === "GET") {
    if (!ownerOnly(user, sendJson, res)) return true;
    sendJson(res, 200, { users: await accountRows(query) });
    return true;
  }
  if (url.pathname === "/api/mbox/admin/users" && req.method === "POST") {
    if (!ownerOnly(user, sendJson, res)) return true;
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const invalid = credentialsError(username, password);
    if (invalid) { sendJson(res, 400, { error: invalid }); return true; }
    const email = String(body.email || `${username.toLowerCase().replace(/\s+/g, ".")}@mbox.local`).trim();
    if (await usernameTaken(query, username, email)) { sendJson(res, 409, { error: "account_already_exists" }); return true; }
    const created = await query(
      `INSERT INTO users(email, username, password_hash, role, jarvis_enabled)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), 'member', $4)
       RETURNING id::text, email, username, role, created_at::text`,
      [email, username, password, body.jarvis_enabled === true],
    ).catch((error) => ({ error }));
    if (created.error) {
      sendJson(res, 409, { error: "account_already_exists" });
      return true;
    }
    await replaceMemberships(query, created.rows[0].id, body.project_ids);
    sendJson(res, 201, { user: (await accountRows(query)).find((row) => row.id === created.rows[0].id) });
    return true;
  }
  const match = url.pathname.match(/^\/api\/mbox\/admin\/users\/(\d+)$/);
  if (match && req.method === "PATCH") {
    if (!ownerOnly(user, sendJson, res)) return true;
    const body = await readBody(req);
    const existing = (await query("SELECT id::text, role FROM users WHERE id = $1", [match[1]])).rows[0];
    if (!existing) { sendJson(res, 404, { error: "not_found" }); return true; }
    if (existing.role === "owner" && String(user.id) !== String(existing.id)) { sendJson(res, 400, { error: "owner_account_protected" }); return true; }
    const password = String(body.password || "");
    await query(
      `UPDATE users SET
         username = COALESCE(NULLIF($1, ''), username),
         email = COALESCE(NULLIF($2, ''), email),
         password_hash = CASE WHEN length($3) >= 8 THEN crypt($3, gen_salt('bf')) ELSE password_hash END
       WHERE id = $4`,
      [String(body.username || "").trim(), String(body.email || "").trim(), looksLikePasswordHash(password) ? "" : password, match[1]],
    );
    if (existing.role !== "owner" && Object.prototype.hasOwnProperty.call(body, "project_ids")) await replaceMemberships(query, match[1], body.project_ids);
    if (existing.role !== "owner" && typeof body.jarvis_enabled === "boolean") await query("UPDATE users SET jarvis_enabled = $1 WHERE id = $2", [body.jarvis_enabled, match[1]]);
    sendJson(res, 200, { user: (await accountRows(query)).find((row) => row.id === match[1]) });
    return true;
  }
  return false;
}
