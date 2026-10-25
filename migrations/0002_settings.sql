-- Auth & settings additions.

-- Cross-device login: desktop shows a code, a signed-in phone approves it.
CREATE TABLE device_logins (
  code TEXT PRIMARY KEY,                 -- short human code shown on desktop
  poll_hash TEXT NOT NULL,               -- sha256(secret kept in desktop cookie)
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | used | denied
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Guest authors (and any extra byline authors) linked to a publication.
CREATE TABLE pub_authors (
  pub_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pub_id, user_id)
);

-- Publication transfer: previous owner may keep admin access.
ALTER TABLE transfers ADD COLUMN keep_admin INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transfers ADD COLUMN signed_name TEXT;

CREATE INDEX idx_invites_token ON invites(token_hash);
CREATE INDEX idx_transfers_token ON transfers(token_hash);
CREATE INDEX idx_domains_pub ON domains(pub_id);
CREATE INDEX idx_outbox_pub ON outbox(pub_id, created_at);
CREATE INDEX idx_apikeys_pub ON api_keys(pub_id);
