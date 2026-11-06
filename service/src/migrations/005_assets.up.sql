CREATE TABLE project_assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL REFERENCES objects(id),
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX project_assets_project ON project_assets(project_id, created_at);
