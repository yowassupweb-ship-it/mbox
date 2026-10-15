// Журнал изменений (audit_events) по аккаунтам. Раньше событие знало только имя актёра («Claude», «Миша»), и «История»
// показывала владельцу всё подряд, а участнику — события общих проектов, включая чужие сообщения. Теперь триггер пишет
// ещё и user_id из настройки сеанса mbox.user_id (её ставит query() вместе с mbox.actor), а лента отдаёт человеку
// только его события и события его агентов.

const SLIM_FUNCTION = `
CREATE OR REPLACE FUNCTION slim_audit_row(row_data JSONB)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_object_agg(key, CASE
           WHEN jsonb_typeof(value) = 'string' AND length(value #>> '{}') > 600 THEN to_jsonb(left(value #>> '{}', 300) || '…')
           WHEN jsonb_typeof(value) IN ('array', 'object') AND length(value::text) > 4000 THEN to_jsonb('(' || jsonb_typeof(value) || ', ' || length(value::text) || ' байт)')
           ELSE value END), '{}'::jsonb)
    FROM jsonb_each(row_data)
   WHERE key !~* '(cipher|token|secret|password|hash|cookie|api_?key|credential|private_key|embedding|search_vector)'
     AND key NOT IN ('content', 'text_content', 'html', 'tabs', 'data', 'snapshot', 'body_html', 'raw')
$$ LANGUAGE sql IMMUTABLE;
`;

const AUDIT_FUNCTION = `
CREATE OR REPLACE FUNCTION write_audit_event()
RETURNS trigger AS $$
DECLARE
  row_data JSONB;
  entity_id_value BIGINT;
  project_id_value BIGINT;
  title_value TEXT;
  actor_value TEXT;
BEGIN
  IF TG_TABLE_NAME = 'audit_events' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- Секреты (токены, хэши, шифротексты, куки) в журнал не попадают вовсе, тела документов и любые длинные тексты — только
  -- началом: журнал теперь видит все таблицы, и без этого раздувался бы на каждое автосохранение.
  row_data := slim_audit_row(row_data);
  -- Правка, которая ничего не поменяла, кроме отметки времени (или только тяжёлого тела), — не событие.
  IF TG_OP = 'UPDATE' AND (row_data - 'updated_at' - 'heartbeat_at' - 'last_seen' - 'last_used_at') = (slim_audit_row(to_jsonb(OLD)) - 'updated_at' - 'heartbeat_at' - 'last_seen' - 'last_used_at')
     AND TG_TABLE_NAME NOT IN ('documents', 'notes', 'tables', 'presentations', 'design_systems', 'workspace_file_versions') THEN
    RETURN NEW;
  END IF;
  entity_id_value := CASE WHEN row_data->>'id' ~ '^[0-9]{1,18}$' THEN (row_data->>'id')::BIGINT END;
  project_id_value := CASE WHEN row_data->>'project_id' ~ '^[0-9]{1,18}$' THEN (row_data->>'project_id')::BIGINT END;
  title_value := COALESCE(NULLIF(row_data->>'title', ''), NULLIF(row_data->>'name', ''), NULLIF(row_data->>'username', ''), NULLIF(row_data->>'label', ''),
    NULLIF(row_data->>'path', ''), NULLIF(row_data->>'url', ''), TG_TABLE_NAME || ' #' || COALESCE(entity_id_value::TEXT, ''));
  actor_value := COALESCE(NULLIF(current_setting('mbox.actor', true), ''), 'system');

  -- Автосохранение и потоковые обновления — десятки UPDATE за минуты: продолжаем одну запись «изменено», пока правят подряд.
  -- Задачи и решения не склеиваем: смена статуса — отдельное событие (на нём держатся уведомления, server/notifications.mjs).
  IF TG_OP = 'UPDATE' AND entity_id_value IS NOT NULL
     AND TG_TABLE_NAME IN ('documents', 'notes', 'tables', 'presentations', 'design_systems', 'chat_threads', 'agent_inbox', 'agent_runs', 'tour_sheets', 'workspaces', 'browser_bookmarks', 'calendar_events') THEN
    UPDATE audit_events SET created_at = now(), summary = title_value, metadata = row_data
     WHERE id = (SELECT id FROM audit_events
                  WHERE entity_type = TG_TABLE_NAME AND entity_id = entity_id_value AND action = 'update'
                    AND actor = actor_value AND created_at > now() - interval '10 minutes'
                  ORDER BY created_at DESC LIMIT 1);
    IF FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_events(actor, action, entity_type, entity_id, project_id, summary, metadata, user_id)
  VALUES (
    actor_value,
    lower(TG_OP), TG_TABLE_NAME, entity_id_value,
    (SELECT id FROM projects WHERE id = project_id_value),
    title_value, row_data,
    NULLIF(current_setting('mbox.user_id', true), '')::BIGINT
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
`;

