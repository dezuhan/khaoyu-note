DROP INDEX IF EXISTS projects_workspace;
ALTER TABLE projects DROP COLUMN workspace_id;
DROP TABLE IF EXISTS workspace_access_policies;
DROP TABLE IF EXISTS workspace_invitations;
DROP INDEX IF EXISTS workspace_members_active_user;
DROP INDEX IF EXISTS workspace_members_user;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
