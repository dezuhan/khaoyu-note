CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE INDEX recovery_codes_account ON recovery_codes(account_id, used_at);
