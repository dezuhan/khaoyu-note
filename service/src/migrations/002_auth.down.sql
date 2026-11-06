DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS email_tokens;
DROP TABLE IF EXISTS access_tokens;
DROP TABLE IF EXISTS refresh_tokens;

ALTER TABLE sessions DROP COLUMN csrf_hash;
ALTER TABLE sessions DROP COLUMN user_agent;
ALTER TABLE sessions DROP COLUMN ip_hash;

ALTER TABLE accounts DROP COLUMN totp_enabled_at;
ALTER TABLE accounts DROP COLUMN totp_secret;
ALTER TABLE accounts DROP COLUMN deletion_due_at;
ALTER TABLE accounts DROP COLUMN deletion_requested_at;