/**
 * Журнал видит ВСЕ таблицы MBOX (раньше — только память, задачи, проекты и ещё десяток: правки документов, заметок, таблиц,
 * презентаций, календаря, навыков, Telegram, паролей проходили мимо «Истории»). Исключения — то, что пишется само собой
 * десятками раз в минуту и человеку ничего не говорит, либо целиком состоит из секретов: сессии, куки, метрики, присутствие,
 * снимки и сырые выгрузки SEO, сырые сообщения Telegram, версии заметок (сама заметка в журнале есть).
 */
const NOT_AUDITED = new Set([
  "audit_events", "schema_migrations", "auth_sessions", "oauth_states", "browser_cookies", "browser_history", "server_metrics",
  "agent_presence", "seen_marks", "notification_reads", "memory_embeddings", "graph_positions", "groq_usage", "jarvis_errors",
  "workspace_ops", "google_links", "google_sync_state", "note_versions", "telegram_messages", "telegram_agent_messages",
  "telegram_agent_requests", "calendar_event_runs", "todo_automation_runs", "mbox_flags",
]);
const NOISY_SEO = /^seo_(.*snapshots|page_stats|rank_checks|demand_history|jobs|runs|activity|queries|yandex_pages|urls|page_semantics|serp.*)$/;

async function attachAuditTriggers(query) {
  const tables = (await query(
    `SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (SELECT 1 FROM information_schema.triggers g WHERE g.event_object_table = t.table_name AND g.trigger_name = 'trg_audit_' || t.table_name)`,
  )).rows.map((row) => row.table_name).filter((table) => /^[a-z_][a-z0-9_]*$/.test(table) && !NOT_AUDITED.has(table) && !NOISY_SEO.test(table));
  for (const table of tables) {
    await query(`CREATE TRIGGER trg_audit_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION write_audit_event()`).catch(() => {});
  }
  return tables;
}

export async function ensureAuditScopeSchema(query) {
  await query("ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS user_id BIGINT");
  await query("CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id, created_at DESC)");
  await query("CREATE INDEX IF NOT EXISTS idx_audit_events_entity_time ON audit_events(entity_type, entity_id, created_at DESC)");
  await query(SLIM_FUNCTION);
  await query(AUDIT_FUNCTION);
  await attachAuditTriggers(query);
  // Часть таблиц создают свои модули чуть позже при запуске — подключаемся к ним ещё раз.
  setTimeout(() => { attachAuditTriggers(query).catch(() => {}); }, 15_000).unref?.();
}

/**
 * Условие «это событие человека» для WHERE. Новые события — по user_id. Старые (без user_id) — по признакам:
 * сообщение чата помечено mbox_user_id, человек сам — по логину; остальное старое видит только владелец,
 * кроме явно чужого (чужое сообщение, действие другого человека). $N — номера параметров: me, owner, usernames других.
 */
export function auditVisibility(alias = "audit_events", first = 1) {
  const me = `$${first}`;
  const owner = `$${first + 1}`;
  const myName = `$${first + 2}`;
  const others = `$${first + 3}`;
  const propsUser = `COALESCE(${alias}.metadata->'props'->>'mbox_user_id', ${alias}.metadata->>'owner_user_id')`;
  return `(${alias}.user_id = ${me}::bigint
    OR (${alias}.user_id IS NULL AND (
      ${propsUser} = ${me}::text
      OR ${alias}.actor = ${myName}
      OR (${owner}::boolean AND (${propsUser} IS NULL) AND NOT (${alias}.actor = ANY(${others}::text[])))
    )))`;
}
