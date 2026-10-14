// Компании и проекты внутри них.
//
// Раньше проект привязывался к компании ребром графа (graph_edges company→project, edge_type=owns), а интерфейс
// рисовал компанию подписью над списком. Из-за этого компания жила «двумя сущностями»: отдельной записью companies и
// проектом-контейнером с тем же именем. Теперь принадлежность — поле projects.company_id (одна компания у проекта),
// а ребро owns остаётся только для совместимости со старыми агентами: при старте оно один раз переносится в поле.
//
// Подключено и в прод-сервер, и в dev-API vite.config.ts. Править компании (создать, изменить, удалить) может только
// владелец инстанса; участник видит компании, в которых есть его проекты.


export async function ensureCompaniesSchema(query) {
  await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id)`);
  // Перенос старых связей owns → company_id: только там, где поле ещё пустое, поэтому повторный запуск ничего не меняет.
  await query(
    `UPDATE projects p SET company_id = e.from_id
     FROM graph_edges e
     WHERE e.from_entity = 'company' AND e.to_entity = 'project' AND e.edge_type = 'owns'
       AND e.to_id = p.id AND p.company_id IS NULL
       AND EXISTS (SELECT 1 FROM companies c WHERE c.id = e.from_id)`,
  );
}

const COMPANY_COLUMNS = `c.id::text, c.folder_id::text, c.name, c.status, c.props, c.color, c.access_level,
  pg_column_size(c)::int AS memory_bytes, c.created_at::text, c.updated_at::text`;

function cleanColor(value) {
  const color = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "";
}

/** Задать компанию проекта из тела запроса: company_id есть — пишем (пустое = без компании), нет — не трогаем. */
export async function applyProjectCompany(query, projectId, body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "company_id")) return;
  const value = body.company_id === null || body.company_id === "" ? null : String(body.company_id);
  if (value !== null && !/^\d+$/.test(value)) return;
  await query("UPDATE projects SET company_id = $1, updated_at = now() WHERE id = $2", [value, projectId]);
}

async function listCompanies(query, scope, q, isOwner) {
  // Владелец видит все компании, даже пустые (новая компания ещё без проектов); участник — только с его проектами.
  const all = Boolean(scope?.all || isOwner);
  const companies = await query(
    `SELECT ${COMPANY_COLUMNS}
     FROM companies c
     WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.props::text ILIKE '%' || $1 || '%')
       AND ($2::boolean OR EXISTS (SELECT 1 FROM projects p WHERE p.company_id = c.id AND p.id = ANY($3::bigint[])))
     ORDER BY lower(c.name)
     LIMIT 200`,
    [q, all, scope?.projectIds || []],
  );
  const projects = await query(
    `SELECT p.id::text AS project_id, p.name AS project_name, p.company_id::text AS company_id, p.status
     FROM projects p
     WHERE p.company_id IS NOT NULL AND ($1::boolean OR p.id = ANY($2::bigint[]))`,
    [Boolean(scope?.all), scope?.projectIds || []],
  );
  return companies.rows.map((company) => ({
    ...company,
    // Прежняя форма связей (как от graph_edges) — её читают MCP list_companies и старые экраны.
    projects: projects.rows
      .filter((row) => row.company_id === company.id)
      .map((row) => ({ id: `p${row.project_id}`, company_id: company.id, company_name: company.name, project_id: row.project_id, project_name: row.project_name, edge_type: "owns", status: row.status })),
  }));
}

/**
 * Ручки компаний. Возвращает true, если запрос обработан.
 *   GET    /api/mbox/companies            — список (с проектами)
 *   POST   /api/mbox/companies            — создать
 *   PATCH  /api/mbox/companies/:id        — изменить (name, status, color, props — props целиком)
 *   DELETE /api/mbox/companies/:id        — удалить; проекты остаются, становятся «без компании»
 *   POST   /api/mbox/companies/:id/absorb — проект-двойник компании: свойства → компании, задачи → другой проект, двойник в архив
 */
export async function handleCompaniesApi({ req, res, url, query, readBody, sendJson, scope, isOwner, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/companies")) return false;
  const q = String(url.searchParams.get("q") || "").trim();

  if (url.pathname === "/api/mbox/companies") {
    if (req.method === "GET") {
      sendJson(res, 200, { companies: await listCompanies(query, scope, q, isOwner) });
      return true;
    }
    if (req.method === "POST") {
      if (!isOwner) { sendJson(res, 403, { error: "owner_only" }); return true; }
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 200);
      if (!name) { sendJson(res, 400, { error: "name_required" }); return true; }
      try {
        const result = await query(
          `INSERT INTO companies(name, status, props, color, access_level)
           VALUES ($1, 'active', $2, $3, COALESCE(NULLIF($4, ''), 'agents'))
           RETURNING id::text, name`,
          [name, JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), cleanColor(body.color) || "#8e8e93", String(body.access_level || "")],
        );
        broadcast?.("create", "companies", name);
        sendJson(res, 201, { company: result.rows[0] });
      } catch (error) {
        if (String(error?.code) === "23505") sendJson(res, 409, { error: "company_exists" });
        else throw error;
      }
      return true;
    }
    return false;
  }

  const match = url.pathname.match(/^\/api\/mbox\/companies\/(\d+)(\/absorb)?$/);
  if (!match) return false;
  const id = match[1];
  if (!isOwner) { sendJson(res, 403, { error: "owner_only" }); return true; }

  if (match[2] && req.method === "POST") {
    const body = await readBody(req);
    const projectId = String(body.project_id || "");
    const moveTo = body.move_todos_to ? String(body.move_todos_to) : "";
    if (!/^\d+$/.test(projectId)) { sendJson(res, 400, { error: "project_id_required" }); return true; }
    const company = (await query("SELECT props FROM companies WHERE id = $1", [id])).rows[0];
    const project = (await query("SELECT id, props, (SELECT count(*)::int FROM todos t WHERE t.project_id = projects.id) AS todos FROM projects WHERE id = $1", [projectId])).rows[0];
    if (!company || !project) { sendJson(res, 404, { error: "not_found" }); return true; }
    if (project.todos > 0 && !/^\d+$/.test(moveTo)) { sendJson(res, 400, { error: "move_todos_to_required" }); return true; }
    // Свойства двойника дополняют компанию; служебные ключи проекта (порядок, разделы) не переносим.
    const skip = new Set(["position", "enabled_entities", "entity_kind", "type", "role"]);
    const merged = { ...(company.props || {}) };
    for (const [key, value] of Object.entries(project.props || {})) if (!skip.has(key) && merged[key] === undefined) merged[key] = value;
    await query("UPDATE companies SET props = $1, updated_at = now() WHERE id = $2", [JSON.stringify(merged), id]);
    if (project.todos > 0) await query("UPDATE todos SET project_id = $1, updated_at = now() WHERE project_id = $2", [moveTo, projectId]);
    await query("UPDATE projects SET status = 'archived', company_id = $1, updated_at = now() WHERE id = $2", [id, projectId]);
    broadcast?.("update", "companies", `#${id}`);
    broadcast?.("update", "projects", `#${projectId}`);
    sendJson(res, 200, { ok: true, moved_todos: project.todos });
    return true;
  }

  if (req.method === "PATCH") {
    const body = await readBody(req);
    const color = cleanColor(body.color);
    if (body.color && !color) { sendJson(res, 400, { error: "invalid_color" }); return true; }
    try {
      const result = await query(
        `UPDATE companies
         SET name = COALESCE(NULLIF($1, ''), name),
             status = COALESCE(NULLIF($2, ''), status),
             props = COALESCE($3::jsonb, props),
             color = COALESCE(NULLIF($4, ''), color),
             access_level = COALESCE(NULLIF($5, ''), access_level),
             updated_at = now()
         WHERE id = $6
         RETURNING id::text, name`,
        [String(body.name || "").trim().slice(0, 200), String(body.status || ""), body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, color, String(body.access_level || ""), id],
      );
      if (!result.rows[0]) { sendJson(res, 404, { error: "not_found" }); return true; }
      broadcast?.("update", "companies", result.rows[0].name);
      sendJson(res, 200, { company: result.rows[0] });
    } catch (error) {
      if (String(error?.code) === "23505") sendJson(res, 409, { error: "company_exists" });
      else throw error;
    }
    return true;
  }

  if (req.method === "DELETE") {
    await query("DELETE FROM graph_edges WHERE (from_entity = 'company' AND from_id = $1) OR (to_entity = 'company' AND to_id = $1)", [id]);
    await query("DELETE FROM companies WHERE id = $1", [id]);
    broadcast?.("delete", "companies", `#${id}`);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
