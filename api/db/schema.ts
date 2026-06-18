export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bind_code TEXT,
  bind_code_expires_at TEXT,
  device_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  activated INTEGER NOT NULL DEFAULT 1,
  connection_allowed INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0,
  dev_tool TEXT,
  capabilities TEXT,
  last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS tool_statuses (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  UNIQUE(device_id, tool_name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  repo_url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  merge_commit_sha TEXT,
  merge_conflict TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);

CREATE TABLE IF NOT EXISTS sub_tasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  branch_name TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_tasks_task_id ON sub_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_sub_tasks_device_id ON sub_tasks(device_id);

CREATE TABLE IF NOT EXISTS log_entries (
  id TEXT PRIMARY KEY,
  sub_task_id TEXT NOT NULL REFERENCES sub_tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  timestamp TEXT NOT NULL,
  device_id TEXT,
  task_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_entries_sub_task_id ON log_entries(sub_task_id);

CREATE TABLE IF NOT EXISTS collab_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  repo_url TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_collab_sessions_user_id ON collab_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_device_id ON collab_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_task_id ON collab_sessions(task_id);

CREATE TABLE IF NOT EXISTS collab_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES collab_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  task_id TEXT,
  sub_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collab_messages_session_id ON collab_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_messages_sub_task_id ON collab_messages(sub_task_id);

CREATE TABLE IF NOT EXISTS remote_commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  shell TEXT NOT NULL DEFAULT 'powershell',
  script TEXT NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  error TEXT,
  logs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_remote_commands_user_id
  ON remote_commands(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_commands_device_id
  ON remote_commands(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_commands_status
  ON remote_commands(status);

CREATE TABLE IF NOT EXISTS mod_pack_installations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_mod_pack_installations_user_id ON mod_pack_installations(user_id);

CREATE TABLE IF NOT EXISTS mod_permission_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, pack_id, mod_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_mod_permission_grants_pack
  ON mod_permission_grants(user_id, pack_id);

CREATE TABLE IF NOT EXISTS mod_acceptance_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  check_results TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_acceptance_runs_pack
  ON mod_acceptance_runs(user_id, pack_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
