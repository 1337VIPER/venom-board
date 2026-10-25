// SQLite storage: one file in DATA_DIR. WAL mode keeps reads fast while the live rooms write.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  inbox TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS verifies (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('leader', 'admin', 'editor', 'viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT COLLATE NOCASE,
  role TEXT NOT NULL,
  invited_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_user ON invites(user_id);
CREATE INDEX IF NOT EXISTS invites_email ON invites(email);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS projects_team ON projects(team_id);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT,
  from_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  card_id TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id, at);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  label TEXT NOT NULL DEFAULT '',
  auto INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL,
  doc BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_project ON versions(project_id, created_at);
CREATE TABLE IF NOT EXISTS share_links (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS previews (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roadmap_previews (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roadmaps (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  show_ideas INTEGER NOT NULL DEFAULT 1,
  show_bugs INTEGER NOT NULL DEFAULT 0,
  show_details INTEGER NOT NULL DEFAULT 1,
  indexable INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS roadmap_votes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, card_id, voter)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_days (day TEXT PRIMARY KEY, sent INTEGER NOT NULL DEFAULT 0);
-- the owner's dashboard: daily totals (visit counts when they're on, and snapshots that turn totals into trends)
CREATE TABLE IF NOT EXISTS stats (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- personal access tokens for MCP clients: only a hash is kept
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);
-- private calendar feed addresses, one per person: the address is made from the server's key and the nonce,
-- so only its hash is kept for looking requests up
CREATE TABLE IF NOT EXISTS calendar_feeds (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
-- players straight to the board: a project's playtest feedback form, its in-game bug reporter key (only a hash is
-- kept), and the bug titles reported lately, so a repeat becomes a comment instead of another card
CREATE TABLE IF NOT EXISTS feedback_links (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  paused INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS report_keys (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS report_titles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title_key TEXT NOT NULL,
  card_id TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  comments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, title_key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS card_search USING fts5(project_id UNINDEXED, card_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
-- a teammate's own role in one project (editors and viewers only; leaders and admins are never overridden).
-- Removing them from the team, or deleting the project, removes it.
CREATE TABLE IF NOT EXISTS project_roles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  set_by TEXT,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (team_id, user_id) REFERENCES members(team_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_roles_member ON project_roles(team_id, user_id);
-- GitHub and GitLab: one webhook address and secret per team, the repositories that have sent to it, and what
-- has been done already (so a delivery sent twice, or a commit pushed to two branches, counts once)
CREATE TABLE IF NOT EXISTS git_hooks (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  hook TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS git_repos (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  last_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, provider, repo)
);
CREATE TABLE IF NOT EXISTS git_seen (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (team_id, key)
);
-- screenshot links (/s/<id>): each one's picture is a file in DATA_DIR/shots, named by its id
CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shots_user ON shots(user_id, created_at);
`;

// columns added after the first release; existing databases get them on start
const ADDED = {
  users: {
    email_verified: 'INTEGER NOT NULL DEFAULT 0', inbox: 'TEXT',
    totp_secret: "TEXT NOT NULL DEFAULT ''", totp_pending: "TEXT NOT NULL DEFAULT ''", totp_last: 'INTEGER NOT NULL DEFAULT 0',
    notify_mentions: 'INTEGER NOT NULL DEFAULT 1', notify_due: 'INTEGER NOT NULL DEFAULT 1', timezone: "TEXT NOT NULL DEFAULT ''", due_mail_day: "TEXT NOT NULL DEFAULT ''",
  },
  teams: { discord_webhook: "TEXT NOT NULL DEFAULT ''", discord_events: "TEXT NOT NULL DEFAULT ''",
    slack_webhook: "TEXT NOT NULL DEFAULT ''", slack_events: "TEXT NOT NULL DEFAULT ''" },
  projects: { doc_bytes: 'INTEGER NOT NULL DEFAULT 0' },  // the stored board's size, counted toward storage
  activity: { by_name: "TEXT NOT NULL DEFAULT ''" },  // who did it when that's a player without an account (feedback, bug reports)
};

function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  const db = new Database(path.join(dataDir, 'venom-board.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  for (const [table, add] of Object.entries(ADDED)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const [col, type] of Object.entries(add)) if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec('UPDATE projects SET doc_bytes = LENGTH(CAST(doc AS BLOB)) WHERE doc_bytes = 0');
  db.exec('CREATE INDEX IF NOT EXISTS users_inbox ON users(inbox)');  // inbox is filled in by the server on start
  return db;
}

module.exports = { openDb };
