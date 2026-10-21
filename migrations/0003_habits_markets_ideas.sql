-- Habits and one row per day each habit was done (day = IST date, YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS habit_logs (
  habit_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (habit_id, day)
);

-- Price alerts. symbol is a Yahoo ticker (RELIANCE.NS) or "mf:<schemeCode>".
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  label TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  level REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  triggered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches (active, symbol);

-- Work ideas: standup notes, LinkedIn post ideas, anything else worth keeping.
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_kind ON ideas (kind, created_at);
