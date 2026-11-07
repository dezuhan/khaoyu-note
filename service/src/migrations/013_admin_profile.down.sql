DROP INDEX IF EXISTS accounts_username_unique;
ALTER TABLE accounts DROP COLUMN status;
ALTER TABLE accounts DROP COLUMN role;
ALTER TABLE accounts DROP COLUMN avatar_url;
ALTER TABLE accounts DROP COLUMN avatar_color;
ALTER TABLE accounts DROP COLUMN last_name;
ALTER TABLE accounts DROP COLUMN first_name;
ALTER TABLE accounts DROP COLUMN username;
