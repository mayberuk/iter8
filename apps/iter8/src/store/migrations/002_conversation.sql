CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  round_id TEXT REFERENCES rounds(id),
  owner_id TEXT REFERENCES owners(id),
  author_json TEXT NOT NULL,
  text TEXT NOT NULL,
  dedupe_key TEXT UNIQUE NOT NULL,
  at TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);

CREATE INDEX messages_page_ordinal ON messages(page_id, ordinal);

CREATE TABLE page_chat (
  page_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);

CREATE TABLE owner_focus (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owners(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  round_id TEXT REFERENCES rounds(id),
  at TEXT NOT NULL
);

INSERT INTO owner_focus (owner_id, page_id, round_id, at)
SELECT owner_id, MAX(id), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM pages WHERE owner_id IS NOT NULL GROUP BY owner_id;
