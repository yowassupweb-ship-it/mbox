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

ALTER TABLE projects ADD COLUMN IF NOT EXISTS git_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_target TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2c2c2e';

CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  props JSONB NOT NULL DEFAULT '{}',
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGSERIAL PRIMARY KEY,
  folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
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
  score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_memories_metadata ON memories USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(access_level);
CREATE INDEX IF NOT EXISTS idx_artifacts_folder ON artifacts(folder_id);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_props ON todos USING GIN(props);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_project_title ON todos(project_id, title);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_entity, from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_entity, to_id);
CREATE INDEX IF NOT EXISTS idx_projects_props ON projects USING GIN(props);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_parent_name_safe ON folders((COALESCE(parent_id, 0)), name);
CREATE INDEX IF NOT EXISTS idx_server_metrics_captured ON server_metrics(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_protected_secrets_state ON protected_secrets(agent_share_state, access_level);
CREATE INDEX IF NOT EXISTS idx_protected_secrets_project ON protected_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);

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
  VALUES ('system', lower(TG_OP), TG_TABLE_NAME, entity_id_value, project_id_value, title_value, row_data);

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

DROP TRIGGER IF EXISTS trg_audit_todos ON todos;
CREATE TRIGGER trg_audit_todos
AFTER INSERT OR UPDATE OR DELETE ON todos
FOR EACH ROW EXECUTE FUNCTION write_audit_event();

DROP TRIGGER IF EXISTS trg_audit_protected_secrets ON protected_secrets;
CREATE TRIGGER trg_audit_protected_secrets
AFTER INSERT OR UPDATE OR DELETE ON protected_secrets
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
