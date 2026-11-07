CREATE TABLE passkey_credentials (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT 'Passkey',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX passkey_credentials_account ON passkey_credentials(account_id);

CREATE TABLE passkey_challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX passkey_challenges_email ON passkey_challenges(email, kind, created_at);
