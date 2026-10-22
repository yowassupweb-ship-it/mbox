// Личные пространства: у каждого аккаунта свой MBOX. Никто, включая владельца, не видит чужие проекты:
// видны только проекты, где человек участник (project_memberships). Проект создаёт — и сразу становится его участником.
//
// Переключатель — флаг spaces_v1 в таблице mbox_flags. Пока его нет, владелец видит всё, как раньше: код можно выкатить
// заранее, а режим включить миграцией (`node scripts/migrate-spaces.mjs`), когда старые проекты уже розданы.

const FLAG = "spaces_v1";
const GENERAL_PROJECT = "Общее";
let cached = { at: 0, value: false };

export async function ensureSpacesSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS mbox_flags (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT 'true'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

/** Включён ли режим личных пространств. Ответ держится 15 секунд, чтобы не ходить в базу на каждый запрос. */
export async function spacesEnabled(query) {
  if (Date.now() - cached.at < 15_000) return cached.value;
  const value = await query("SELECT 1 FROM mbox_flags WHERE key = $1", [FLAG]).then((result) => result.rows.length > 0, () => false);
  cached = { at: Date.now(), value };
  return value;
}

export const resetSpacesCache = () => { cached = { at: 0, value: false }; };

/**
 * Что видит человек. all — «без ограничений по проектам» (только у владельца и только пока режим не включён),
 * owner — владелец инстанса: ему принадлежат настройки сервера (секреты, бакет, Gmail, SEO), но не чужие проекты.
 */
export async function projectScopeFor(query, user) {
  const owner = user?.role === "owner";
  if (owner && !(await spacesEnabled(query))) return { all: true, owner, projectIds: [] };
  // Доступ к компании целиком (company_memberships, server/companies.mjs) открывает все её проекты — и те, что появятся
  // потом. Таблицы ещё может не быть (первый запуск до миграции) — тогда считаем только проекты.
  try {
    const [projects, companies] = await Promise.all([
      query(
        `SELECT project_id::text FROM project_memberships WHERE user_id = $1
         UNION
         SELECT p.id::text FROM projects p JOIN company_memberships cm ON cm.company_id = p.company_id WHERE cm.user_id = $1
         ORDER BY 1`,
        [user.id],
      ),
      query("SELECT company_id::text FROM company_memberships WHERE user_id = $1", [user.id]),
    ]);
    return { all: false, owner, projectIds: projects.rows.map((row) => row.project_id), companyIds: companies.rows.map((row) => row.company_id) };
  } catch {
    const result = await query("SELECT project_id::text FROM project_memberships WHERE user_id = $1 ORDER BY project_id", [user.id]);
    return { all: false, owner, projectIds: result.rows.map((row) => row.project_id), companyIds: [] };
  }
}

/**
 * Доступна ли запись (заметка, документ, таблица) в этом проекте. Запись без проекта — личная запись владельца
 * инстанса; участнику она недоступна. Правило одно на все разделы, поэтому живёт здесь, а не копией в каждом модуле.
 */
export function hasProjectAccess(scope, projectId) {
  if (!scope) return true;
  if (projectId == null) return scope.all === true || scope.owner === true;
  return scope.all === true || (Array.isArray(scope.projectIds) && scope.projectIds.includes(String(projectId)));
}

/** Новый проект принадлежит тому, кто его создал: без членства он бы его не увидел. */
export async function addProjectMember(query, projectId, userId) {
  if (!projectId || !userId) return;
  await query(
    "INSERT INTO project_memberships(project_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT (project_id, user_id) DO NOTHING",
    [projectId, userId],
  );
}

/** Куда класть записи владельца, у которых не указан проект (общая память, решения, артефакты). */
export async function generalProjectId(query, userId) {
  const row = (await query(
    `SELECT p.id::text FROM projects p JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.name = $2 ORDER BY p.id LIMIT 1`,
    [userId, GENERAL_PROJECT],
  )).rows[0];
  return row?.id || null;
}

/**
 * Включение режима. Идемпотентно. Шаги:
 *  1. владелец становится участником всех существующих проектов (ничего не пропадает, лишнее он покинет сам);
 *  2. проект «Общее» принимает записи без проекта (память, решения, артефакты): раньше их видел только владелец;
 *  3. ставится флаг.
 * dryRun только считает, ничего не пишет.
 */
export async function migrateToSpaces(query, { dryRun = false } = {}) {
  await ensureSpacesSchema(query);
  const owner = (await query("SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")).rows[0];
  if (!owner) throw new Error("В базе нет владельца (users.role = 'owner')");
  const report = { owner_id: owner.id, already_enabled: await spacesEnabled(query), memberships_added: 0, general_project: null, moved: {} };

  report.memberships_added = Number((await query(
    "SELECT count(*)::int AS n FROM projects p WHERE NOT EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $1)",
    [owner.id],
  )).rows[0].n);
  const orphans = {};
  for (const table of ["memories", "decision_log", "artifacts"]) {
    orphans[table] = Number((await query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id IS NULL`)).rows[0].n);
  }
  report.moved = orphans;
  if (dryRun) return report;

  await query(
    `INSERT INTO project_memberships(project_id, user_id, role)
     SELECT p.id, $1, 'editor' FROM projects p ON CONFLICT (project_id, user_id) DO NOTHING`,
    [owner.id],
  );
  if (Object.values(orphans).some(Boolean)) {
    let general = await generalProjectId(query, owner.id);
    if (!general) {
      general = (await query(
        `INSERT INTO projects(name, status, stack, git_url, access_level, props) VALUES ($1, 'active', '[]', '', 'private', '{}') RETURNING id::text`,
        [GENERAL_PROJECT],
      )).rows[0].id;
      await addProjectMember(query, general, owner.id);
    }
    report.general_project = general;
    for (const table of Object.keys(orphans)) await query(`UPDATE ${table} SET project_id = $1 WHERE project_id IS NULL`, [general]);
  }
  await query("INSERT INTO mbox_flags(key) VALUES ($1) ON CONFLICT (key) DO NOTHING", [FLAG]);
  resetSpacesCache();
  return report;
}

/** Выключить режим: владелец снова видит всё. Проекты, членства и «Общее» остаются как есть. */
export async function disableSpaces(query) {
  await query("DELETE FROM mbox_flags WHERE key = $1", [FLAG]);
  resetSpacesCache();
}

/**
 * Ручки для владельца в «Настройки → Команда»:
 *   GET  /api/mbox/admin/spaces            — включён ли режим и что изменит включение (пробный прогон)
 *   POST /api/mbox/admin/spaces {enabled}  — включить (миграция) или выключить
 */
export async function handleSpacesApi({ req, res, url, query, readBody, sendJson, user }) {
  if (url.pathname !== "/api/mbox/admin/spaces") return false;
  if (user?.role !== "owner") { sendJson(res, 403, { error: "owner_required" }); return true; }
  if (req.method === "GET") {
    const enabled = await spacesEnabled(query);
    sendJson(res, 200, { enabled, preview: enabled ? null : await migrateToSpaces(query, { dryRun: true }) });
    return true;
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.enabled === false) await disableSpaces(query);
    else await migrateToSpaces(query);
    sendJson(res, 200, { enabled: await spacesEnabled(query), preview: null });
    return true;
  }
  return false;
}
