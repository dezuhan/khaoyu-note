CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','left')),
  source TEXT NOT NULL DEFAULT 'identity' CHECK (source IN ('identity','invite','link','system')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_members_active_user ON workspace_members(workspace_id, account_id) WHERE state = 'active';
CREATE INDEX workspace_members_user ON workspace_members(account_id, state);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invitee_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  normalized_email TEXT,
  inviter_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  requested_role TEXT NOT NULL DEFAULT 'member' CHECK (requested_role IN ('admin','member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  kind TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email','link')),
  token_hash TEXT,
  expires_at INTEGER,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_invitations_token ON workspace_invitations(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX workspace_invitations_email ON workspace_invitations(workspace_id, normalized_email, status);
CREATE INDEX workspace_invitations_invitee ON workspace_invitations(invitee_account_id, status);

CREATE TABLE workspace_access_policies (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  sharing_enabled INTEGER NOT NULL DEFAULT 1,
  member_default_board_role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (member_default_board_role IN ('none','viewer','commenter','editor')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE projects ADD COLUMN workspace_id TEXT;
UPDATE projects SET workspace_id = 'workspace_default' WHERE workspace_id IS NULL;
CREATE INDEX projects_workspace ON projects(workspace_id, updated_at);

INSERT INTO workspaces (id, name, owner_account_id, created_at, updated_at)
SELECT 'workspace_default', 'Team workspace',
       (SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1),
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_default');

INSERT INTO workspace_access_policies (workspace_id, visibility, sharing_enabled, member_default_board_role, created_at, updated_at)
SELECT 'workspace_default', 'private', 1, 'viewer',
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM workspace_access_policies WHERE workspace_id = 'workspace_default');

INSERT INTO workspace_members (id, workspace_id, account_id, role, state, source, created_at, updated_at)
SELECT 'wm_default_' || a.id, 'workspace_default', a.id,
       CASE WHEN a.role = 'admin' THEN 'admin' ELSE 'member' END,
       'active', 'system',
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM accounts a
WHERE a.deleted_at IS NULL AND a.approved_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = 'workspace_default' AND m.account_id = a.id);
