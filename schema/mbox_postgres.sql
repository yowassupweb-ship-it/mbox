-- MBOX production schema draft.
-- Designed for PostgreSQL, Docker deployment, full-text indexing, and AI-agent access boundaries.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('memory', 'artifact', 'project', 'todo', 'script', 'agent_scope')),
  access_level TEXT NOT NULL DEFAULT 'private' CHECK (access_level IN ('private', 'agents', 'public')),
  color TEXT NOT NULL DEFAULT '#2c2c2e',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parent_id, name)
);

ALTER TABLE folders ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2c2c2e';

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'memory',
  access_level TEXT NOT NULL DEFAULT 'private' CHECK (access_level IN ('private', 'agents', 'public')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id BIGINT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  representation JSONB NOT NULL DEFAULT '{}',
  dimension INTEGER NOT NULL DEFAULT 0,
  encoding_source TEXT NOT NULL DEFAULT 'tfidf-local-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_links (
  id BIGSERIAL PRIMARY KEY,
  from_memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'related',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS memory_actions (
  id BIGSERIAL PRIMARY KEY,
  memory_id BIGINT REFERENCES memories(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT 'agent',
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_memory_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '') || ' ' || array_to_string(NEW.tags, ' '));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_search_vector ON memories;
CREATE TRIGGER trg_memories_search_vector
BEFORE INSERT OR UPDATE OF title, content, tags
ON memories
FOR EACH ROW
EXECUTE FUNCTION update_memory_search_vector();

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  stack JSONB NOT NULL DEFAULT '[]',
  git_url TEXT NOT NULL DEFAULT '',
  deploy_provider TEXT NOT NULL DEFAULT '',
  deploy_target TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}',
  color TEXT NOT NULL DEFAULT '#2c2c2e',
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  props JSONB NOT NULL DEFAULT '{}',
  color TEXT NOT NULL DEFAULT '#2c2c2e',
  access_level TEXT NOT NULL DEFAULT 'private' CHECK (access_level IN ('private', 'agents', 'public')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS git_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_target TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2c2c2e';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2c2c2e';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'private';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  props JSONB NOT NULL DEFAULT '{}',
  access_level TEXT NOT NULL DEFAULT 'private',
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_until TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS claimed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS claimed_until TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'created',
  content TEXT NOT NULL DEFAULT '',
  dependencies JSONB NOT NULL DEFAULT '[]',
  access_level TEXT NOT NULL DEFAULT 'agents',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id BIGSERIAL PRIMARY KEY,
  from_entity TEXT NOT NULL,
  from_id BIGINT NOT NULL,
  to_entity TEXT NOT NULL,
  to_id BIGINT NOT NULL,
  edge_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  group_entity TEXT NOT NULL DEFAULT '',
  strength DOUBLE PRECISION NOT NULL DEFAULT 1,
  valid_until TIMESTAMPTZ,
  score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS group_entity TEXT NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS strength DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS server_metrics (
  id BIGSERIAL PRIMARY KEY,
  hostname TEXT NOT NULL,
  load_1 DOUBLE PRECISION NOT NULL DEFAULT 0,
  cpu_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  memory_used_mb BIGINT NOT NULL DEFAULT 0,
  memory_total_mb BIGINT NOT NULL DEFAULT 0,
  disk_used_mb BIGINT NOT NULL DEFAULT 0,
  disk_total_mb BIGINT NOT NULL DEFAULT 0,
  docker_containers JSONB NOT NULL DEFAULT '[]',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protected_secrets (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  login TEXT NOT NULL DEFAULT '',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  access_level TEXT NOT NULL DEFAULT 'private' CHECK (access_level IN ('private', 'agents', 'public')),
  agent_share_state TEXT NOT NULL DEFAULT 'locked' CHECK (agent_share_state IN ('locked', 'requested', 'approved', 'expired')),
  approved_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE protected_secrets ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_inbox (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  agent_name TEXT NOT NULL DEFAULT 'agent',
  item_type TEXT NOT NULL DEFAULT 'notice',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  requires_human BOOLEAN NOT NULL DEFAULT false,
  props JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  todo_id BIGINT REFERENCES todos(id) ON DELETE SET NULL,
  agent_name TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'running',
  goal TEXT NOT NULL DEFAULT '',
  read_context JSONB NOT NULL DEFAULT '[]',
  commands JSONB NOT NULL DEFAULT '[]',
  touched_files JSONB NOT NULL DEFAULT '[]',
  result TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS decision_log (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT 'agent',
  title TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS todo_id BIGINT REFERENCES todos(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS todo_id BIGINT REFERENCES todos(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS agent_presence (
  agent_name TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'ai_agent',
  client TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  sessions INTEGER NOT NULL DEFAULT 0,
  props JSONB NOT NULL DEFAULT '{}',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ai_agent';
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS client TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_presence ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_agent_presence_seen ON agent_presence(last_seen DESC);

-- Отметки «просмотрено». Механизм заимствован у Memora (memories_events с флагом consumed),
-- но обобщён на любую сущность MBOX. Живёт в базе, а не в браузере, поэтому непрочитанное
-- одинаково на телефоне и на десктопе. seen_bytes хранит размер на момент просмотра —
-- по нему считается, изменилась ли сущность с тех пор.
-- Расстановка узлов на карте. Карта общая, а не персональная: она отражает реальность проекта,
-- поэтому позиции не привязаны к пользователю. Ключ — тип сущности плюс её id.
CREATE TABLE IF NOT EXISTS graph_positions (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

-- Папки проекта. Раньше folders обслуживали только артефакты, и у проекта не могло быть
-- собственных разделов сверх восьми захардкоженных. project_id делает папку принадлежащей проекту.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id);

CREATE TABLE IF NOT EXISTS seen_marks (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  seen_bytes INTEGER NOT NULL DEFAULT 0,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seen_marks ADD COLUMN IF NOT EXISTS seen_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seen_marks ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_marks_entity ON seen_marks(actor, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_memories_metadata ON memories USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(access_level);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_todo ON memories(todo_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_agent_run ON memories(agent_run_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_updated ON memory_embeddings(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unique ON memory_links(from_memory_id, to_memory_id, link_type);
CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_type ON memory_links(link_type);
CREATE INDEX IF NOT EXISTS idx_memory_actions_memory ON memory_actions(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_actions_actor ON memory_actions(actor, created_at DESC);
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_folder ON artifacts(folder_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_claimed ON todos(claimed_by, claimed_until);
CREATE INDEX IF NOT EXISTS idx_todos_props ON todos USING GIN(props);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_project_title ON todos(project_id, title);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_entity, from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_entity, to_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_group ON graph_edges(group_entity);
CREATE INDEX IF NOT EXISTS idx_companies_props ON companies USING GIN(props);
CREATE INDEX IF NOT EXISTS idx_companies_access ON companies(access_level);
CREATE INDEX IF NOT EXISTS idx_companies_folder ON companies(folder_id);
CREATE INDEX IF NOT EXISTS idx_projects_props ON projects USING GIN(props);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_parent_name_safe ON folders((COALESCE(parent_id, 0)), name);
CREATE INDEX IF NOT EXISTS idx_server_metrics_captured ON server_metrics(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_protected_secrets_state ON protected_secrets(agent_share_state, access_level);
CREATE INDEX IF NOT EXISTS idx_protected_secrets_project ON protected_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_inbox_status ON agent_inbox(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_active ON agent_runs(status, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_project ON decision_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_todo ON decision_log(todo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_agent_run ON decision_log(agent_run_id, created_at DESC);

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

  INSERT INTO audit_events(actor, action, entity_type, entity_id, project_id, summary, metadata)
  VALUES (COALESCE(NULLIF(current_setting('mbox.actor', true), ''), 'system'), lower(TG_OP), TG_TABLE_NAME, entity_id_value, project_id_value, title_value, row_data);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_memories ON memories;
CREATE TRIGGER trg_audit_memories
AFTER INSERT OR UPDATE OR DELETE ON memories
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_folders ON folders;
CREATE TRIGGER trg_audit_folders
AFTER INSERT OR UPDATE OR DELETE ON folders
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_artifacts ON artifacts;
CREATE TRIGGER trg_audit_artifacts
AFTER INSERT OR UPDATE OR DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_projects ON projects;
CREATE TRIGGER trg_audit_projects
AFTER INSERT OR UPDATE OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_companies ON companies;
CREATE TRIGGER trg_audit_companies
AFTER INSERT OR UPDATE OR DELETE ON companies
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_todos ON todos;
CREATE TRIGGER trg_audit_todos
AFTER INSERT OR UPDATE OR DELETE ON todos
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_protected_secrets ON protected_secrets;
CREATE TRIGGER trg_audit_protected_secrets
AFTER INSERT OR UPDATE OR DELETE ON protected_secrets
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_agent_inbox ON agent_inbox;
CREATE TRIGGER trg_audit_agent_inbox
AFTER INSERT OR UPDATE OR DELETE ON agent_inbox
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_agent_runs ON agent_runs;
CREATE TRIGGER trg_audit_agent_runs
AFTER INSERT OR UPDATE OR DELETE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_decision_log ON decision_log;
CREATE TRIGGER trg_audit_decision_log
AFTER INSERT OR UPDATE OR DELETE ON decision_log
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_memory_links ON memory_links;
CREATE TRIGGER trg_audit_memory_links
AFTER INSERT OR UPDATE OR DELETE ON memory_links
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_memory_actions ON memory_actions;
CREATE TRIGGER trg_audit_memory_actions
AFTER INSERT OR UPDATE OR DELETE ON memory_actions
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

INSERT INTO users(email, username, password_hash, role)
SELECT 'admin@mbox.local', 'Admin', crypt('change-me-before-use', gen_salt('bf')), 'owner'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'Admin');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Private', 'agent_scope', 'private'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Private');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Agents', 'agent_scope', 'agents'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Agents');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Projects', 'project', 'private'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Projects');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Artifacts', 'artifact', 'agents'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Artifacts');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Scripts', 'script', 'agents'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Scripts');

INSERT INTO folders(name, entity_type, access_level)
SELECT 'Protected', 'agent_scope', 'private'
WHERE NOT EXISTS (SELECT 1 FROM folders WHERE parent_id IS NULL AND name = 'Protected');

INSERT INTO folders(parent_id, name, entity_type, access_level)
SELECT f.id, child.name, child.entity_type, child.access_level
FROM folders f
CROSS JOIN (
  VALUES
    ('Design', 'artifact', 'agents'),
    ('Code', 'artifact', 'agents'),
    ('Configs', 'artifact', 'agents')
) AS child(name, entity_type, access_level)
WHERE f.parent_id IS NULL
  AND f.name = 'Artifacts'
  AND NOT EXISTS (
    SELECT 1 FROM folders existing
    WHERE existing.parent_id = f.id AND existing.name = child.name
  );
