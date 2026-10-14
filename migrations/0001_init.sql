-- Key/value store: last_inbound_at, short chat history
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- WhatsApp retries webhooks; remember message ids so we never answer twice
CREATE TABLE IF NOT EXISTS seen_messages (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen_messages(ts);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- status: pending | sent | cancelled | missed
-- due_at / created_at / sent_at are UTC epoch milliseconds
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'none',
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at);

CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  amount   REAL NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  note     TEXT,
  spent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_spent ON expenses(spent_at);

-- status: open | done
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
