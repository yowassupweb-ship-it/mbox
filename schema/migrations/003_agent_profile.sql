CREATE TABLE IF NOT EXISTS agent_profile (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'global',
  scope_ref TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'preference',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  source TEXT NOT NULL DEFAULT 'inferred',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_by TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profile_unique_text ON agent_profile(owner_user_id, scope_kind, scope_ref, md5(lower(text)));
CREATE INDEX IF NOT EXISTS idx_agent_profile_owner_status ON agent_profile(owner_user_id, status);
