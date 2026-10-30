-- Where an expense came from: typed/tracked by hand, or imported from a bank/UPI statement.
ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
