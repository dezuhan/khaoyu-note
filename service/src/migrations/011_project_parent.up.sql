ALTER TABLE projects ADD COLUMN parent_project_id TEXT REFERENCES projects(id);
CREATE INDEX projects_parent ON projects(parent_project_id);
