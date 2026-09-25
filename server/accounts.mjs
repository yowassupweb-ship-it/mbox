import { createHash, randomBytes } from "node:crypto";

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

export async function handleAccountsApi({ req, res, url, query, readBody, sendJson, user }) {
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
    if (username.length < 2 || password.length < 8) {
      sendJson(res, 400, { error: "username_and_password_required" });
      return true;
    }
    const email = String(body.email || `${username.toLowerCase()}@mbox.local`).trim();
    const created = await query(
      `INSERT INTO users(email, username, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), 'member')
       RETURNING id::text, email, username, role, created_at::text`,
      [email, username, password],
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
