CREATE TABLE project_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    doc TEXT NOT NULL,
    created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, revision)
);
CREATE INDEX project_versions_project ON project_versions(project_id, revision DESC);
