// Пароли: одно хранилище на сервере для всего — входы на сайты (их подставляет и сохраняет встроенный браузер MBOX Desktop),
// доступы к серверам (хост, порт, логин, пароль или ключ) и всё прочее. У каждого человека свои записи (owner_user_id): владелец
// чужих не видит. Пароль и заметки шифруются pgp_sym_encrypt ключом MBOX_SECRET_KEY и в списках не отдаются.
// Агенту пароль достаётся только после явного одобрения записи (agent_share_state = approved, срок approved_until).
//
// Таблица — прежняя protected_secrets («Секреты»), расширенная: kind (site | server | other), host, port, origin (происхождение
// сайта для подстановки), зашифрованные заметки, отметки использования. Старые записи без хозяина принадлежат владельцу MBOX.
//
//   GET    /api/mbox/secrets?q=                 свои записи без паролей
//   POST   /api/mbox/secrets                    новая запись
//   PATCH  /api/mbox/secrets/:id                правка, выдача агенту (agent_share_state, approved_until)
//   DELETE /api/mbox/secrets/:id
//   POST   /api/mbox/secrets/:id/reveal         пароль и заметки — показать или скопировать
//
// Для браузера (MBOX Desktop держит копию для работы без сети):
//   GET    /api/mbox/passwords/vault            входы на сайты с паролями и сайты «никогда не сохранять»
//   POST   /api/mbox/passwords/save             { url, username, password } — сохранить или обновить вход
//   POST   /api/mbox/passwords/used             { id } — отметка использования
//   POST   /api/mbox/passwords/never            { url } / DELETE ?origin= — «никогда для этого сайта» и отмена
//   POST   /api/mbox/passwords/import           { entries, never } — перенос локальных паролей и импорт из Chrome

