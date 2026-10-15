// «История»: журнал изменений (audit_events) страницами и по дням. Раньше лента отдавала последние 200 событий одним куском —
// дальше листать было нельзя. Теперь:
//   GET /api/mbox/history?before=<время>&limit=&q=&actor=&mode=important   страница событий старше before (по убыванию)
//   GET /api/mbox/history/days?tz=&q=&actor=&mode=                            дни с событиями и их число — для боковой панели
// Кто что видит, решает вызывающий (scope): на сервере — auditVisibility (свои события и события своих агентов),
// в dev — проекты сессии.

/** Служебные записи: их много, и человеку они почти ничего не говорят — видны только в режиме «Всё». */
export const SERVICE_ENTITIES = ["memory_actions", "agent_runs", "agent_presence", "server_metrics", "workspace_ops", "llm_usage", "chat_threads", "skill_settings", "item_icons", "integration_installs"];

const MAX_LIMIT = 500;

function filters(url, scope, first) {
  const params = [...scope.params];
  const where = [scope.sql];
  const add = (value) => { params.push(value); return `$${first + params.length - 1}`; };
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 200);
  if (q) {
    const p = add(q);
    where.push(`(e.actor ILIKE '%' || ${p} || '%' OR e.entity_type ILIKE '%' || ${p} || '%' OR e.summary ILIKE '%' || ${p} || '%')`);
  }
  const actor = String(url.searchParams.get("actor") || "").trim().slice(0, 100);
  if (actor) where.push(`COALESCE(NULLIF(e.actor, ''), 'system') = ${add(actor)}`);
  if (url.searchParams.get("mode") === "important") where.push(`NOT (e.entity_type = ANY(${add(SERVICE_ENTITIES)}::text[]))`);
  return { where, params, add };
}

/**
 * scope(first) → { sql, params }: условие видимости над алиасом e, параметры нумеруются с $first.
 * Возвращает true, если запрос обработан.
 */
export async function handleHistoryApi({ url, query, sendJson, res, scope }) {
  if (url.pathname === "/api/mbox/history") {
    const { where, params, add } = filters(url, scope(1), 1);
    const before = url.searchParams.get("before");
    const beforeId = String(url.searchParams.get("before_id") || "");
    // Курсор — время и номер последнего показанного события: у событий одной транзакции время совпадает, и по одному времени
    // граница страницы теряла бы их.
    if (before && !Number.isNaN(Date.parse(before))) {
      where.push(/^\d{1,18}$/.test(beforeId) ? `(e.created_at, e.id) < (${add(before)}::timestamptz, ${add(beforeId)}::bigint)` : `e.created_at < ${add(before)}::timestamptz`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const rows = (await query(
      `SELECT e.id::text, e.actor, e.action, e.entity_type, e.entity_id::text, e.project_id::text, e.summary, e.metadata,
              pg_column_size(e)::int AS memory_bytes, e.created_at::text
         FROM audit_events e
        WHERE ${where.join(" AND ")}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ${add(limit + 1)}`,
      params,
    )).rows;
    sendJson(res, 200, { events: rows.slice(0, limit), more: rows.length > limit });
    return true;
  }
  if (url.pathname === "/api/mbox/history/days") {
    const { where, params, add } = filters(url, scope(1), 1);
    const tz = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/.test(url.searchParams.get("tz") || "") ? url.searchParams.get("tz") : "Europe/Moscow";
    const zone = add(tz);
    const rows = (await query(
      `SELECT to_char(e.created_at AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day, count(*)::int AS count,
              array_agg(DISTINCT COALESCE(NULLIF(e.actor, ''), 'system')) AS actors
         FROM audit_events e
        WHERE ${where.join(" AND ")}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 1000`,
      params,
    )).rows;
    sendJson(res, 200, { days: rows, tz });
    return true;
  }
  return false;
}
