// Присутствие агентов принадлежит аккаунту: у каждого пользователя свой «Claude»/«ChatGPT» (agent_presence уникальна
// по (owner_user_id, agent_name)). Миграция идемпотентна и применяется при старте сервера — боевая база не обновляется
// init-скриптом, и без неё пинг наблюдателя и список агентов падали бы с 500.

const SQL = [
  "ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS owner_user_id BIGINT",
  "UPDATE agent_presence SET owner_user_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1) WHERE owner_user_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_presence_owner_name ON agent_presence(owner_user_id, agent_name)",
  "ALTER TABLE agent_presence DROP CONSTRAINT IF EXISTS agent_presence_pkey",
];

export async function ensureAgentPresenceSchema(query) {
  for (const sql of SQL) await query(sql);
}
