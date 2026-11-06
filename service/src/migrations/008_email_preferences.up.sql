CREATE TABLE email_preferences (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    notifications INTEGER NOT NULL DEFAULT 0,
    last_notified_at INTEGER,
    updated_at INTEGER NOT NULL
);
