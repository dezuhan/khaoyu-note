-- Account approval and the private/public registration policy. Existing accounts stay approved;
-- new accounts are pending until an admin approves them while the policy is private.
ALTER TABLE accounts ADD COLUMN approved_at INTEGER;
UPDATE accounts SET approved_at = COALESCE(created_at, updated_at) WHERE approved_at IS NULL;
