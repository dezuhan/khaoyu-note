-- Service accounts gain an operator profile and a global admin role. The oldest account is promoted
-- to admin so an existing deployment has an administrator after the migration.

ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN first_name TEXT;
ALTER TABLE accounts ADD COLUMN last_name TEXT;
ALTER TABLE accounts ADD COLUMN avatar_color TEXT;
ALTER TABLE accounts ADD COLUMN avatar_url TEXT;
ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));

UPDATE accounts
SET role = 'admin'
WHERE id = (
    SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
);

CREATE UNIQUE INDEX accounts_username_unique ON accounts(username COLLATE NOCASE) WHERE username IS NOT NULL;
