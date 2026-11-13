CREATE TABLE oauth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX oauth_identities_account ON oauth_identities(account_id);