const KINDS = new Set(["site", "server", "other"]);
const secretKey = () => process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
const str = (value, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function originOf(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch { return ""; }
}

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

/** Сайт без поддоменов: «accounts.google.com» → «google.com» — как в Chrome, вход поддомена подходит всему сайту. */
export function siteOf(origin) {
  let host = "";
  try { host = new URL(origin).hostname; } catch { return ""; }
  if (/^[\d.]+$/.test(host) || host === "localhost" || !host.includes(".")) return host;
  const parts = host.split(".");
  const second = parts[parts.length - 2];
  const short = /^(co|com|net|org|gov|edu|ac|msk|spb)$/.test(second) && parts.length > 2;
  return parts.slice(short ? -3 : -2).join(".");
}

let schemaReady = null;
export function ensurePasswordsSchema(query) {
  schemaReady ||= (async () => {
    await query(`ALTER TABLE protected_secrets
      ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'site',
      ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS port INTEGER,
      ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS notes_ciphertext TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS uses INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''`);
    await query("CREATE INDEX IF NOT EXISTS idx_protected_secrets_owner ON protected_secrets(owner_user_id, kind, origin)");
    await query(`CREATE TABLE IF NOT EXISTS password_never (
      owner_user_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_user_id, origin)
    )`);
    // «Секреты» до разделения по людям были только у владельца MBOX.
    await query(`UPDATE protected_secrets SET owner_user_id = (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
                  WHERE owner_user_id IS NULL`);
    await query("UPDATE protected_secrets SET kind = 'other' WHERE kind = 'site' AND origin = '' AND url !~* '^https?://' AND source = ''");
    const legacy = (await query("SELECT id::text, url FROM protected_secrets WHERE kind = 'site' AND origin = '' AND url ~* '^https?://'")).rows;
    for (const row of legacy) await query("UPDATE protected_secrets SET origin = $2 WHERE id = $1", [row.id, originOf(row.url)]);
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

const LIST_COLUMNS = `id::text, kind, project_id::text, title, login, url, host, port, origin, access_level, agent_share_state, approved_until::text,
  (notes_ciphertext <> '') AS has_notes, used_at::text, uses, source, created_at::text, updated_at::text, pg_column_size(protected_secrets)::int AS memory_bytes`;

/** Поля записи из тела запроса; null — поле не передано и не меняется. */
function fieldsOf(body) {
  const kind = KINDS.has(body.kind) ? body.kind : null;
  const url = typeof body.url === "string" ? str(body.url, 2000) : null;
  const port = body.port === null || body.port === "" ? 0 : Number.isInteger(Number(body.port)) && Number(body.port) > 0 && Number(body.port) < 65536 ? Number(body.port) : null;
  return {
    kind,
    title: typeof body.title === "string" ? str(body.title, 200) : null,
    login: typeof body.login === "string" ? str(body.login, 300) : null,
    password: typeof body.password === "string" ? body.password.slice(0, 10_000) : null,
    url,
    origin: url === null ? null : originOf(url),
    host: typeof body.host === "string" ? str(body.host, 300) : null,
    port,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 50_000) : null,
    project_id: body.project_id === undefined ? undefined : body.project_id ? String(body.project_id) : null,
  };
}

async function ownEntry(query, owner, id) {
  return (await query(`SELECT ${LIST_COLUMNS} FROM protected_secrets WHERE id = $1 AND owner_user_id = $2`, [id, owner])).rows[0] || null;
}

async function siteEntries(query, owner) {
  return (await query(
    `SELECT id::text, origin, url, login AS username, pgp_sym_decrypt(secret_ciphertext::bytea, $2) AS password,
            extract(epoch FROM created_at) * 1000 AS created, extract(epoch FROM updated_at) * 1000 AS updated,
            COALESCE(extract(epoch FROM used_at) * 1000, 0) AS used, uses
       FROM protected_secrets WHERE owner_user_id = $1 AND kind = 'site' AND origin <> '' AND secret_ciphertext <> ''`,
    [owner, secretKey()],
  )).rows.map((row) => ({ id: row.id, origin: row.origin, url: row.url, username: row.username, password: row.password, createdAt: Math.round(Number(row.created)), updatedAt: Math.round(Number(row.updated)), usedAt: Math.round(Number(row.used)), uses: Number(row.uses) }));
}

/** Сохранить вход на сайт: тот же сайт и логин — обновить пароль, иначе новая запись. «Никогда» для сайта снимается. */
export async function saveSiteLogin(query, owner, { url, username, password, source = "browser", updatedAt = 0 }) {
  const origin = originOf(url);
  if (!origin || !password) return { ok: false, error: "Нечего сохранять" };
  const login = str(username, 300);
  const existing = (await query(
    `SELECT id::text, pgp_sym_decrypt(secret_ciphertext::bytea, $4) AS password, extract(epoch FROM updated_at) * 1000 AS updated
       FROM protected_secrets WHERE owner_user_id = $1 AND kind = 'site' AND origin = $2 AND login = $3 ORDER BY updated_at DESC LIMIT 1`,
    [owner, origin, login, secretKey()],
  )).rows[0];
  await query("DELETE FROM password_never WHERE owner_user_id = $1 AND origin = $2", [owner, origin]);
  if (existing) {
    if (existing.password === password) return { ok: true, id: existing.id, action: "none" };
    // Импорт старой копии не должен затирать более свежий пароль на сервере.
    if (updatedAt && updatedAt < Number(existing.updated)) return { ok: true, id: existing.id, action: "kept" };
    await query("UPDATE protected_secrets SET secret_ciphertext = pgp_sym_encrypt($2, $3), updated_at = now() WHERE id = $1", [existing.id, password, secretKey()]);
    return { ok: true, id: existing.id, action: "updated" };
  }
  const row = (await query(
    `INSERT INTO protected_secrets(owner_user_id, kind, title, login, secret_ciphertext, url, origin, access_level, agent_share_state, source, used_at, uses)
     VALUES ($1, 'site', $2, $3, pgp_sym_encrypt($4, $5), $6, $7, 'private', 'locked', $8, now(), 1) RETURNING id::text`,
    [owner, hostOf(origin), login, password, secretKey(), String(url).split(/[?#]/)[0].slice(0, 2000), origin, source],
  )).rows[0];
  return { ok: true, id: row.id, action: "saved" };
}

export async function handlePasswordsApi({ req, res, url, query, readBody, sendJson, userId, broadcast }) {
  const path = url.pathname;
  if (!path.startsWith("/api/mbox/secrets") && !path.startsWith("/api/mbox/passwords/")) return false;
  await ensurePasswordsSchema(query);
  const owner = String(userId);
  const changed = (action, title = "") => broadcast?.("entity_changed", { entity: "secrets", action, title, silent: true, user_id: owner });

  try {
    if (path === "/api/mbox/secrets" && req.method === "GET") {
      const q = str(url.searchParams.get("q") || "", 200);
      const rows = (await query(
        `SELECT ${LIST_COLUMNS} FROM protected_secrets
          WHERE owner_user_id = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR login ILIKE '%' || $2 || '%' OR url ILIKE '%' || $2 || '%' OR host ILIKE '%' || $2 || '%')
          ORDER BY lower(title), id LIMIT 2000`,
        [owner, q],
      )).rows;
      const never = (await query("SELECT origin FROM password_never WHERE owner_user_id = $1 ORDER BY origin", [owner])).rows.map((row) => row.origin);
      sendJson(res, 200, { secrets: rows, never });
      return true;
    }

    if (path === "/api/mbox/secrets" && req.method === "POST") {
      const fields = fieldsOf(await readBody(req) || {});
      const kind = fields.kind || "other";
      const title = fields.title || (kind === "site" && fields.origin ? hostOf(fields.origin) : kind === "server" && fields.host ? fields.host : "");
      if (!title) { sendJson(res, 400, { error: "Нужно название" }); return true; }
      if (kind === "site" && !fields.origin) { sendJson(res, 400, { error: "Для сайта нужен адрес вида https://…" }); return true; }
      if (!fields.password && !fields.notes) { sendJson(res, 400, { error: "Нужен пароль или заметка" }); return true; }
      const row = (await query(
        `INSERT INTO protected_secrets(owner_user_id, kind, project_id, title, login, secret_ciphertext, url, origin, host, port, notes_ciphertext, access_level, agent_share_state, source)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 = '' THEN '' ELSE pgp_sym_encrypt($6, $7)::text END, $8, $9, $10, $11,
                 CASE WHEN $12 = '' THEN '' ELSE pgp_sym_encrypt($12, $7)::text END, 'private', 'locked', 'manual')
         RETURNING ${LIST_COLUMNS}`,
        [owner, kind, fields.project_id || null, title, fields.login || "", fields.password || "", secretKey(), fields.url || "", fields.origin || "", fields.host || "", fields.port || null, fields.notes || ""],
      )).rows[0];
      changed("create", title);
      sendJson(res, 201, { secret: row });
      return true;
    }

    const match = path.match(/^\/api\/mbox\/secrets\/(\d+)(\/reveal)?$/);
    if (match) {
      const entry = await ownEntry(query, owner, match[1]);
      if (!entry) { sendJson(res, 404, { error: "not_found" }); return true; }
      if (match[2] && req.method === "POST") {
        const row = (await query(
          `SELECT CASE WHEN secret_ciphertext = '' THEN '' ELSE pgp_sym_decrypt(secret_ciphertext::bytea, $2) END AS password,
                  CASE WHEN notes_ciphertext = '' THEN notes ELSE pgp_sym_decrypt(notes_ciphertext::bytea, $2) END AS notes
             FROM protected_secrets WHERE id = $1`,
          [entry.id, secretKey()],
        )).rows[0];
        sendJson(res, 200, { password: row.password, notes: row.notes || "" });
        return true;
      }
      if (!match[2] && req.method === "DELETE") {
        await query("DELETE FROM protected_secrets WHERE id = $1 AND owner_user_id = $2", [entry.id, owner]);
        changed("delete", entry.title);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (!match[2] && req.method === "PATCH") {
        const body = await readBody(req) || {};
        const fields = fieldsOf(body);
        const share = ["locked", "approved"].includes(body.agent_share_state) ? body.agent_share_state : null;
        const hasUntil = Object.prototype.hasOwnProperty.call(body, "approved_until");
        const row = (await query(
          `UPDATE protected_secrets SET
              kind = COALESCE($3, kind), title = COALESCE(NULLIF($4, ''), title), login = COALESCE($5, login),
              secret_ciphertext = CASE WHEN COALESCE($6, '') = '' THEN secret_ciphertext ELSE pgp_sym_encrypt($6, $7)::text END,
              url = COALESCE($8, url), origin = COALESCE($9, origin), host = COALESCE($10, host),
              port = CASE WHEN $11::int IS NULL THEN port WHEN $11::int = 0 THEN NULL ELSE $11::int END,
              notes_ciphertext = CASE WHEN $12::text IS NULL THEN notes_ciphertext WHEN $12 = '' THEN '' ELSE pgp_sym_encrypt($12, $7)::text END,
              notes = CASE WHEN $12::text IS NULL THEN notes ELSE '' END,
              project_id = CASE WHEN $13 THEN $14::bigint ELSE project_id END,
              agent_share_state = COALESCE($15, agent_share_state),
              approved_until = CASE WHEN $16 THEN $17::timestamptz ELSE approved_until END,
              updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 RETURNING ${LIST_COLUMNS}`,
          [entry.id, owner, fields.kind, fields.title || "", fields.login, fields.password, secretKey(), fields.url, fields.origin, fields.host, fields.port,
            fields.notes, fields.project_id !== undefined, fields.project_id ?? null, share, hasUntil, hasUntil ? body.approved_until || null : null],
        )).rows[0];
        changed("update", row.title);
        sendJson(res, 200, { secret: row });
        return true;
      }
    }

    // ── Браузер ─────────────────────────────────────────────────────────────
    if (path === "/api/mbox/passwords/vault" && req.method === "GET") {
      const never = (await query("SELECT origin FROM password_never WHERE owner_user_id = $1", [owner])).rows.map((row) => row.origin);
      sendJson(res, 200, { entries: await siteEntries(query, owner), never });
      return true;
    }
    if (path === "/api/mbox/passwords/save" && req.method === "POST") {
      const body = await readBody(req) || {};
      const result = await saveSiteLogin(query, owner, { url: body.url, username: body.username, password: typeof body.password === "string" ? body.password : "" });
      if (result.ok && result.action !== "none") changed(result.action === "saved" ? "create" : "update", hostOf(originOf(body.url)));
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }
    if (path === "/api/mbox/passwords/used" && req.method === "POST") {
      const body = await readBody(req) || {};
      await query("UPDATE protected_secrets SET used_at = now(), uses = uses + 1 WHERE id = $1 AND owner_user_id = $2", [String(body.id || "0").replace(/\D/g, "") || "0", owner]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === "/api/mbox/passwords/never" && req.method === "POST") {
      const body = await readBody(req) || {};
      const origin = originOf(body.url) || originOf(body.origin);
      if (origin) await query("INSERT INTO password_never(owner_user_id, origin) VALUES ($1, $2) ON CONFLICT DO NOTHING", [owner, origin]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === "/api/mbox/passwords/never" && req.method === "DELETE") {
      await query("DELETE FROM password_never WHERE owner_user_id = $1 AND origin = $2", [owner, String(url.searchParams.get("origin") || "")]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === "/api/mbox/passwords/import" && req.method === "POST") {
      const body = await readBody(req) || {};
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 5000) : [];
      const counts = { saved: 0, updated: 0, kept: 0, none: 0, skipped: 0 };
      for (const entry of entries) {
        const result = await saveSiteLogin(query, owner, {
          url: entry?.url || entry?.origin, username: entry?.username, password: typeof entry?.password === "string" ? entry.password : "",
          source: str(body.source, 40) || "import", updatedAt: Number(entry?.updatedAt) || 0,
        });
        if (!result.ok) counts.skipped += 1; else counts[result.action] += 1;
      }
      for (const item of Array.isArray(body.never) ? body.never.slice(0, 2000) : []) {
        const origin = originOf(item);
        if (origin) await query("INSERT INTO password_never(owner_user_id, origin) VALUES ($1, $2) ON CONFLICT DO NOTHING", [owner, origin]);
      }
      if (counts.saved || counts.updated) changed("update", "импорт паролей");
      sendJson(res, 200, { ok: true, ...counts, total: (await siteEntries(query, owner)).length });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}

/** Одобренные агенту записи человека: по проекту и без проекта. Пароль — только пока не истёк срок одобрения. */
export async function approvedSecrets(query, userId, projectName = "") {
  await ensurePasswordsSchema(query);
  return (await query(
    `SELECT s.id::text, s.kind, s.title, s.login, s.url, s.host, s.port,
            pgp_sym_decrypt(s.secret_ciphertext::bytea, $3) AS password,
            CASE WHEN s.notes_ciphertext = '' THEN s.notes ELSE pgp_sym_decrypt(s.notes_ciphertext::bytea, $3) END AS notes,
            s.approved_until::text, p.name AS project_name
       FROM protected_secrets s LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.owner_user_id = $1 AND s.agent_share_state = 'approved' AND s.secret_ciphertext <> ''
        AND (s.approved_until IS NULL OR s.approved_until > now())
        AND ($2 = '' OR s.project_id IS NULL OR p.name = $2)
      ORDER BY s.updated_at DESC`,
    [String(userId), projectName, secretKey()],
  )).rows;
}
