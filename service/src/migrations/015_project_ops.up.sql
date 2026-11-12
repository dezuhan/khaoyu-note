ALTER TABLE projects ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_snapshots ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_versions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkpoint';

CREATE TABLE project_ops (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    op_id TEXT NOT NULL,
    actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, seq),
    UNIQUE (project_id, op_id)
);
CREATE INDEX project_ops_created ON project_ops(project_id, created_at);
