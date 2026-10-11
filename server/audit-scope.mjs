// Журнал изменений (audit_events) по аккаунтам. Раньше событие знало только имя актёра («Claude», «Миша»), и «История»
// показывала владельцу всё подряд, а участнику — события общих проектов, включая чужие сообщения. Теперь триггер пишет
// ещё и user_id из настройки сеанса mbox.user_id (её ставит query() вместе с mbox.actor), а лента отдаёт человеку
// только его события и события его агентов.

const AUDIT_FUNCTION = `
CREATE OR REPLACE FUNCTION write_audit_event()
RETURNS trigger AS $$
DECLARE
  row_data JSONB;
  entity_id_value BIGINT;
  project_id_value BIGINT;
  title_value TEXT;
BEGIN
  IF TG_TABLE_NAME = 'audit_events' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  entity_id_value := NULLIF(row_data->>'id', '')::BIGINT;
  project_id_value := NULLIF(row_data->>'project_id', '')::BIGINT;
  title_value := COALESCE(row_data->>'title', row_data->>'name', TG_TABLE_NAME || ' #' || COALESCE(entity_id_value::TEXT, ''));

  INSERT INTO audit_events(actor, action, entity_type, entity_id, project_id, summary, metadata, user_id)
  VALUES (
    COALESCE(NULLIF(current_setting('mbox.actor', true), ''), 'system'),
    lower(TG_OP), TG_TABLE_NAME, entity_id_value,
    (SELECT id FROM projects WHERE id = project_id_value),
    title_value, row_data,
    NULLIF(current_setting('mbox.user_id', true), '')::BIGINT
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
`;

export async function ensureAuditScopeSchema(query) {
  await query("ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS user_id BIGINT");
  await query("CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id, created_at DESC)");
  await query(AUDIT_FUNCTION);
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
