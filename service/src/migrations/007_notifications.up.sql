CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
);
CREATE INDEX notifications_account ON notifications(account_id, created_at DESC);
CREATE INDEX notifications_resource ON notifications(resource_type, resource_id);
