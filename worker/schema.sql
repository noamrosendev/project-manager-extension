-- Counts only. There is no column here that could hold a conversation.
CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  rounds_used INTEGER NOT NULL DEFAULT 0,   -- all time
  tokens_used INTEGER NOT NULL DEFAULT 0,   -- all time
  daily_count INTEGER NOT NULL DEFAULT 0,   -- rounds on last_reset
  daily_calls INTEGER NOT NULL DEFAULT 0,   -- model calls on last_reset: the hard per-code ceiling
  last_reset  TEXT NOT NULL DEFAULT '',     -- UTC day, YYYY-MM-DD
  month_key   TEXT NOT NULL DEFAULT '',     -- UTC month of month_microusd, YYYY-MM
  month_microusd INTEGER NOT NULL DEFAULT 0, -- this code's spend that month, in millionths of a dollar
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS budget (
  month       TEXT PRIMARY KEY,             -- UTC month, YYYY-MM
  tokens_used INTEGER NOT NULL DEFAULT 0,
  spent_microusd INTEGER NOT NULL DEFAULT 0,  -- millionths of a dollar, at the configured prices
  notified_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Starts OFF on purpose: the Worker refuses everything until this is set to '0'.
INSERT OR IGNORE INTO settings (key, value) VALUES ('kill_switch', '1');
