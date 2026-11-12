DROP TABLE IF EXISTS project_ops;
ALTER TABLE project_versions DROP COLUMN kind;
ALTER TABLE project_versions DROP COLUMN last_seq;
ALTER TABLE project_snapshots DROP COLUMN last_seq;
ALTER TABLE projects DROP COLUMN last_seq;
