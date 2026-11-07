DROP INDEX IF EXISTS projects_parent;
ALTER TABLE projects DROP COLUMN parent_project_id;
