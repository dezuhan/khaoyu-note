CREATE TABLE email_jobs (
    id TEXT PRIMARY KEY,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
);
CREATE INDEX email_jobs_due ON email_jobs(sent_at, next_at);
