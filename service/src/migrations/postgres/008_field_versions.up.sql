ALTER TABLE project_ops ADD COLUMN clock TEXT;

CREATE TABLE project_field_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  field TEXT NOT NULL,
  seq BIGINT NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  clock TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, card_id, field)
);
CREATE INDEX project_field_versions_project ON project_field_versions(project_id, seq);
