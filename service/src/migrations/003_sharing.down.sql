DROP TABLE IF EXISTS share_attempts;
DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS project_invitations;

ALTER TABLE projects DROP COLUMN public_sharing_enabled;
