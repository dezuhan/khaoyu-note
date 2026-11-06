CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    email_verified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    family_id TEXT NOT NULL,
    device_label TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_family ON sessions(family_id);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    sync_enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX projects_owner ON projects(owner_account_id);

CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, account_id)
);
CREATE INDEX project_members_account ON project_members(account_id);

CREATE TABLE project_snapshots (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    doc TEXT NOT NULL,
    updated_by TEXT REFERENCES accounts(id),
    updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    ip_hash TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_created ON audit_log(created_at);
CREATE INDEX audit_log_resource ON audit_log(resource_type, resource_id);

CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE service_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
