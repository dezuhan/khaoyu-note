ALTER TABLE accounts ADD COLUMN deletion_requested_at INTEGER;
ALTER TABLE accounts ADD COLUMN deletion_due_at INTEGER;
ALTER TABLE accounts ADD COLUMN totp_secret TEXT;
ALTER TABLE accounts ADD COLUMN totp_enabled_at INTEGER;

ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN csrf_hash TEXT;

CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    replaced_by TEXT,
    revoked_at INTEGER
);
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);

CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX access_tokens_session ON access_tokens(session_id);
CREATE INDEX access_tokens_expires ON access_tokens(expires_at);

CREATE TABLE email_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_account ON email_tokens(account_id, kind);

CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_email ON login_attempts(email_hash, created_at);
CREATE INDEX login_attempts_ip ON login_attempts(ip_hash, created_at);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX api_tokens_account ON api_tokens(account_id);
