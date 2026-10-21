-- Smart memory: one embedding per note / journal entry / idea / contact (int8-quantised unit vector, base64).
CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);

-- People the owner told the bot about. facts = one fact per line.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  facts TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- LinkedIn post factory. status: scheduled | sent | posted | cancelled
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER,
  text TEXT NOT NULL,
  scheduled_at INTEGER,
  reminder_id INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_reminder ON posts (reminder_id);
CREATE INDEX IF NOT EXISTS idx_posts_idea ON posts (idea_id);
