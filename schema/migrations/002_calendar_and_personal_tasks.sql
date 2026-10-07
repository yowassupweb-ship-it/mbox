CREATE TABLE IF NOT EXISTS personal_tasks (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMP,
  recurrence_rule TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_owner_due ON personal_tasks(owner_user_id, due_at);

CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMP NOT NULL,
  ends_at TIMESTAMP NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  location TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'blue',
  reminder_minutes INTEGER,
  recurrence_rule TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_range ON calendar_events(owner_user_id, starts_at, ends_at);
