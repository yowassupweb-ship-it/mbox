// Персональный слой агента: короткие факты о том, как человек работает, которые агенты читают в начале работы.
// Агент предлагает (status=proposed), человек подтверждает; явные «запомни» от человека активны сразу.
// Факт про права, роли, секреты и доступ не принимается вовсе (заметка #69, §6).

export const PROFILE_SCOPES = ["global", "project", "skill"];
export const PROFILE_KINDS = ["preference", "correction", "workflow"];
export const PROFILE_STATUSES = ["proposed", "active", "rejected", "archived"];
export const PROFILE_TEXT_MIN = 3;
export const PROFILE_TEXT_MAX = 300;
export const PROFILE_CONTEXT_LIMIT = 15;
export const PROFILE_STALE_DAYS = 60;

const FORBIDDEN = /парол|секрет|токен|api[-_ ]?key|права доступа|прав[аое]? (?:админ|владельц)|роль|роли|доступ к проект|лимит|permission|\brole\b|\bsecret|password|\btoken/i;

export function checkProfileText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length < PROFILE_TEXT_MIN) return { error: "text_too_short" };
  if (text.length > PROFILE_TEXT_MAX) return { error: "text_too_long" };
  if (FORBIDDEN.test(text)) return { error: "forbidden_topic" };
  return { text };
}

export function normalizeProfileInput(body, { isAgent }) {
  const checked = checkProfileText(body?.text);
  if (checked.error) return checked;
  const scopeKind = PROFILE_SCOPES.includes(body?.scope_kind) ? body.scope_kind : "global";
  const scopeRef = scopeKind === "global" ? "" : String(body?.scope_ref ?? "").trim().slice(0, 120);
  if (scopeKind !== "global" && !scopeRef) return { error: "scope_ref_required" };
  const kind = PROFILE_KINDS.includes(body?.kind) ? body.kind : "preference";
  // Явная просьба человека активна сразу; всё, что агент вывел сам, ждёт подтверждения.
  const explicit = body?.source === "explicit";
  const evidence = Array.isArray(body?.evidence) ? body.evidence.slice(0, 10).map((item) => String(item).slice(0, 200)) : [];
  if (isAgent && explicit && !evidence.length) return { error: "evidence_required_for_explicit" };
  return { value: { text: checked.text, scopeKind, scopeRef, kind, source: explicit ? "explicit" : "inferred", status: explicit ? "active" : "proposed", evidence } };
}

// Что показать агенту: активные факты, общие + для проекта/навыка задачи, свежие и часто применяемые выше.
export function selectProfileForContext(rows, { projectId = "", skill = "", limit = PROFILE_CONTEXT_LIMIT, now = Date.now() } = {}) {
  const staleBefore = now - PROFILE_STALE_DAYS * 86400000;
  return rows
    .filter((row) => row.status === "active")
    .filter((row) => row.scope_kind === "global"
      || (row.scope_kind === "project" && projectId && row.scope_ref === String(projectId))
      || (row.scope_kind === "skill" && skill && row.scope_ref === skill))
    .filter((row) => {
      const touched = Date.parse(row.last_used_at || row.updated_at || row.created_at || "") || now;
      return touched >= staleBefore || row.source === "explicit";
    })
    .sort((a, b) => (b.scope_kind !== "global") - (a.scope_kind !== "global")
      || (b.uses || 0) - (a.uses || 0)
      || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, limit)
    .map((row) => ({ id: row.id, text: row.text, kind: row.kind, scope: row.scope_kind === "global" ? "global" : `${row.scope_kind}:${row.scope_ref}` }));
}

const SELECT = "id::text, scope_kind, scope_ref, kind, text, status, source, evidence, proposed_by, uses, last_used_at::text, created_at::text, updated_at::text";

export async function loadActiveProfile(query, userId) {
  const result = await query(`SELECT ${SELECT} FROM agent_profile WHERE owner_user_id = $1 AND status = 'active'`, [String(userId)]);
  return result.rows;
}

// Применение считаем при выдаче контекста, чтобы архивация по неиспользованию работала.
export async function markProfileUsed(query, ids) {
  if (!ids.length) return;
  await query("UPDATE agent_profile SET uses = uses + 1, last_used_at = now() WHERE id = ANY($1::bigint[])", [ids]);
}

export async function handleAgentProfileApi({ req, res, url, query, readBody, sendJson, scope, broadcast }) {
  const match = url.pathname.match(/^\/api\/mbox\/agent\/profile(?:\/(\d+))?$/);
  if (!match) return false;
  const userId = String(scope?.userId || "");
  if (!userId) return false;
  const id = match[1];
  const isAgent = Boolean(req.headers["x-mbox-agent"] || req.headers["x-agent-name"]);
  const actor = isAgent ? String(req.headers["x-mbox-agent"] || req.headers["x-agent-name"]) : "Человек";

  if (req.method === "GET" && !id) {
    const status = String(url.searchParams.get("status") || "");
    const rows = (await query(
      `SELECT ${SELECT} FROM agent_profile WHERE owner_user_id = $1 AND ($2 = '' OR status = $2) ORDER BY CASE status WHEN 'proposed' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, updated_at DESC LIMIT 200`,
      [userId, PROFILE_STATUSES.includes(status) ? status : ""],
    )).rows;
    return sendJson(res, 200, { facts: rows });
  }

  if (req.method === "POST" && !id) {
    const parsed = normalizeProfileInput(await readBody(req), { isAgent });
    if (parsed.error) return sendJson(res, 422, { error: parsed.error });
    const v = parsed.value;
    const inserted = (await query(
      `INSERT INTO agent_profile(owner_user_id, scope_kind, scope_ref, kind, text, status, source, evidence, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (owner_user_id, scope_kind, scope_ref, md5(lower(text))) DO NOTHING
       RETURNING ${SELECT}`,
      [userId, v.scopeKind, v.scopeRef, v.kind, v.text, v.status, v.source, JSON.stringify(v.evidence), actor],
    )).rows[0];
    if (!inserted) return sendJson(res, 200, { duplicate: true });
    broadcast?.("entity_changed", { entity: "agent_profile", silent: true });
    return sendJson(res, 201, { fact: inserted });
  }

  if (req.method === "PATCH" && id) {
    const body = await readBody(req);
    // Подтверждать, отклонять и править факт может только человек: иначе агент сам себя «обучит».
    if (isAgent) return sendJson(res, 403, { error: "human_confirmation_required" });
    const status = body?.status === undefined ? null : String(body.status);
    if (status !== null && !PROFILE_STATUSES.includes(status)) return sendJson(res, 400, { error: "bad_status" });
    let text = null;
    if (body?.text !== undefined) {
      const checked = checkProfileText(body.text);
      if (checked.error) return sendJson(res, 422, { error: checked.error });
      text = checked.text;
    }
    const row = (await query(
      `UPDATE agent_profile SET status = COALESCE($1, status), text = COALESCE($2, text), updated_at = now()
       WHERE id = $3 AND owner_user_id = $4 RETURNING ${SELECT}`,
      [status, text, id, userId],
    )).rows[0];
    if (!row) return sendJson(res, 404, { error: "not_found" });
    broadcast?.("entity_changed", { entity: "agent_profile", silent: true });
    return sendJson(res, 200, { fact: row });
  }

  if (req.method === "DELETE" && id) {
    if (isAgent) return sendJson(res, 403, { error: "human_confirmation_required" });
    await query("DELETE FROM agent_profile WHERE id = $1 AND owner_user_id = $2", [id, userId]);
    broadcast?.("entity_changed", { entity: "agent_profile", silent: true });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: "method_not_allowed" });
}
