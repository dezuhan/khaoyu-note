ALTER TABLE accounts ADD COLUMN approved_at BIGINT;
UPDATE accounts SET approved_at = COALESCE(created_at, updated_at) WHERE approved_at IS NULL;
