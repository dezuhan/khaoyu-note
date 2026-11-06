ALTER TABLE projects ADD COLUMN public_sharing_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE project_invitations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX project_invitations_project ON project_invitations(project_id);
CREATE INDEX project_invitations_email ON project_invitations(email);

CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('project', 'item', 'column')),
    target_id TEXT,
    permission TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit', 'manage')),
    token_hash TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    download_allowed INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_accessed_at INTEGER
);
CREATE INDEX share_links_project ON share_links(project_id);
CREATE INDEX share_links_target ON share_links(project_id, target_id);

CREATE TABLE share_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX share_attempts_link ON share_attempts(share_id, ip_hash, created_at);
