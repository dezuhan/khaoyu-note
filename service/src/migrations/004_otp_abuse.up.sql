CREATE TABLE email_otps (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_otps_account ON email_otps(account_id, created_at);

CREATE TABLE abuse_reports (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    reporter_ip_hash TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX abuse_reports_share ON abuse_reports(share_id);
