-- Team workspace: existing approved accounts can read every board on the server as viewers until an
-- admin grants a stronger per-board role.
INSERT INTO project_members (project_id, account_id, role, created_at)
SELECT p.id, a.id, 'viewer', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM projects p
JOIN accounts a
  ON a.deleted_at IS NULL AND a.status = 'active' AND a.approved_at IS NOT NULL
WHERE p.deleted_at IS NULL
  AND a.id <> p.owner_account_id
  AND NOT EXISTS (
    SELECT 1 FROM project_members m
    WHERE m.project_id = p.id AND m.account_id = a.id
  );
