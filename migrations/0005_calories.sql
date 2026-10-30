-- Calorie tracker: one row per logged meal. day = IST date (YYYY-MM-DD), logged_at = UTC epoch ms.
-- slot: breakfast | lunch | snack | dinner
CREATE TABLE IF NOT EXISTS meals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  slot        TEXT NOT NULL,
  description TEXT NOT NULL,
  kcal        INTEGER NOT NULL,
  protein_g   REAL,
  carbs_g     REAL,
  fat_g       REAL,
  confidence  TEXT,
  logged_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meals_day ON meals (day);
