CREATE TABLE IF NOT EXISTS usage_tracking (
  userId TEXT NOT NULL,
  month TEXT NOT NULL,
  messagesUsed INTEGER DEFAULT 0,
  translationsUsed INTEGER DEFAULT 0,
  lastSyncCount INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (userId, month)
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_tracking(userId);
