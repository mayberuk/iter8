CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE owners (
  id TEXT PRIMARY KEY NOT NULL,
  agent TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  label TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  relabel_pending INTEGER NOT NULL,
  busy INTEGER NOT NULL,
  gone_reason TEXT,
  UNIQUE (pid, started_at)
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  project_root TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('server', 'folder')),
  target TEXT NOT NULL,
  port INTEGER NOT NULL,
  owner_id TEXT REFERENCES owners(id),
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_root, target_kind, target)
);

CREATE TABLE page_upstreams (
  page_id TEXT NOT NULL REFERENCES pages(id),
  upstream TEXT NOT NULL,
  port INTEGER NOT NULL,
  PRIMARY KEY (page_id, port)
);

CREATE TABLE retired_labels (
  id TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  owner_id TEXT REFERENCES owners(id),
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  round_id TEXT REFERENCES rounds(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft', 'sent', 'agent')),
  ordinal INTEGER NOT NULL,
  author_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  body TEXT NOT NULL,
  target_json TEXT NOT NULL,
  anchor_status TEXT NOT NULL,
  capture_json TEXT,
  resolution_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE round_keys (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  round_id TEXT NOT NULL REFERENCES rounds(id)
);

CREATE TABLE announcements (
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL,
  round_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (owner_id, label, round_id)
);

CREATE TABLE screenshots (
  ref TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  png BLOB NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE prefs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  prefs_json TEXT NOT NULL
);
